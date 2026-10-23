/**
 * `feature.setAttributes`：按条件批量改属性。
 *
 * 对应 ArcGIS Pro 里最常被吐槽的两步：
 * 打开属性表 → 按条件选中一批 → 逐个改字段。
 * Pro 要在属性表里点选、要按 Ctrl 多选，改十行就是十次双击；
 * 这里把"条件 + 要改成什么"写成一句话，引擎一次性改完。
 *
 * 骨架与 vector.addField 同源（读 → 改 → 写回 → **写完必须校验**）：
 *  - 条件由**引擎自己算**，不交给 GDAL 的 `-where`
 *    （GDAL 通用 SQL 没有 UPPER/LOWER/TRIM/LENGTH/ROUND/ABS/COALESCE，
 *      而且会把文字悄悄当数字比 —— 与本项目"类型对不上必须报错"冲突）；
 *  - 写回走 vector/write.ts 的 writeFeatures（整组备份 + 原子替换 + 失败回滚），
 *    这里不自己碰文件；
 *  - 写完回读核对：改了的列在不在、值对不对、没命中的要素有没有被误改。
 *    核对不过就抛错，并把备份路径写在消息里。
 */
import type { OpValueResult } from '../ops/executor.ts';
import { evaluate, parseExpression, toSql, type ExprNode } from '../expression/index.ts';
import { probeLayer, readFeatures, referencedFields } from '../vector/read.ts';
import { writeFeatures } from '../vector/write.ts';
import { toRelPathChecked } from '../vector/paths.ts';
import { VectorError, type FeatureRecord } from '../vector/types.ts';
import type { VectorOpDeps } from '../vector/query.ts';
import {
  coerceForColumn,
  columnKindOf,
  columnTypeChanges,
  compileWhere,
  describeValue,
  fieldNamesHint,
  isTruncatedName,
  matchIndexes,
  requireString,
  resolveFieldName,
  sameValue,
} from './common.ts';

/**
 * set 里一个值的样子。
 *
 * 两种：
 *  - 字面值：直接写进去（"已核查"、3、true、null）；
 *  - 表达式：`{ expression: '面积 * 2' }` —— 逐条要素算。
 *
 * 为什么表达式要显式包起来：字符串值既可能是文字，也可能是表达式
 * （"面积 * 2" 到底是文字还是算式，猜错就是数据被改坏）。
 * 显式包起来没有歧义，AI 产计划时也不会踩这个坑。
 */
type SetValue =
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | { readonly kind: 'expression'; readonly node: ExprNode; readonly source: string };

/** 一个要改的列：文件里真实的列名 + 要写进去的值。 */
interface SetTarget {
  readonly name: string;
  readonly requested: string;
  readonly kind: ReturnType<typeof columnKindOf>;
  readonly value: SetValue;
  readonly caveat?: string;
}

/** 是不是一个"普通对象"（不是数组、不是 null）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 解析 set 里的一个值。 */
function parseSetValue(raw: unknown, column: string): SetValue {
  if (raw === null) return { kind: 'literal', value: null };
  if (typeof raw === 'string' || typeof raw === 'boolean') {
    return { kind: 'literal', value: raw };
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      throw new VectorError(`「${column}」这一列要写的值不是有限数字：${raw}`);
    }
    return { kind: 'literal', value: raw };
  }
  if (isPlainObject(raw)) {
    const expr = raw['expression'];
    const keys = Object.keys(raw);
    if (keys.length === 1 && keys[0] === 'expression') {
      if (typeof expr !== 'string' || expr.trim() === '') {
        throw new VectorError(`「${column}」这一列的 expression 必须是一段非空的表达式文字`);
      }
      return { kind: 'expression', node: parseExpression(toSql(expr)), source: expr };
    }
  }
  throw new VectorError(
    `「${column}」这一列要写的值说不清：只支持文字、数字、布尔、空值，` +
      `或者写成 { expression: '面积 * 2' } 让引擎逐条算` +
      `（收到的是 ${describeValue(raw)}）`,
  );
}

/**
 * 执行 feature.setAttributes。
 *
 * @throws {VectorError} 参数不对、图层打不开、列不存在、条件命中 0 条、
 *                      值与列类型对不上、写回失败或写后校验不过。
 */
export async function runFeatureSetAttributes(
  params: Readonly<Record<string, unknown>>,
  deps: VectorOpDeps,
  /**
   * 预演：只算不写。
   *
   * 为什么必须有：确认卡上那一下"先看看会改多少条、改成什么"——
   * 预演完文件却变了，用户看到的和确认卡上写的不一样，整个确认流程就废了。
   */
  dryRun = false,
): Promise<OpValueResult> {
  const rawTarget = requireString(params, 'target', '要改的图层，dataset:// 开头');
  const targetRel = toRelPathChecked(rawTarget, 'target');
  const where = requireString(params, 'where', '筛选条件（SQL 或人话，如 状态 = \'待核查\'）');

  const rawSet = params['set'];
  if (!isPlainObject(rawSet)) {
    throw new VectorError('缺少参数 set（要改的字段：字段名 → 新值，如 { 状态: \'已核查\' }）');
  }
  const setEntries = Object.entries(rawSet);
  if (setEntries.length === 0) {
    throw new VectorError('参数 set 是空的：没有要改的字段');
  }

  const abs = deps.store.resolve(targetRel);
  // 探图层：文件不存在 / 打不开在这里就报出来（probeLayer 会说清"文件不存在"）
  const info = await probeLayer(deps.loc, abs);

  /* ── 列名定位：用户写的列名 → 文件里真实的列 ─────────────────── */
  const targets: SetTarget[] = [];
  for (const [key, raw] of setEntries) {
    const resolved = resolveFieldName(key, info.fields);
    if (!resolved) {
      throw new VectorError(
        `这个图层里没有「${key}」这一列（这一层的列有：${fieldNamesHint(info.fields)}）`,
      );
    }
    const field = info.fields.find((f) => f.name === resolved.name)!;
    targets.push({
      name: resolved.name,
      requested: key,
      kind: columnKindOf(field.type),
      value: parseSetValue(raw, resolved.name),
      ...(resolved.caveat ? { caveat: resolved.caveat } : {}),
    });
  }

  /* ── 条件：编译 + 列存在性检查 ───────────────────────────────── */
  const whereNode = compileWhere(where, info.fields);

  // 表达式里用到的列也要先核一遍：别等写了一半才发现列名不存在
  for (const target of targets) {
    if (target.value.kind !== 'expression') continue;
    const missing = referencedFields(target.value.node).filter(
      (name) => !info.fields.some((f) => f.name.toLowerCase() === name.toLowerCase()),
    );
    if (missing.length > 0) {
      throw new VectorError(
        `「${target.name}」这一列要写的表达式里用到的列不存在：${missing.join('、')}` +
          `（这一层的列有：${fieldNamesHint(info.fields)}）`,
      );
    }
  }

  /* ── 读要素、筛出命中的 ─────────────────────────────────────── */
  const read = await readFeatures(deps.loc, { path: abs });
  const hits = matchIndexes(read.features, whereNode);
  if (hits.length === 0) {
    // ⚠️ 0 条命中不是"成功地什么都没做"——那会让用户以为改过了。
    //    把可能的原因一起说出去（字段名写错 / 条件太严），让人自己判断。
    throw new VectorError(
      `条件没有命中任何要素（0 条命中）：「${where}」。` +
        `这一层一共 ${read.features.length} 条要素。` +
        `可能是条件太严，也可能是字段名写错了（这一层的列有：${fieldNamesHint(info.fields)}）。`,
    );
  }

  /* ── 改值 ───────────────────────────────────────────────────── */
  const nextFeatures: FeatureRecord[] = read.features.map((f) => ({
    properties: { ...f.properties },
    geometry: f.geometry,
  }));
  /** 改完之后每个命中要素上，各列应该是多少（写完拿它核对）。 */
  const applied = new Map<number, Record<string, string | number | boolean | null>>();
  const samples: Array<{ featureIndex: number; values: Record<string, string | number | boolean | null> }> = [];
  /** 小数被四舍五入成整数的处数（整数列的格式限制，要说出来）。 */
  let rounded = 0;

  for (const hit of hits) {
    const target = nextFeatures[hit]!;
    const properties: Record<string, unknown> = { ...target.properties };
    const values: Record<string, string | number | boolean | null> = {};
    for (const t of targets) {
      // 表达式按"改到这一列时的属性"求值：后面的列能看到前面刚改的值
      const raw =
        t.value.kind === 'literal'
          ? t.value.value
          : evaluate(t.value.node, properties as Record<string, unknown>);
      const value = coerceForColumn(raw, t.kind, t.name);
      if (typeof raw === 'number' && typeof value === 'number' && raw !== value) {
        rounded += 1;
      }
      properties[t.name] = value;
      values[t.name] = value;
    }
    nextFeatures[hit] = { properties, geometry: target.geometry };
    applied.set(hit, values);
    if (samples.length < 3) {
      samples.push({ featureIndex: hit + 1, values: { ...values } });
    }
  }

  const fieldNames = targets.map((t) => t.name);
  const caveats: string[] = [];
  for (const t of targets) {
    if (t.caveat) caveats.push(t.caveat);
  }

  /* ── 预演：不写盘 ───────────────────────────────────────────── */
  if (dryRun) {
    return {
      kind: 'value',
      summary:
        `将改 ${hits.length} 条要素的 ${targets.length} 个字段（${fieldNames.join('、')}）` +
        `（共 ${read.features.length} 条，预演：没有写盘）`,
      data: {
        target: targetRel,
        where,
        updated: hits.length,
        total: read.features.length,
        fields: fieldNames,
        // 字面值直接给值；表达式给第一条命中要素算出来的值（逐条会不同，samples 里能看到）
        values: Object.fromEntries(
          targets.map((t) => [
            t.name,
            t.value.kind === 'literal' ? t.value.value : samples[0]?.values[t.name] ?? null,
          ]),
        ),
        samples,
        dryRun: true,
      },
    };
  }

  /* ── 写回 ───────────────────────────────────────────────────── */
  const write = await writeFeatures(deps.loc, deps.store, {
    target: targetRel,
    features: nextFeatures,
  });

  /* ── 写完核对 ───────────────────────────────────────────────── */
  // 1) 改的列还在不在（Shapefile 会截断列名）
  for (const name of fieldNames) {
    const found = write.fieldNames.find(
      (f) => f.toLowerCase() === name.toLowerCase() || isTruncatedName(f, name),
    );
    if (!found) {
      throw new VectorError(
        `写回之后没有找到「${name}」这一列（文件里现在有：${write.fieldNames.join('、') || '（一列都没有）'}）。` +
          `原数据没有被改坏，备份在 ${write.backupPath ?? '（没有）'}`,
      );
    }
  }

  // 2) 回读核对值：改了的要对，没命中的不能被顺手改掉
  const after = await readFeatures(deps.loc, { path: abs });
  if (after.features.length !== read.features.length) {
    throw new VectorError(
      `写回之后要素数不对：写进去 ${read.features.length} 条，读回来 ${after.features.length} 条。` +
        `备份在 ${write.backupPath ?? '（没有）'}`,
    );
  }
  let mismatched = 0;
  let firstProblem: string | null = null;
  for (let i = 0; i < after.features.length; i += 1) {
    const got = after.features[i]!.properties;
    const want = applied.get(i);
    for (const t of targets) {
      const wantValue = want ? want[t.name] : read.features[i]!.properties[t.name];
      const gotValue = got[t.name] ?? null;
      if (sameValue(wantValue, gotValue)) continue;
      // 兜底：万一底层把小数存成了整数，这一条按"格式限制"处理，不算数据错
      if (
        typeof wantValue === 'number' && typeof gotValue === 'number' &&
        Number.isFinite(wantValue) && !Number.isInteger(wantValue) &&
        (Math.round(wantValue) === gotValue || Math.trunc(wantValue) === gotValue)
      ) {
        continue;
      }
      mismatched += 1;
      if (firstProblem === null) {
        firstProblem =
          `第 ${i + 1} 条要素的「${t.name}」：要写 ${JSON.stringify(wantValue)}，写回去是 ${JSON.stringify(gotValue)}`;
      }
    }
  }
  if (mismatched > 0) {
    throw new VectorError(
      `写回之后的值对不上（${mismatched} 处不一致，例：${firstProblem}）。` +
        `原数据的其它列没有被改坏，备份在 ${write.backupPath ?? '（没有）'}`,
    );
  }
  if (rounded > 0) {
    caveats.push(`${rounded} 处小数被四舍五入成了整数（这一列是整数列）`);
  }
  // 3) 列的类型有没有变（Shapefile 按值推断类型，整层重写时可能变）
  const afterInfo = await probeLayer(deps.loc, abs);
  caveats.push(...columnTypeChanges(info.fields, afterInfo.fields));

  return {
    kind: 'value',
    summary:
      `已改 ${hits.length} 条要素的 ${targets.length} 个字段（${fieldNames.join('、')}）` +
      `（共 ${read.features.length} 条）` +
      (caveats.length > 0 ? `（${caveats.join('；')}）` : ''),
    data: {
      target: targetRel,
      where,
      updated: hits.length,
      total: read.features.length,
      fields: fieldNames,
      values: Object.fromEntries(
        targets.map((t) => [
          t.name,
          samples[0]?.values[t.name] ?? null,
        ]),
      ),
      backupPath: write.backupPath,
      ...(rounded > 0 ? { rounded } : {}),
    },
  };
}
