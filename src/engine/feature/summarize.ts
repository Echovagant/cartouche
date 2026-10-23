/**
 * `feature.summarize`：按字段分组汇总。
 *
 * 对应 ArcGIS Pro 的「汇总统计」。Pro 那边要先选统计字段、再选统计方式
 * （SUM / MEAN / MIN / MAX / COUNT），每个统计项要配一遍字段，选错了不会有人提醒你。
 * 这里把分组字段与统计项写在一起，产出是一张"每组一行"的表。
 *
 * ## 统计项各自的含义
 *
 *  - count     ：这一组有多少条要素。
 *  - area      ：这一组的面积合计（单位由 areaUnit 显式指定，见下）。
 *  - length    ：这一组的长度合计（线要素的线长 + 面要素的周长，
 *                与 ArcGIS Pro 的 Shape Length 口径一致；单位是图层的坐标单位）。
 *  - sum/mean/min/max ：逐个数值列算（分组字段本身不算 —— 它是键，不是被统计的量）。
 *                产出列名形如 `sum_POP2020`。
 *  - distinct  ：逐列的去重计数（该列在这一组里有几个不同的值），
 *                产出列名形如 `distinct_POP2020`。
 *
 * 为什么 sum/mean/min/max/distinct 是"逐列"的：契约里只有 `aggregates`，
 * 没有"统计哪一个字段"这一项。与其猜一个字段（猜错=数据全错），
 * 不如把这一层所有数值列都算出来 —— 口径与 vector.spatialJoin 一致
 * （那里也是对源图层的数值列逐列汇总）。哪一列不要，看结果表就知道。
 *
 * ## 面积单位必须显式
 *
 * 面积是带量纲的量：同样的坐标，米制投影下是 m²，经纬度下是"度²"——
 * 后者换算成面积是错的（越往高纬偏得越多）。
 * 所以 areaUnit 不给就报错，不给一个"默认单位"糊弄过去；
 * 图层是经纬度坐标系时，算面积直接报错（同一个道理，见 measure.ts）。
 */
import type { OpValueResult } from '../ops/executor.ts';
import { roundTo } from '../expression/index.ts';
import { probeLayer, readFeatures } from '../vector/read.ts';
import { toRelPathChecked } from '../vector/paths.ts';
import { VectorError, type LayerField } from '../vector/types.ts';
import type { VectorOpDeps } from '../vector/query.ts';
import {
  columnKindOf,
  fieldNamesHint,
  readStringArray,
  requireString,
  resolveFieldName,
} from './common.ts';
import {
  AREA_UNIT_KEYS,
  areaUnitLabel,
  areaUnitSquareMeters,
  crsMeasureOf,
  planarArea,
  planarLength,
  requireAreaCapable,
} from './measure.ts';

/** 契约里 aggregates 的全部取值。 */
const AGGREGATE_KINDS: readonly string[] = [
  'count', 'area', 'length', 'sum', 'mean', 'min', 'max', 'distinct',
];

/** 汇总表里一行。 */
type SummaryRow = Record<string, string | number | boolean | null>;

/** 一组的累计量。 */
interface GroupState {
  readonly key: string;
  readonly keyValues: readonly unknown[];
  count: number;
  areaRaw: number;
  lengthRaw: number;
  /** 逐列的数值累计（sum / min / max / mean 用） */
  readonly numbers: Map<string, { sum: number; count: number; min: number; max: number }>;
  /** 逐列的去重计数 */
  readonly distincts: Map<string, Set<string>>;
}

/** 数值列的统计口径：逐列算，列名带前缀。 */
const NUMERIC_PREFIX: Readonly<Record<string, string>> = {
  sum: 'sum_',
  mean: 'mean_',
  min: 'min_',
  max: 'max_',
};

/** 一个值参与去重时的键（数字 1 与文字 "1" 要分开算）。 */
function distinctKey(v: unknown): string {
  return `${typeof v}:${String(v)}`;
}

/** 执行 feature.summarize。
 *
 * @throws {VectorError} 参数不对、图层打不开、分组列不存在、
 *                      算面积但没给单位（或给的单位不认识）、图层是经纬度却要算面积。
 */
export async function runFeatureSummarize(
  params: Readonly<Record<string, unknown>>,
  deps: VectorOpDeps,
  /** 预演：汇总不写盘，这个标记只是让确认卡知道"这是预演的结果"。 */
  dryRun = false,
): Promise<OpValueResult> {
  const rawTarget = requireString(params, 'target', '要汇总的图层，dataset:// 开头');
  const targetRel = toRelPathChecked(rawTarget, 'target');

  const groupByRaw = readStringArray(params, 'groupBy');
  if (!groupByRaw || groupByRaw.length === 0) {
    throw new VectorError('缺少参数 groupBy（按哪些字段分组，至少一个）');
  }
  const aggregatesRaw = readStringArray(params, 'aggregates');
  if (!aggregatesRaw || aggregatesRaw.length === 0) {
    throw new VectorError(
      `缺少参数 aggregates（要统计什么，可选：${AGGREGATE_KINDS.join(' / ')}）`,
    );
  }
  const unknownAggregates = aggregatesRaw.filter((a) => !AGGREGATE_KINDS.includes(a));
  if (unknownAggregates.length > 0) {
    throw new VectorError(
      `参数 aggregates 里有不认识的统计项：${unknownAggregates.join('、')}` +
        `（可选：${AGGREGATE_KINDS.join(' / ')}）`,
    );
  }
  const aggregates = [...new Set(aggregatesRaw)];

  // 契约里没有 where：给了就必须说清，不能当成"已按条件汇总"而其实汇总了整层
  if (params['where'] !== undefined && params['where'] !== null) {
    throw new VectorError(
      'feature.summarize 不支持 where（契约里没有这一项）：它汇总的是整层。' +
        '要按条件统计，请先用 vector.query 把要素取出来。',
    );
  }

  const abs = deps.store.resolve(targetRel);
  const info = await probeLayer(deps.loc, abs);

  /* ── 分组列：定位到图层里真实的列 ───────────────────────────── */
  const groupFields: LayerField[] = [];
  // 同一个字段写两遍没有意义（分组键会重复，输出列也会重复）——去重，别让人拿到两列同名
  for (const name of [...new Set(groupByRaw)]) {
    const resolved = resolveFieldName(name, info.fields);
    if (!resolved) {
      throw new VectorError(
        `这个图层里没有「${name}」这一列，没法按它分组（这一层的列有：${fieldNamesHint(info.fields)}）`,
      );
    }
    const field = info.fields.find((f) => f.name === resolved.name)!;
    groupFields.push(field);
  }
  const groupNames = groupFields.map((f) => f.name);
  const groupKeySet = new Set(groupNames.map((n) => n.toLowerCase()));

  /* ── 面积单位 ───────────────────────────────────────────────── */
  const wantsArea = aggregates.includes('area');
  const wantsLength = aggregates.includes('length');
  const rawAreaUnitRaw = params['areaUnit'];
  if (rawAreaUnitRaw !== undefined && rawAreaUnitRaw !== null && typeof rawAreaUnitRaw !== 'string') {
    throw new VectorError(
      `参数 areaUnit 只能是字符串（${AREA_UNIT_KEYS.join(' / ')}），实为 ${JSON.stringify(rawAreaUnitRaw)}`,
    );
  }
  const rawAreaUnit = typeof rawAreaUnitRaw === 'string' && rawAreaUnitRaw.trim() !== ''
    ? rawAreaUnitRaw
    : undefined;
  if (rawAreaUnit !== undefined && !AREA_UNIT_KEYS.includes(rawAreaUnit)) {
    throw new VectorError(
      `不认识面积单位「${rawAreaUnit}」（可选：${AREA_UNIT_KEYS.join(' / ')}）`,
    );
  }
  if (wantsArea && rawAreaUnit === undefined) {
    // 契约里 areaUnit 写了"面积单位必须显式声明"：不给就报错，不给默认单位
    throw new VectorError(
      `算面积必须显式给面积单位（areaUnit）：${AREA_UNIT_KEYS.join(' / ')}。` +
        `不声明单位的结果没法核对（经纬度下算出来的面积更是没有意义），所以这一步停下了。`,
    );
  }

  const measure = crsMeasureOf(info);
  if (wantsArea) {
    requireAreaCapable(measure, info.epsg);
  }

  /* ── 要逐列统计的列 ─────────────────────────────────────────── */
  const numericFields = info.fields.filter(
    (f) => !groupKeySet.has(f.name.toLowerCase()) &&
      (columnKindOf(f.type) === 'integer' || columnKindOf(f.type) === 'real'),
  );
  const wantsColumnStats = aggregates.some((a) => a in NUMERIC_PREFIX);
  const wantsDistinct = aggregates.includes('distinct');
  const distinctFields = info.fields.filter((f) => !groupKeySet.has(f.name.toLowerCase()));

  if (wantsColumnStats && numericFields.length === 0) {
    throw new VectorError(
      `sum / mean / min / max 需要数值列，但这一层除了分组字段（${groupNames.join('、')}）` +
        `没有别的数值列（这一层的列有：${fieldNamesHint(info.fields)}）。`,
    );
  }
  if (wantsDistinct && distinctFields.length === 0) {
    throw new VectorError(
      `distinct 需要有列可去重，但这一层除了分组字段（${groupNames.join('、')}）没有别的列。`,
    );
  }

  /* ── 读要素、分组、累计 ─────────────────────────────────────── */
  const read = await readFeatures(deps.loc, { path: abs });
  const groups = new Map<string, GroupState>();
  let nullGeometry = 0;

  for (const [index, feature] of read.features.entries()) {
    const keyValues = groupFields.map((f) => feature.properties[f.name] ?? null);
    const key = JSON.stringify(keyValues);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        keyValues,
        count: 0,
        areaRaw: 0,
        lengthRaw: 0,
        numbers: new Map(),
        distincts: new Map(),
      };
      groups.set(key, group);
    }
    group.count += 1;

    if (!feature.geometry && (wantsArea || wantsLength)) {
      nullGeometry += 1;
    }
    if (wantsArea) {
      group.areaRaw += measureGeometry(index, (label) => planarArea(feature.geometry, label));
    }
    if (wantsLength) {
      group.lengthRaw += measureGeometry(index, (label) => planarLength(feature.geometry, label));
    }

    for (const field of numericFields) {
      const raw = feature.properties[field.name];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      const acc = group.numbers.get(field.name) ?? { sum: 0, count: 0, min: raw, max: raw };
      acc.sum += raw;
      acc.count += 1;
      if (raw < acc.min) acc.min = raw;
      if (raw > acc.max) acc.max = raw;
      group.numbers.set(field.name, acc);
    }
    if (wantsDistinct) {
      for (const field of distinctFields) {
        const raw = feature.properties[field.name];
        if (raw === null || raw === undefined) continue;
        const set = group.distincts.get(field.name) ?? new Set<string>();
        set.add(distinctKey(raw));
        group.distincts.set(field.name, set);
      }
    }
  }

  /* ── 出表 ───────────────────────────────────────────────────── */
  // 面积换算：坐标单位² → m² → 目标单位
  const areaFactor =
    wantsArea && rawAreaUnit !== undefined
      ? ((measure.metersPerUnit ?? 1) ** 2) / areaUnitSquareMeters(rawAreaUnit)
      : 1;

  const columns: string[] = [...groupNames];
  if (aggregates.includes('count')) columns.push('count');
  if (wantsArea) columns.push('area');
  if (wantsLength) columns.push('length');
  for (const kind of ['sum', 'mean', 'min', 'max'] as const) {
    if (!aggregates.includes(kind)) continue;
    for (const field of numericFields) columns.push(`${NUMERIC_PREFIX[kind]}${field.name}`);
  }
  if (wantsDistinct) {
    for (const field of distinctFields) columns.push(`distinct_${field.name}`);
  }

  const rows: SummaryRow[] = [];
  for (const group of groups.values()) {
    const row: SummaryRow = {};
    groupFields.forEach((field, i) => {
      row[field.name] = (group.keyValues[i] ?? null) as string | number | boolean | null;
    });
    if (aggregates.includes('count')) row['count'] = group.count;
    if (wantsArea) row['area'] = roundTo(group.areaRaw * areaFactor, 6);
    if (wantsLength) row['length'] = roundTo(group.lengthRaw, 6);
    for (const kind of ['sum', 'mean', 'min', 'max'] as const) {
      if (!aggregates.includes(kind)) continue;
      for (const field of numericFields) {
        const acc = group.numbers.get(field.name);
        const column = `${NUMERIC_PREFIX[kind]}${field.name}`;
        if (!acc || acc.count === 0) {
          // 一个有效数值都没有 → 缺测，不是 0（与 vector.spatialJoin 同一口径）
          row[column] = null;
          continue;
        }
        if (kind === 'sum') row[column] = roundTo(acc.sum, 6);
        else if (kind === 'mean') row[column] = roundTo(acc.sum / acc.count, 6);
        else if (kind === 'min') row[column] = acc.min;
        else row[column] = acc.max;
      }
    }
    if (wantsDistinct) {
      for (const field of distinctFields) {
        row[`distinct_${field.name}`] = group.distincts.get(field.name)?.size ?? 0;
      }
    }
    rows.push(row);
  }

  const caveats: string[] = [];
  if (nullGeometry > 0) {
    caveats.push(`${nullGeometry} 条要素没有几何（面积与长度按 0 算）`);
  }
  if (wantsLength && measure.kind === 'geographic') {
    caveats.push('length 的单位是度（这个图层是经纬度坐标），不是米');
  }
  if (wantsLength && measure.kind === 'unknown') {
    caveats.push('这个图层没有坐标系，length 用的是坐标单位');
  }

  const parts: string[] = [];
  parts.push(`按「${groupNames.join('、')}」分成 ${groups.size} 组`);
  parts.push(`统计项 ${aggregates.join('、')}`);
  if (wantsArea && rawAreaUnit !== undefined) {
    parts.push(`面积单位 ${areaUnitLabel(rawAreaUnit)}`);
  }
  parts.push(`共 ${read.features.length} 条要素`);
  if (dryRun) parts.push('预演：没有写盘');

  return {
    kind: 'value',
    summary: parts.join('，') + (caveats.length > 0 ? `（${caveats.join('；')}）` : ''),
    data: {
      target: targetRel,
      groupBy: groupNames,
      aggregates,
      ...(rawAreaUnit !== undefined ? { areaUnit: rawAreaUnit } : {}),
      lengthUnit: measure.unitLabel,
      featureCount: read.features.length,
      groupCount: groups.size,
      columns,
      rows,
      ...(caveats.length > 0 ? { caveats } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    },
  };
}

/**
 * 量算一个要素的几何；几何坏了就把「第几条要素」说清楚。
 *
 * 为什么不让它直接往上抛：原始消息说的是"第 3 个环的点数不足"，
 * 用户看不出是哪条要素 —— 补上要素序号才查得动。
 */
function measureGeometry(
  index: number,
  measure: (label: string) => number,
): number {
  try {
    return measure(`第 ${index + 1} 条要素`);
  } catch (err) {
    throw new VectorError(
      `第 ${index + 1} 条要素的几何坏了，算不出面积与长度：${(err as Error).message}`,
      '',
      err,
    );
  }
}
