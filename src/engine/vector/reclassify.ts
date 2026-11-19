/**
 * `vector.reclassify`：按对照表把字段里的**取值**换掉（例如 A/B/C → 1/2/3）。
 *
 * 与 `vector.recode` 的区别必须说清：
 *  - `vector.recode` 换的是**属性表的字符编码**（GBK ↔ UTF-8 ↔ LATIN1）；
 *  - 这个 op 换的是**字段值本身**。
 * 两者名字像、语义完全不同；报错与报告里一律写明，避免用户以为转码就能做值映射。
 *
 * ## 为什么需要它
 *
 * 国内成果数据里常见「甲/乙/丙」或「A/B/C」这类分类值，入库或统计前要换成
 * 数字编码。以前只能拆成多条 `where + setAttributes`，既啰嗦又容易漏掉一支。
 *
 * ## 安全口径
 *
 *  - 对照表的「原值 → 新值」按**类型严格匹配**：`1`（数字）与 `"1"`（文字）不是一回事；
 *  - 就地改时，新值必须能写进原列的类型（数字列不收文字）；
 *    要换类型（A/B/C → 1/2/3）就明确给 `outputField` 开新列，不偷偷改列类型；
 *  - 未匹配的值有三档：`keep`（保留原值）/ `null`（置空）/ `error`（整单拒绝）；
 *  - 一条都没命中 → **报错**，不返回「成功改了 0 条」；
 *  - 写回走 `vector/write.ts`（整组备份 + 原子替换 + 失败回滚），写完逐条回读核对，
 *    包括「没有参与重编码的列一个都没变」。
 *
 * 预演（dryRun）只读不写：文件 mtime 都不会动。
 */
import { probeLayer, readFeatures } from './read.ts';
import { formatForPath, writeFeatures } from './write.ts';
import { toRelPathChecked } from './paths.ts';
import { readStringParam } from './params.ts';
import { findWrittenField } from './field-names.ts';
import { VectorError, type FeatureRecord, type LayerField } from './types.ts';
import type { OpValueResult } from '../ops/executor.ts';
import type { VectorOpDeps } from './query.ts';
import { assertRewriteSize } from './limits.ts';
import {
  coerceForColumn,
  columnKindOf,
  describeValue,
  fieldNamesHint,
  resolveFieldName,
  sameValue,
  type ColumnKind,
} from '../feature/common.ts';

/** 对照表里的一行。 */
interface MappingEntry {
  readonly from: string | number | boolean | null;
  readonly to: string | number | boolean | null;
}

/** 未匹配时的处理方式。 */
type UnmatchedPolicy = 'keep' | 'null' | 'error';

/** 新列的类型口径。 */
type OutputType = 'auto' | 'string' | 'number';

const UNMATCHED_POLICIES: readonly UnmatchedPolicy[] = ['keep', 'null', 'error'];
const OUTPUT_TYPES: readonly OutputType[] = ['auto', 'string', 'number'];

/** 是不是一个"普通对象"（不是数组、不是 null）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 对照表里的一个值：文字 / 数字 / 布尔 / 空值。 */
function scalarOf(value: unknown, what: string): string | number | boolean | null {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new VectorError(`${what} 不是有限数字：${value}`);
    }
    return value;
  }
  throw new VectorError(
    `${what} 只能是文字、数字、布尔或空值（收到 ${describeValue(value)}）`,
  );
}

/**
 * 值的匹配键：**类型 + 值**。
 *
 * 为什么不能只把值转成字符串：属性表里数字 `1` 和文字 `"1"` 是两种值，
 * 统一成字符串会让「把数字 1 改成别的」误伤文字 `"1"` 的行 —— 静默改错数据。
 */
function valueKey(value: unknown): string {
  if (value === null || value === undefined) return 'null:';
  if (typeof value === 'number') return `number:${Object.is(value, -0) ? '0' : String(value)}`;
  return `${typeof value}:${String(value)}`;
}

/** 解析对照表；重复原值、缺字段、多余字段都在这里报清楚。 */
function parseMapping(raw: unknown): MappingEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new VectorError(
      '缺少参数 mapping（对照表，至少一条）：如 [{ from: "A", to: 1 }, { from: "B", to: 2 }]',
    );
  }
  const out: MappingEntry[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!isPlainObject(item)) {
      throw new VectorError(`mapping[${i}] 必须是一个对象（如 { from: "A", to: 1 }）`);
    }
    const extra = Object.keys(item).filter((k) => k !== 'from' && k !== 'to');
    if (extra.length > 0) {
      throw new VectorError(`mapping[${i}] 里有多余的键：${extra.join('、')}（只认 from 与 to）`);
    }
    if (!('from' in item) || !('to' in item)) {
      throw new VectorError(`mapping[${i}] 必须同时有 from 与 to`);
    }
    const from = scalarOf(item['from'], `mapping[${i}].from`);
    const to = scalarOf(item['to'], `mapping[${i}].to`);
    const key = valueKey(from);
    const dup = seen.get(key);
    if (dup !== undefined) {
      throw new VectorError(
        `对照表里「${describeValue(from)}」出现了两次（第 ${dup + 1} 条与第 ${i + 1} 条）：` +
          '同一个原值只能对应一个新值，否则不知道按哪条算。',
      );
    }
    seen.set(key, i);
    out.push({ from, to });
  }
  return out;
}

/** 读一个枚举参数。 */
function enumParam<T extends string>(
  params: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = readStringParam(params, key);
  if (raw === undefined) return fallback;
  const hit = allowed.find((x) => x === raw);
  if (!hit) {
    throw new VectorError(`参数 ${key} 只能是 ${allowed.join(' / ')}，实为「${raw}」`);
  }
  return hit;
}

/** 新列名合不合法（换行 / 重名 / Shapefile 10 字节上限）。 */
function validateOutputField(
  name: string,
  fields: readonly LayerField[],
  targetRel: string,
): void {
  if (/[\r\n\t]/.test(name)) {
    throw new VectorError(`outputField 里不能有换行或制表符：${name}`);
  }
  if (fields.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
    throw new VectorError(
      `这个图层已经有「${name}」这一列了（换个新列名，或者不给 outputField 直接就地改）`,
    );
  }
  if (formatForPath(targetRel) === 'shapefile' && Buffer.byteLength(name, 'utf8') > 10) {
    throw new VectorError(
      `shapefile 的字段名上限是 10 字节（UTF-8 编码下中文最多 3 个字）：` +
        `「${name}」占 ${Buffer.byteLength(name, 'utf8')} 字节，放不下。` +
        '请换个不超过 3 个汉字的列名（或者先把图层转成 GeoPackage）。',
    );
  }
}

/**
 * 就地改时，新值能不能写进这一列。
 *
 * 只做**预检查**：把每条 to 都过一遍 coerceForColumn，错误在写盘前抛出。
 * 返回的是「值被转成了什么」的说明（例如数字写进文字列会变成文字）。
 */
function checkInPlaceWritable(
  mapping: readonly MappingEntry[],
  kind: ColumnKind,
  fieldName: string,
): string[] {
  const caveats: string[] = [];
  let coercedToText = 0;
  for (const m of mapping) {
    if (m.to === null) continue;
    let result: string | number | boolean | null;
    try {
      result = coerceForColumn(m.to, kind, fieldName);
    } catch (err) {
      throw new VectorError(
        `${(err as Error).message}。` +
          '要换类型（例如把 A/B/C 换成 1/2/3），请给 outputField 开一个新列，不要就地改。',
        '',
        err,
      );
    }
    if (typeof m.to !== 'string' && typeof result === 'string') coercedToText += 1;
  }
  if (coercedToText > 0) {
    caveats.push(
      `「${fieldName}」是文字列，${coercedToText} 个非文字新值会按文字写入（` +
        '要保留数字类型，请给 outputField 开一个新列）',
    );
  }
  return caveats;
}

/** 新列的输出类型：auto 时按所有非空新值推断。 */
function resolveOutputType(
  mapping: readonly MappingEntry[],
  requested: OutputType,
): 'string' | 'number' {
  if (requested === 'string' || requested === 'number') return requested;
  const nonNull = mapping.map((m) => m.to).filter((v) => v !== null);
  if (nonNull.length > 0 && nonNull.every((v) => typeof v === 'number')) return 'number';
  return 'string';
}

/** 把一个值整理成新列要的类型；不符合就报错，不静默转。 */
function coerceForNewField(
  value: string | number | boolean | null,
  type: 'string' | 'number',
  field: string,
  context: string,
): string | number | null {
  if (value === null) return null;
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new VectorError(
        `${context}：${describeValue(value)} 写不进数字列「${field}」。` +
          '要么把它在 mapping 里改成数字，要么把 outputType 改成 string，' +
          '要么用 unmatched: "null" 把未匹配的值置空。',
      );
    }
    return value;
  }
  return typeof value === 'string' ? value : String(value);
}

/**
 * 执行 vector.reclassify。
 *
 * @throws {VectorError} 参数不对、列不存在、对照表重复、类型对不上、
 *                      一条都没命中、写回失败或写后校验不过。
 */
export async function runVectorReclassify(
  params: Readonly<Record<string, unknown>>,
  deps: VectorOpDeps,
  dryRun = false,
): Promise<OpValueResult> {
  const rawTarget = readStringParam(params, 'target');
  if (rawTarget === undefined) {
    throw new VectorError('缺少参数 target（要改的图层，dataset:// 开头）');
  }
  const targetRel = toRelPathChecked(rawTarget, 'target');

  const requestedField = readStringParam(params, 'field');
  if (requestedField === undefined) {
    throw new VectorError('缺少参数 field（要按对照表改值的字段名）');
  }
  const mapping = parseMapping(params['mapping']);
  const unmatched = enumParam(params, 'unmatched', UNMATCHED_POLICIES, 'keep');
  const requestedOutputType = enumParam(params, 'outputType', OUTPUT_TYPES, 'auto');
  const outputFieldRaw = readStringParam(params, 'outputField');
  const outputField = outputFieldRaw?.trim();

  const abs = deps.store.resolve(targetRel);
  assertRewriteSize(abs);
  const info = await probeLayer(deps.loc, abs);

  const resolved = resolveFieldName(requestedField, info.fields);
  if (!resolved) {
    throw new VectorError(
      `这个图层里没有「${requestedField}」这一列（这一层的列有：${fieldNamesHint(info.fields)}）`,
    );
  }
  const sourceField = info.fields.find((f) => f.name === resolved.name)!;
  const kind = columnKindOf(sourceField.type);

  const caveats: string[] = [];
  if (resolved.caveat) caveats.push(resolved.caveat);

  let outputType: 'string' | 'number';
  if (outputField !== undefined) {
    validateOutputField(outputField, info.fields, targetRel);
    outputType = resolveOutputType(mapping, requestedOutputType);
  } else {
    outputType = kind === 'integer' || kind === 'real' ? 'number' : 'string';
    caveats.push(...checkInPlaceWritable(mapping, kind, resolved.name));
  }

  const read = await readFeatures(deps.loc, { path: abs });
  const byKey = new Map(mapping.map((m) => [valueKey(m.from), m]));
  const used = new Set<string>();
  const unmatchedCounts = new Map<string, { value: unknown; count: number }>();
  const samples: Array<{ featureIndex: number; from: unknown; to: unknown }> = [];

  const nextFeatures: FeatureRecord[] = [];
  /** 每条要素改完之后，被改的那一列应该是什么（写完拿它核对）。 */
  const expected: Array<string | number | boolean | null> = [];
  let matched = 0;

  for (let i = 0; i < read.features.length; i += 1) {
    const feature = read.features[i]!;
    const original = (feature.properties[resolved.name] ?? null) as
      | string
      | number
      | boolean
      | null;
    const key = valueKey(original);
    const hit = byKey.get(key);

    let value: string | number | boolean | null;
    if (hit) {
      used.add(key);
      matched += 1;
      value =
        outputField !== undefined
          ? coerceForNewField(hit.to, outputType, outputField, `第 ${i + 1} 条要素`)
          : coerceForColumn(hit.to, kind, resolved.name);
      if (samples.length < 3) {
        samples.push({ featureIndex: i + 1, from: original, to: value });
      }
    } else {
      const prev = unmatchedCounts.get(key);
      if (prev) prev.count += 1;
      else unmatchedCounts.set(key, { value: original, count: 1 });

      if (unmatched === 'error') {
        // 先把所有未匹配值收集完再统一报错，用户一次能看到全部漏网的值
        value = null;
      } else if (unmatched === 'keep') {
        value =
          outputField !== undefined
            ? coerceForNewField(
                original as string | number | boolean | null,
                outputType,
                outputField,
                `第 ${i + 1} 条要素（未匹配，按 keep 保留原值）`,
              )
            : original;
      } else {
        value = null;
      }
    }

    const properties: Record<string, unknown> = { ...feature.properties };
    if (outputField !== undefined) {
      properties[outputField] = value;
    } else {
      properties[resolved.name] = value;
    }
    nextFeatures.push({ properties, geometry: feature.geometry });
    expected.push(value);
  }

  const total = read.features.length;
  const unmatchedTotal = total - matched;
  const unmatchedExamples = [...unmatchedCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((x) => `${describeValue(x.value)}（${x.count} 条）`);
  const unusedEntries = mapping.filter((m) => !used.has(valueKey(m.from)));

  if (unmatched === 'error' && unmatchedTotal > 0) {
    throw new VectorError(
      `有 ${unmatchedTotal} 条要素的值不在对照表里，按 unmatched: "error" 整单拒绝：` +
        `${unmatchedExamples.join('、')}。` +
        '补全对照表，或把 unmatched 改成 keep / null。',
    );
  }
  if (matched === 0) {
    // 0 条命中不是「成功地什么都没做」：多半是字段选错、值写错或类型对不上。
    const existing = [...new Set(read.features.map((f) => f.properties[resolved.name] ?? null))]
      .slice(0, 5)
      .map((v) => describeValue(v));
    throw new VectorError(
      `对照表里的原值在「${resolved.name}」里一条都没命中（共 ${total} 条要素）。` +
        `这一列现有的值（前 5 个）：${existing.join('、') || '（全是空值）'}。` +
        '请核对原值是否写错、或数字/文字类型是否对不上（数字 1 与文字 "1" 不是一回事）。',
    );
  }
  if (unmatchedTotal > 0) {
    caveats.push(
      `${unmatchedTotal} 条未匹配，按 ${unmatched} 处理` +
        (unmatched === 'keep' ? '（保留原值）' : unmatched === 'null' ? '（置空）' : ''),
    );
  }
  if (unusedEntries.length > 0) {
    caveats.push(
      `对照表里有 ${unusedEntries.length} 个原值在数据里没出现：` +
        unusedEntries.slice(0, 5).map((m) => describeValue(m.from)).join('、'),
    );
  }

  const fieldLabel = outputField !== undefined ? `${resolved.name} → 新列「${outputField}」` : resolved.name;
  const policyLabel = unmatched === 'keep' ? '保留原值' : unmatched === 'null' ? '置空' : '拒绝';

  if (dryRun) {
    return {
      kind: 'value',
      summary:
        `将按对照表重编码「${fieldLabel}」：${matched} 条命中 / 共 ${total} 条` +
        `（未匹配 ${unmatchedTotal} 条按「${policyLabel}」处理；预演：没有写盘）`,
      data: {
        target: targetRel,
        field: resolved.name,
        outputField: outputField ?? null,
        outputType,
        unmatched,
        matched,
        unmatchedCount: unmatchedTotal,
        total,
        mappingCount: mapping.length,
        unusedFrom: unusedEntries.map((m) => m.from),
        samples,
        dryRun: true,
      },
    };
  }

  const write = await writeFeatures(deps.loc, deps.store, {
    target: targetRel,
    features: nextFeatures,
  });

  // ── 写后核对 ─────────────────────────────────────────────────
  const writtenField =
    outputField !== undefined ? findWrittenField(write.fieldNames, outputField) : resolved.name;
  if (!writtenField) {
    throw new VectorError(
      `写回之后没有找到新列「${outputField}」（文件里现在有：${write.fieldNames.join('、') || '（一列都没有）'}）。` +
        `原数据没有被改坏，备份在 ${write.backupPath ?? '（没有）'}`,
    );
  }

  const after = await readFeatures(deps.loc, { path: abs });
  let mismatched = 0;
  let changedOthers = 0;
  let firstProblem: string | null = null;
  for (let i = 0; i < after.features.length && i < expected.length; i += 1) {
    const got = after.features[i]!.properties[writtenField] ?? null;
    if (!sameValue(expected[i], got)) {
      mismatched += 1;
      if (firstProblem === null) {
        firstProblem = `第 ${i + 1} 条：应为 ${describeValue(expected[i])}，写回去是 ${describeValue(got)}`;
      }
    }
    // 没有参与重编码的列，一个都不许变
    const before = read.features[i]!.properties;
    const now = after.features[i]!.properties;
    for (const [name, value] of Object.entries(before)) {
      if (outputField === undefined && name === resolved.name) continue;
      if (outputField !== undefined && name === writtenField) continue;
      if (!sameValue(value, now[name] ?? null)) changedOthers += 1;
    }
  }
  if (mismatched > 0) {
    throw new VectorError(
      `写回之后「${writtenField}」的值对不上（${mismatched} 条不一致，例：${firstProblem}）。` +
        `备份在 ${write.backupPath ?? '（没有）'}`,
    );
  }
  if (changedOthers > 0) {
    throw new VectorError(
      `写回之后有 ${changedOthers} 处没有参与重编码的列被改动了。` +
        `备份在 ${write.backupPath ?? '（没有）'}，请先核对备份。`,
    );
  }

  return {
    kind: 'value',
    summary:
      `已重编码「${fieldLabel}」：${matched} 条命中 / 共 ${total} 条` +
      (unmatchedTotal > 0 ? `（未匹配 ${unmatchedTotal} 条按「${policyLabel}」处理）` : '') +
      (caveats.length > 0 ? `（${caveats.join('；')}）` : ''),
    data: {
      target: targetRel,
      field: resolved.name,
      outputField: outputField ?? null,
      outputType,
      unmatched,
      matched,
      unmatchedCount: unmatchedTotal,
      total,
      mappingCount: mapping.length,
      unusedFrom: unusedEntries.map((m) => m.from),
      samples,
      backupPath: write.backupPath,
    },
  };
}
