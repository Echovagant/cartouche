/**
 * `vector.spatialJoin`：按空间位置连接，把源图层的属性汇总写回目标图层。
 *
 * 这一层是「几何与算法」（`src/engine/spatial/join.ts`，纯函数）与「矢量读写」
 * （`src/engine/vector/*`，管文件）之间的桥 —— 两边各自独立做完，这里把它们接上。
 *
 * 为什么单独一层：空间连接的**判定**（点在不在面里、面有没有相交）是纯几何，
 * 不该沾文件；**读与写**是另一件事，也不该沾几何。
 * 混在一起两头都难测：几何要造临时文件才能测，文件要造几何才能测。
 */
import { spatialJoin, toOpData, JOIN_COUNT_FIELD } from '../spatial/index.ts';
import type { JoinAggregate, SpatialRelation } from '../spatial/index.ts';
import { probeLayer, readFeatures } from './read.ts';
import { writeFeatures } from './write.ts';
import { toRelPathChecked } from './paths.ts';
import type { FeatureRecord } from './types.ts';
import type { OpValueResult } from '../ops/executor.ts';
import type { VectorOpDeps } from './query.ts';

const RELATIONS: readonly SpatialRelation[] = ['within', 'intersects', 'contains'];
const AGGREGATES: readonly JoinAggregate[] = ['first', 'count', 'sum', 'mean'];

function readString(
  params: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * 执行 vector.spatialJoin。
 *
 * @throws {Error} 参数不对、图层打不开、汇总字段与目标图层已有列重名。
 */
export async function runVectorSpatialJoin(
  params: Readonly<Record<string, unknown>>,
  deps: VectorOpDeps,
  dryRun: boolean,
): Promise<OpValueResult> {
  const rawTarget = readString(params, 'target');
  if (rawTarget === undefined) {
    throw new Error('缺少参数 target（被连接、写入汇总值的目标图层，dataset:// 开头）');
  }
  const rawSource = readString(params, 'source');
  if (rawSource === undefined) {
    throw new Error('缺少参数 source（提供属性与几何的源图层，dataset:// 开头）');
  }
  const targetRel = toRelPathChecked(rawTarget, 'target');
  const sourceRel = toRelPathChecked(rawSource, 'source');
  if (targetRel === sourceRel) {
    throw new Error('target 与 source 是同一个图层：自己连自己没有意义');
  }

  const rawRelation = readString(params, 'relation');
  if (rawRelation === undefined) {
    throw new Error('缺少参数 relation（within / intersects / contains）');
  }
  if (!RELATIONS.includes(rawRelation as SpatialRelation)) {
    throw new Error(`参数 relation 只能是 ${RELATIONS.join(' / ')}，实为「${rawRelation}」`);
  }
  const relation = rawRelation as SpatialRelation;

  const rawAggregate = readString(params, 'aggregate') ?? 'first';
  if (!AGGREGATES.includes(rawAggregate as JoinAggregate)) {
    throw new Error(`参数 aggregate 只能是 ${AGGREGATES.join(' / ')}，实为「${rawAggregate}」`);
  }
  const aggregate = rawAggregate as JoinAggregate;

  const rawFields = params['fields'];
  let fields: string[] | undefined;
  if (rawFields !== undefined && rawFields !== null) {
    if (!Array.isArray(rawFields)) throw new Error('参数 fields 必须是数组');
    fields = rawFields.map((f) => {
      if (typeof f !== 'string' || f.trim() === '') {
        throw new Error('参数 fields 里只能放非空字符串');
      }
      return f;
    });
  }
  const fieldPrefix = readString(params, 'fieldPrefix');

  const targetAbs = deps.store.resolve(targetRel);
  const sourceAbs = deps.store.resolve(sourceRel);

  // 坐标系必须对得上。
  //
  // 两个图层的坐标系不一样时，空间关系算出来是**错的**，
  // 而结果看上去完全正常（匹配数、汇总值都像真的）——
  // 这种错用户不会发现，只能在这里挡住。
  // 实测：4326 的面与 3857 的点 Previously 照样连出「匹配 2 条」。
  const [targetInfo, sourceInfo] = await Promise.all([
    probeLayer(deps.loc, targetAbs),
    probeLayer(deps.loc, sourceAbs),
  ]);
  if (targetInfo.epsg !== null && sourceInfo.epsg !== null && targetInfo.epsg !== sourceInfo.epsg) {
    throw new Error(
      `两个图层的坐标系不一样（target 是 EPSG:${targetInfo.epsg}，source 是 EPSG:${sourceInfo.epsg}）：` +
        `这样连出来的结果在空间上是错的，但看上去完全正常。` +
        `请先用 vector.reproject 把它们投影到同一个坐标系，再连接。`,
    );
  }
  // 有一个图层没有坐标系 ⇒ **确认不了**是否一致。
  // 确认不了不等于一定错，所以照做，但必须说出来。
  const crsUnknown = targetInfo.epsg === null || sourceInfo.epsg === null;

  const [targetRead, sourceRead] = await Promise.all([
    readFeatures(deps.loc, { path: targetAbs }),
    readFeatures(deps.loc, { path: sourceAbs }),
  ]);

  const joined = spatialJoin(targetRead.features, sourceRead.features, {
    relation,
    aggregate,
    ...(fields ? { fields } : {}),
    ...(fieldPrefix ? { fieldPrefix } : {}),
  });

  // 汇总字段名：从结果里取（带前缀后的真实名字）
  const aggregateNames = new Set<string>();
  for (const row of joined.rows) {
    for (const key of Object.keys(row.aggregates)) aggregateNames.add(key);
  }
  if (aggregateNames.size === 0) {
    throw new Error(
      aggregate === 'count'
        ? '汇总字段算不出来'
        : `源图层里没有可汇总的数值字段（参与汇总的字段被跳过了：${joined.skippedFields.join('、') || '（一个都没有）'}）`,
    );
  }

  // ⚠️ 撞名必须拦下：目标图层本来就有同名列时，静默覆盖等于**改掉了用户的数据**。
  const targetColumns = new Set(targetRead.fields.map((f) => f.toLowerCase()));
  const clashes = [...aggregateNames].filter((n) => targetColumns.has(n.toLowerCase()));
  if (clashes.length > 0) {
    throw new Error(
      `汇总字段与目标图层已有的列重名：${clashes.join('、')}。` +
        `连接结果没写进去（原数据没动）。给 fieldPrefix 一个前缀，或先改掉目标图层里同名的列。`,
    );
  }

  const nextFeatures: FeatureRecord[] = targetRead.features.map((f, i) => {
    const agg = joined.rows[i]?.aggregates ?? {};
    return { properties: { ...f.properties, ...agg }, geometry: f.geometry };
  });

  if (!dryRun) {
    const write = await writeFeatures(deps.loc, deps.store, {
      target: targetRel,
      features: nextFeatures,
    });
    for (const name of aggregateNames) {
      if (!write.fieldNames.some((f) => f.toLowerCase() === name.toLowerCase())) {
        throw new Error(
          `写回之后没有找到「${name}」这一列（文件里现在有：${write.fieldNames.join('、') || '（一列都没有）'}）。` +
            `原数据没有被改坏，备份在 ${write.backupPath ?? '（没有）'}`,
        );
      }
    }
  }

  const opData = toOpData(joined);
  const matched = opData.matched;
  const summary =
    `${relation} 连接：${matched} 个目标要素匹配上源要素` +
    `（共 ${targetRead.features.length} 个；汇总 ${[...aggregateNames].join('、')}）` +
    (opData.unmatched.length > 0 ? `，${opData.unmatched.length} 个没匹配上` : '') +
    (opData.skippedFields.length > 0 ? `；跳过非数值字段 ${opData.skippedFields.join('、')}` : '') +
    (crsUnknown ? '（有一个图层没有坐标系，没法核对是否一致，结果可能不准）' : '') +
    (dryRun ? '（预演：没有写盘）' : '');

  return {
    kind: 'value',
    summary,
    data: {
      ...opData,
      target: targetRel,
      source: sourceRel,
      relation,
      aggregate,
      fields: [...aggregateNames],
      total: targetRead.features.length,
      ...(dryRun ? { dryRun } : {}),
    },
  };
}

/** 汇总字段名（带前缀后的真实名字）—— 供外部预判 */
export { JOIN_COUNT_FIELD };
