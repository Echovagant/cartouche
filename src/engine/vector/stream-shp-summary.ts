/**
 * 超大 Shapefile 的流式分组汇总。
 *
 * 常规路径把整层要素读成 GeoJSON 再在 JS 里分组累计 —— GB 级数据会爆内存。
 * Shapefile 的属性全在 .dbf（定长记录），按块遍历、逐条解码、在 JS 里累计，
 * 内存只跟"分组数 × 被统计列数"有关，与文件体积无关。
 *
 * 与普通路径（summarize.ts 的 JS 分组）的口径完全一致：
 *  - 分组键的 JSON 串相同，组按文件首次出现顺序排；
 *  - 数值列非数字跳过；一个有效值都没有的列按缺测（null）出；
 *  - distinct 按值类型分键（数字 1 与文字 "1" 分开算）；
 *  - 唯一做不到的是 area / length —— 要读 .shp 几何，等于把整层读进内存，
 *    所以这条流式路径把它们明确拒收（入口在 summarize.ts）。
 *
 * 已被标记删除的记录（0x2A）不参与汇总，与 GDAL 读到的要素集一致。
 */
import type { OpValueResult } from '../ops/executor.ts';
import { roundTo } from '../expression/index.ts';
import type { GdalLocation } from '../gdal/env.ts';
import { VectorError, type LayerInfo } from './types.ts';
import { decodeDbfRecord, isActiveRecord } from './dbf.ts';
import { forEachRecord, shpContext } from './stream-shp-edit.ts';

/** 分组太多时一次出表会撑爆界面与内存（与 GPKG 流式汇总同一个上限） */
const MAX_STREAM_GROUPS = 100000;

/** 数值统计项的输出列前缀（与普通路径一致） */
const NUMERIC_PREFIX: Readonly<Record<'sum' | 'mean' | 'min' | 'max', string>> = {
  sum: 'sum_',
  mean: 'mean_',
  min: 'min_',
  max: 'max_',
};

/** 汇总表里一行 */
type SummaryRow = Record<string, string | number | boolean | null>;

/** 一组的累计量（与 summarize.ts 的 GroupState 同构，去掉几何两列） */
interface GroupState {
  readonly keyValues: readonly unknown[];
  count: number;
  readonly numbers: Map<string, { sum: number; count: number; min: number; max: number }>;
  readonly distincts: Map<string, Set<string>>;
}

/** 一个值参与去重时的键（数字 1 与文字 "1" 要分开算；与普通路径同一口径） */
function distinctKey(v: unknown): string {
  return `${typeof v}:${String(v)}`;
}

export interface ShpStreamSummarizeInput {
  readonly targetRel: string;
  readonly absPath: string;
  readonly info: LayerInfo;
  readonly groupFields: readonly { readonly name: string }[];
  readonly groupNames: readonly string[];
  readonly aggregates: readonly string[];
  readonly numericFields: readonly { readonly name: string }[];
  readonly distinctFields: readonly { readonly name: string }[];
  readonly wantsArea: boolean;
  readonly wantsLength: boolean;
  readonly dryRun: boolean;
}

/** 流式分组汇总：只动 .dbf，不读 .shp 几何 */
export async function shpStreamSummarize(
  loc: GdalLocation,
  input: ShpStreamSummarizeInput,
): Promise<OpValueResult> {
  void loc;
  if (input.wantsArea || input.wantsLength) {
    throw new VectorError(
      '超大 Shapefile 的流式汇总不支持 area / length（要逐条读几何，等于把整层读进内存）。' +
        '属性类的 count / sum / mean / min / max / distinct 都可用；' +
        '要算面积与长度，请先把文件拆小，或转成 GeoPackage 后用数据库原生汇总。',
    );
  }
  const ctx = shpContext(input.targetRel, input.absPath, input.info);

  const groups = new Map<string, GroupState>();
  let total = 0;

  forEachRecord(ctx, ({ buffer: record }) => {
    if (!isActiveRecord(record)) return;
    total += 1;
    const properties = decodeDbfRecord(record, ctx.header, ctx.info.fields);
    const keyValues = input.groupFields.map((f) => properties[f.name] ?? null);
    const key = JSON.stringify(keyValues);
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= MAX_STREAM_GROUPS) {
        throw new VectorError(
          `分组太多（超过 ${MAX_STREAM_GROUPS} 组），一次出表会撑爆界面与内存。` +
            '请减少分组字段、先按范围拆分，或把文件拆小后再汇总。',
        );
      }
      group = { keyValues, count: 0, numbers: new Map(), distincts: new Map() };
      groups.set(key, group);
    }
    group.count += 1;
    for (const field of input.numericFields) {
      const raw = properties[field.name];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      const acc = group.numbers.get(field.name) ?? { sum: 0, count: 0, min: raw, max: raw };
      acc.sum += raw;
      acc.count += 1;
      if (raw < acc.min) acc.min = raw;
      if (raw > acc.max) acc.max = raw;
      group.numbers.set(field.name, acc);
    }
    for (const field of input.distinctFields) {
      const raw = properties[field.name];
      if (raw === null || raw === undefined) continue;
      const set = group.distincts.get(field.name) ?? new Set<string>();
      set.add(distinctKey(raw));
      group.distincts.set(field.name, set);
    }
  });

  const columns: string[] = [...input.groupNames];
  if (input.aggregates.includes('count')) columns.push('count');
  for (const kind of ['sum', 'mean', 'min', 'max'] as const) {
    if (!input.aggregates.includes(kind)) continue;
    for (const field of input.numericFields) columns.push(`${NUMERIC_PREFIX[kind]}${field.name}`);
  }
  if (input.aggregates.includes('distinct')) {
    for (const field of input.distinctFields) columns.push(`distinct_${field.name}`);
  }

  const rows: SummaryRow[] = [];
  for (const group of groups.values()) {
    const row: SummaryRow = {};
    input.groupFields.forEach((field, i) => {
      row[field.name] = (group.keyValues[i] ?? null) as string | number | boolean | null;
    });
    if (input.aggregates.includes('count')) row['count'] = group.count;
    for (const kind of ['sum', 'mean', 'min', 'max'] as const) {
      if (!input.aggregates.includes(kind)) continue;
      for (const field of input.numericFields) {
        const acc = group.numbers.get(field.name);
        const column = `${NUMERIC_PREFIX[kind]}${field.name}`;
        if (!acc || acc.count === 0) {
          // 一个有效数值都没有 → 缺测，不是 0（与普通路径同口径）
          row[column] = null;
          continue;
        }
        if (kind === 'sum') row[column] = roundTo(acc.sum, 6);
        else if (kind === 'mean') row[column] = roundTo(acc.sum / acc.count, 6);
        else if (kind === 'min') row[column] = acc.min;
        else row[column] = acc.max;
      }
    }
    if (input.aggregates.includes('distinct')) {
      for (const field of input.distinctFields) {
        row[`distinct_${field.name}`] = group.distincts.get(field.name)?.size ?? 0;
      }
    }
    rows.push(row);
  }

  const caveats: string[] = ['超大 Shapefile 按 DBF 流式汇总，分组按文件顺序'];

  const parts: string[] = [];
  parts.push(`按「${input.groupNames.join('、')}」分成 ${groups.size} 组`);
  parts.push(`统计项 ${input.aggregates.join('、')}`);
  parts.push(`共 ${total} 条要素`);
  if (input.dryRun) parts.push('预演：没有写盘');

  return {
    kind: 'value',
    summary: parts.join('，') + (caveats.length > 0 ? `（${caveats.join('；')}）` : ''),
    data: {
      target: input.targetRel,
      groupBy: input.groupNames,
      aggregates: input.aggregates,
      featureCount: total,
      groupCount: groups.size,
      columns,
      rows,
      caveats,
      ...(input.dryRun ? { dryRun: true } : {}),
      streamed: true,
    },
  };
}
