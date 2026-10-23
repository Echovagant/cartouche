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
import { matchesWhere, probeLayer, readFeatures, referencedFields } from './read.ts';
import { writeFeatures } from './write.ts';
import { toRelPathChecked } from './paths.ts';
import { VectorError, type FeatureRecord } from './types.ts';
import type { VectorOpDeps } from './query.ts';

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
 * 在写好的文件里找到这一列。
 *
 * Shapefile 的列名会被截断（超过 10 个字符的部分没了），也可能改了大小写。
 * 找不到就当写坏了 —— 这一列不存在，用户后面按它查就是查不到。
 */
function findWrittenField(
  written: readonly string[],
  requested: string,
): string | null {
  const exact = written.find((n) => n === requested);
  if (exact) return exact;
  const lower = written.find((n) => n.toLowerCase() === requested.toLowerCase());
  if (lower) return lower;
  // 截断：写进去的是请求名的前缀
  const prefix = written.find((n) => requested.toLowerCase().startsWith(n.toLowerCase()) && n !== '');
  if (prefix) return prefix;
  return null;
}

/**
 * 执行 vector.addField。
 *
 * @throws {Error} 参数不对、列名冲突、条件里的列不存在、写回失败或写后校验不过。
 */
export async function runVectorAddField(
  params: Readonly<Record<string, unknown>>,
  deps: VectorOpDeps,
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

  const abs = deps.store.resolve(targetRel);
  const info = await probeLayer(deps.loc, abs);

  if (info.fields.some((f) => f.name.toLowerCase() === fieldName.toLowerCase())) {
    throw new VectorError(
      `这个图层已经有「${fieldName}」这一列了（换个名字，或者先改这一列的算法）`,
    );
  }

  // 表达式：SQL 或人话都行（人话先翻）
  const exprSql = toSql(rawExpression);
  const exprNode: ExprNode = parseExpression(exprSql);
  const whereNode = where ? parseExpression(toSql(where)) : null;

  // 列名先核一遍：条件里写了不存在的列，要在使用者看到属性表之前就报错
  const known = (name: string): boolean =>
    info.fields.some((f) => f.name.toLowerCase() === name.toLowerCase());
  for (const field of [...referencedFields(exprNode), ...(whereNode ? referencedFields(whereNode) : [])]) {
    if (!known(field)) {
      const have = info.fields.map((f) => f.name).slice(0, 12).join('、');
      throw new VectorError(`这一层没有「${field}」这一列（这一层的列有：${have}）`);
    }
  }

  // 读出全部要素：写回时要把整层数据都写出去（不写的那部分等于删了）
  const read = await readFeatures(deps.loc, { path: abs });

  let updated = 0;
  const computed: unknown[] = [];
  const nextFeatures: FeatureRecord[] = read.features.map((f) => {
    const properties: Record<string, unknown> = { ...f.properties };
    const hit = whereNode === null ? true : matchesWhere(whereNode, f.properties);
    let value: string | number | boolean | null = null;
    if (hit) {
      value = writableValue(evaluate(exprNode, f.properties));
      updated += 1;
    }
    computed.push(value);
    properties[fieldName] = value;
    return { properties, geometry: f.geometry };
  });

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
  if (writtenField !== fieldName) {
    caveats.push(`Shapefile 的列名被规范化成了「${writtenField}」`);
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

/** 两个值算不算一样（数字按数值比，其余按字符串比）。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined || b === '';
  if (b === null || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return String(a) === String(b);
}
