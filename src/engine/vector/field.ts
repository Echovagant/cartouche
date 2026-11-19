/**
 * `vector.addField`：加一个计算字段（算完写回原文件）。
 *
 * 对应 ArcGIS Pro 的"字段计算器"—— 那一步是 Pro 用户吐槽最多的地方：
 * 得进对话框、写 SQL 式的表达式。这里把表达式挪到一句话里，
 * 并且人话也能写。
 *
 * 写回是这个 op 最需要小心的部分：
 *  - Shapefile 是一套文件，备份要整套备（见 write.ts）；
 *  - 写完必须能打开、字段要在、值要对 —— 写坏的图层比没写更糟；
 *  - 坐标系不能丢（GeoJSON 来回转会把投影改掉，write.ts 里用 -a_srs 原样带过去）。
 */
import type { GdalLocation } from '../gdal/env.ts';
import type { WorkspaceAdapter } from '../workspace/index.ts';
import type { OpValueResult } from '../ops/executor.ts';
import { evaluate, parseExpression, toSql, type ExprNode } from '../expression/index.ts';
// 量算与「按条件汇总面积」同一套口径：面按外环减洞、经纬度直接拒绝。
// 这个模块只依赖 geometry 与 vector/types，不会和本文件形成环。
import { crsMeasureOf, geometryKind, planarArea } from '../feature/measure.ts';
import { matchesWhere, probeLayer, readFeatures, referencedFields } from './read.ts';
import { formatForPath, writeFeatures } from './write.ts';
import { toRelPathChecked } from './paths.ts';
import { findWrittenField } from './field-names.ts';
import { VectorError, type FeatureRecord } from './types.ts';
import type { VectorOpDeps } from './query.ts';
import { layerSizeBytes, rewriteSizeError } from './limits.ts';
import { nativeSqlKind } from './gpkg-native.ts';
import { gpkgStreamAddField } from './stream-gpkg-edit.ts';

/**
 * 面积伪列。
 *
 * 用户（和模型）会说「加一列面积」；ArcGIS 的字段计算器也有 `!shape.area!`。
 * 这里给一个固定名字 AREA，按**平方米**算 —— 与「按条件汇总面积」同一口径。
 * 图层里如果本来就有 AREA 列，真实列优先，不会被伪列顶掉。
 */
const AREA_PSEUDO = 'AREA';

/** 读一个非空字符串参数；没有、或只有空白，返回 undefined。 */
function readString(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** 算出来的值能不能写进属性表。 */
function writableValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new VectorError(`算出来的值写不进属性表：${value}（不是有限数字）`);
    }
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  throw new VectorError(`算出来的值写不进属性表：${JSON.stringify(value)}`);
}

/**
 * 执行 vector.addField。
 *
 * @throws {Error} 参数不对、列名冲突、条件里的列不存在、写回失败或写后校验不过。
 */
export async function runVectorAddField(
  params: Readonly<Record<string, unknown>>,
  deps: VectorOpDeps,
  /**
   * 预演：只算不写。
   *
   * 为什么必须有：预演是确认卡上那一下「先看看会改多少」——
   * 预演完文件却变了，用户看到的和确认卡上写的不一样，整个确认流程就废了。
   */
  dryRun = false,
): Promise<OpValueResult> {
  const rawTarget = readString(params, 'target');
  if (rawTarget === undefined) throw new Error('缺少参数 target（要改的图层，dataset:// 开头）');
  const targetRel = toRelPathChecked(rawTarget, 'target');

  const fieldName = readString(params, 'name');
  if (fieldName === undefined) {
    throw new Error('缺少参数 name（要加的这一列叫什么）');
  }
  if (/[\r\n\t]/.test(fieldName)) {
    throw new Error(`列名里不能有换行或制表符：${fieldName}`);
  }

  const rawExpression = readString(params, 'expression');
  if (rawExpression === undefined) {
    throw new Error('缺少参数 expression（这一列的值怎么算）');
  }
  const where = readString(params, 'where');

  // Shapefile 的 DBF 字段名上限是 **10 字节**：UTF-8 编码下中文最多 3 个字。
  // 这是格式本身的红线，ArcGIS 自己的 UTF-8 shapefile 也守着它（真实数据实测：
  // 县.shp 里最长的字段名就是 3 个字）。不在这里拦的话，GDAL 会把名字清洗/丢列，
  // 用户最后看到的是一句「写回之后没有找到这一列」的难懂报错（2026-11-14 真实数据实测）。
  if (formatForPath(targetRel) === 'shapefile' && Buffer.byteLength(fieldName, 'utf8') > 10) {
    const bytes = Buffer.byteLength(fieldName, 'utf8');
    throw new VectorError(
      `shapefile 的字段名上限是 10 字节（UTF-8 编码下中文最多 3 个字）：` +
        `「${fieldName}」占 ${bytes} 字节，放不下。请换个不超过 3 个汉字的字段名` +
        `（或者先把图层转成 GeoPackage，那里的字段名没有这个限制）。`,
    );
  }

  const abs = deps.store.resolve(targetRel);
  const info = await probeLayer(deps.loc, abs);
  const size = layerSizeBytes(abs);
  const oversize = size === null ? null : rewriteSizeError(size);
  const streamed = oversize !== null && nativeSqlKind(abs) === 'gpkg';
  if (oversize && !streamed) throw new VectorError(oversize);

  if (info.fields.some((f) => f.name.toLowerCase() === fieldName.toLowerCase())) {
    throw new VectorError(
      `这个图层已经有「${fieldName}」这一列了（换个名字，或者先改这一列的算法）`,
    );
  }

  // 表达式：SQL 或人话都行（人话先翻）
  const exprSql = toSql(rawExpression);
  const exprNode: ExprNode = parseExpression(exprSql);
  const whereNode = where ? parseExpression(toSql(where)) : null;

  // 面积伪列 AREA：图层里没有同名真实列时才生效（真实列优先）。
  // 只有表达式/条件真的用到它时才检查坐标系 —— 别的算式不该被面积规则误伤。
  const realAreaColumn = info.fields.find((f) => f.name.toUpperCase() === AREA_PSEUDO) ?? null;
  const areaPseudo = realAreaColumn === null && referencesArea([exprNode, whereNode]);
  let metersPerUnit = 1;
  if (areaPseudo) {
    const measure = crsMeasureOf(info);
    const tag = info.epsg !== null ? `EPSG:${info.epsg}` : '未标注坐标系';
    if (measure.kind === 'geographic') {
      throw new VectorError(
        `这个图层的坐标系是${tag}，按平面算出来的面积没有意义（度² 不是面积，越往高纬偏得越多）。` +
          '要把面积写进一列，请先把图层重投影到米制投影坐标系（vector.reproject），再算 AREA。',
      );
    }
    if (measure.kind === 'unknown' || measure.metersPerUnit === null) {
      throw new VectorError(
        '这个图层没有可用的投影坐标系（不知道坐标单位是什么），算不出以平方米为单位的面积。' +
          '给图层补上投影坐标系，或改用能直接算的列。',
      );
    }
    metersPerUnit = measure.metersPerUnit;
  }

  // 列名先核一遍：条件里写了不存在的列，要在使用者看到属性表之前就报错
  const known = (name: string): boolean =>
    (areaPseudo && name.toUpperCase() === AREA_PSEUDO) ||
    info.fields.some((f) => f.name.toLowerCase() === name.toLowerCase());
  for (const field of [...referencedFields(exprNode), ...(whereNode ? referencedFields(whereNode) : [])]) {
    if (!known(field)) {
      const have = info.fields.map((f) => f.name).slice(0, 12).join('、');
      throw new VectorError(`这一层没有「${field}」这一列（这一层的列有：${have}）`);
    }
  }

  // 超大 GeoPackage：走原生 SQL（不改几何、不读全量要素）
  if (streamed) {
    return gpkgStreamAddField(deps.loc, deps.store, {
      targetRel,
      absPath: abs,
      info,
      fieldName,
      exprNode,
      whereNode,
      areaPseudo,
      metersPerUnit,
      dryRun,
    });
  }

  // 读出全部要素：写回时要把整层数据都写出去（不写的那部分等于删了）
  const read = await readFeatures(deps.loc, { path: abs });

  // 面要素才有面积；点/线算出来全是 0，写一列 0 等于骗人。
  if (areaPseudo) {
    const hasArea = read.features.some((f) => f.geometry !== null && geometryKind(f.geometry) === 'area');
    if (!hasArea) {
      throw new VectorError('这一层是点/线要素，没有面积可算（AREA 只对面要素有意义）。');
    }
  }

  let updated = 0;
  const computed: unknown[] = [];
  const nextFeatures: FeatureRecord[] = read.features.map((f) => {
    const properties: Record<string, unknown> = { ...f.properties };
    // AREA = 平面面积 × 单位换算²，统一成平方米；条件里也能用它筛选
    const row: Record<string, unknown> = areaPseudo
      ? { ...f.properties, [AREA_PSEUDO]: planarArea(f.geometry, '要素') * metersPerUnit * metersPerUnit }
      : f.properties;
    const hit = whereNode === null ? true : matchesWhere(whereNode, row);
    let value: string | number | boolean | null = null;
    if (hit) {
      value = writableValue(evaluate(exprNode, row));
      updated += 1;
    }
    computed.push(value);
    properties[fieldName] = value;
    return { properties, geometry: f.geometry };
  });

  // 预演：不写盘，只报出会改什么
  if (dryRun) {
    return {
      kind: 'value',
      summary:
        `将加字段「${fieldName}」：${updated} 条要素会赋值（共 ${read.features.length} 条）` +
        `（预演：没有写盘${areaPseudo ? '；AREA 按平方米' : ''}）`,
      data: {
        fieldName,
        updated,
        total: read.features.length,
        requestedName: fieldName,
        target: targetRel,
        dryRun: true,
      },
    };
  }

  const write = await writeFeatures(deps.loc, deps.store, {
    target: targetRel,
    features: nextFeatures,
  });

  // ── 写完核对：这一列在不在、值对不对 ──────────────────────────
  const writtenField = findWrittenField(write.fieldNames, fieldName);
  if (!writtenField) {
    throw new VectorError(
      `写回之后没有找到「${fieldName}」这一列（文件里现在有：${write.fieldNames.join('、') || '（一列都没有）'}）。` +
        `原数据没有被改坏，备份在 ${write.backupPath ?? '（没有）'}`,
    );
  }

  const after = await readFeatures(deps.loc, { path: abs });
  let rounded = 0;
  let mismatched = 0;
  let firstProblem: string | null = null;
  for (let i = 0; i < after.features.length && i < computed.length; i += 1) {
    const want = computed[i];
    const got = after.features[i]!.properties[writtenField] ?? null;
    if (sameValue(want, got)) continue;
    // Shapefile 的整数列会把小数四舍五入 —— 这是格式本身的限制，要说出来而不是当成错
    if (typeof want === 'number' && typeof got === 'number' && Math.round(want) === got) {
      rounded += 1;
      continue;
    }
    mismatched += 1;
    if (firstProblem === null) {
      firstProblem = `第 ${i + 1} 条要素：算出来是 ${JSON.stringify(want)}，写回去是 ${JSON.stringify(got)}`;
    }
  }
  if (mismatched > 0) {
    throw new VectorError(
      `写回之后这一列的值对不上（${mismatched} 条不一致，例：${firstProblem}）。` +
        `原数据的其它列没有被改坏，备份在 ${write.backupPath ?? '（没有）'}`,
    );
  }

  const caveats: string[] = [];
  // ⚠️ 一个要素都没改到 = 这次什么也没发生。列是加了，可里面全是空值 ——
  //    用户看到"加好了"，回头一看一列空的，会以为是自己数据有问题。
  //    这里明确说出来，不静默。
  if (updated === 0) {
    caveats.push('没有任何要素符合条件，这一列全是空值');
  }
  if (writtenField !== fieldName) {
    caveats.push(`Shapefile 的列名被规范化成了「${writtenField}」`);
  }
  if (areaPseudo) {
    caveats.push('「AREA」是要素面积，单位平方米');
  }
  if (rounded > 0) {
    caveats.push(`${rounded} 条的小数被存成了整数（Shapefile 的整数列会四舍五入）`);
  }

  return {
    kind: 'value',
    summary:
      `已加字段「${writtenField}」：${updated} 条要素赋了值（共 ${read.features.length} 条）` +
      (caveats.length > 0 ? `（${caveats.join('；')}）` : ''),
    data: {
      fieldName: writtenField,
      updated,
      total: read.features.length,
      requestedName: fieldName,
      target: targetRel,
      backupPath: write.backupPath,
      ...(rounded > 0 ? { rounded } : {}),
    },
  };
}

/** 表达式 / 条件里是否引用了面积伪列（大小写不敏感） */
function referencesArea(nodes: readonly (ExprNode | null)[]): boolean {
  return nodes.some(
    (node) =>
      node !== null && referencedFields(node).some((name) => name.toUpperCase() === AREA_PSEUDO),
  );
}

/**
 * 两个值算不算一样（数字按数值比，其余按字符串比）。
 *
 * ⚠️ 这里**不**用 field-names.ts 里的 valuesMatch：那个函数把"整数列四舍五入"
 * 也当成相等，而本函数要把这种情况单独统计出来报给用户。
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined || b === '';
  if (b === null || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return String(a) === String(b);
}
