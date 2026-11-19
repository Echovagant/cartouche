/**
 * 超大 GeoPackage 的原生分组汇总。
 *
 * 常规路径把整层要素读成 GeoJSON，再在 JS 里分组累计 —— GB 级数据会爆内存。
 * GeoPackage 底层是 SQLite，分组、计数、求和、去重都能用 `GROUP BY` 完成；
 * 面积与长度用 SpatiaLite 的 `ST_Area` / `ST_Length`（实测与引擎的
 * 平面鞋带公式、环周长口径一致，包含带洞面的洞边）。
 *
 * 口径对齐的细节：
 *  - 数值列里的非数字值：引擎**跳过**，SQL 也用 `typeof` 过滤后 SUM/AVG；
 *  - 空几何：引擎按 0 算，SQL 用 `COALESCE(..., 0)`；
 *  - 分组顺序：引擎按首次出现顺序，SQL 用 `MIN(fid)` 排序还原文件顺序；
 *  - 面积 / 长度的结果在 JS 里做与普通路径相同的 `roundTo(..., 6)`。
 */
import type { OpValueResult } from '../ops/executor.ts';
import { roundTo } from '../expression/index.ts';
import { areaUnitLabel } from '../feature/measure.ts';
import type { GdalLocation } from '../gdal/env.ts';
import { VectorError, type LayerField, type LayerInfo } from './types.ts';
import { gpkgCount, gpkgQuery, gpkgTableContext, quoteIdent } from './gpkg-native.ts';

/** 汇总表里一行 */
type SummaryRow = Record<string, string | number | boolean | null>;

/** 数值统计项的输出列前缀（与普通路径一致） */
const NUMERIC_PREFIX: Readonly<Record<'sum' | 'mean' | 'min' | 'max', string>> = {
  sum: 'sum_',
  mean: 'mean_',
  min: 'min_',
  max: 'max_',
};

/** 分组太多时一次出表会撑爆界面与内存，明确拒绝而不是悄悄截断 */
const MAX_STREAM_GROUPS = 100000;

export interface StreamSummarizeInput {
  readonly targetRel: string;
  readonly absPath: string;
  readonly info: LayerInfo;
  readonly groupFields: readonly LayerField[];
  readonly groupNames: readonly string[];
  readonly aggregates: readonly string[];
  readonly numericFields: readonly LayerField[];
  readonly distinctFields: readonly LayerField[];
  readonly wantsArea: boolean;
  readonly wantsLength: boolean;
  readonly rawAreaUnit?: string;
  /** 坐标单位² → 目标面积单位的换算系数（与普通路径同一个值） */
  readonly areaFactor: number;
  /** length 的单位说明（坐标单位 / 度） */
  readonly lengthUnit: string;
  /** length 的坐标系性质（用于 caveat） */
  readonly measureKind: 'geographic' | 'projected' | 'unknown';
  readonly dryRun: boolean;
}

/** 数值列的安全聚合：非数字按 NULL 处理，SUM/AVG 的行为与引擎的"跳过"一致 */
function numericAgg(kind: 'sum' | 'mean' | 'min' | 'max', column: string): string {
  const inner =
    `CASE WHEN typeof(${quoteIdent(column)}) IN ('integer','real') ` +
    `THEN ${quoteIdent(column)} ELSE NULL END`;
  if (kind === 'sum') return `SUM(${inner})`;
  if (kind === 'mean') return `AVG(${inner})`;
  if (kind === 'min') return `MIN(${inner})`;
  return `MAX(${inner})`;
}

/** 原生分组汇总 */
export async function gpkgStreamSummarize(
  loc: GdalLocation,
  input: StreamSummarizeInput,
): Promise<OpValueResult> {
  const table = await gpkgTableContext(loc, input.absPath, input.info.layerName);
  const geom = table.geometryColumn ? quoteIdent(table.geometryColumn) : 'NULL';
  const areaExpr = `COALESCE(ST_Area(${geom}), 0)`;
  const lengthExpr = `COALESCE(ST_Length(${geom}), 0)`;

  const select: string[] = [];
  const groupAliases = input.groupFields.map((f, i) => {
    const alias = `__g${i}`;
    select.push(`${quoteIdent(f.name)} AS ${quoteIdent(alias)}`);
    return alias;
  });
  select.push('COUNT(*) AS "__count"');
  if (input.wantsArea) select.push(`SUM(${areaExpr}) AS "__area"`);
  if (input.wantsLength) select.push(`SUM(${lengthExpr}) AS "__length"`);

  const numericKinds = ['sum', 'mean', 'min', 'max'] as const;
  for (const kind of numericKinds) {
    if (!input.aggregates.includes(kind)) continue;
    input.numericFields.forEach((f, i) => {
      select.push(`${numericAgg(kind, f.name)} AS ${quoteIdent(`__${kind}_${i}`)}`);
    });
  }
  if (input.aggregates.includes('distinct')) {
    input.distinctFields.forEach((f, i) => {
      select.push(`COUNT(DISTINCT ${quoteIdent(f.name)}) AS ${quoteIdent(`__distinct_${i}`)}`);
    });
  }
  select.push(`MIN(${quoteIdent(table.fidColumn)}) AS "__ord"`);

  const groupBy = input.groupFields.map((f) => quoteIdent(f.name)).join(', ');
  const sql =
    `SELECT ${select.join(', ')} FROM ${quoteIdent(table.layerName)} ` +
    (input.groupFields.length > 0 ? `GROUP BY ${groupBy} ` : '') +
    `ORDER BY "__ord" LIMIT ${MAX_STREAM_GROUPS + 1}`;
  const rawRows = await gpkgQuery(loc, input.absPath, sql);
  if (rawRows.length > MAX_STREAM_GROUPS) {
    throw new VectorError(
      `分组太多（超过 ${MAX_STREAM_GROUPS} 组），一次出表会撑爆界面与内存。` +
        '请减少分组字段、先按范围拆分，或把文件拆小后再汇总。',
    );
  }

  const total = await gpkgCount(loc, input.absPath, table.layerName);
  const nullGeometry =
    input.wantsArea || input.wantsLength
      ? table.geometryColumn
        ? await gpkgCount(
            loc,
            input.absPath,
            table.layerName,
            `${quoteIdent(table.geometryColumn)} IS NULL`,
          )
        : total
      : 0;

  /* ── 列名：与普通路径完全一致 ───────────────────────────────── */
  const columns: string[] = [...input.groupNames];
  if (input.aggregates.includes('count')) columns.push('count');
  if (input.wantsArea) columns.push('area');
  if (input.wantsLength) columns.push('length');
  for (const kind of numericKinds) {
    if (!input.aggregates.includes(kind)) continue;
    for (const field of input.numericFields) columns.push(`${NUMERIC_PREFIX[kind]}${field.name}`);
  }
  if (input.aggregates.includes('distinct')) {
    for (const field of input.distinctFields) columns.push(`distinct_${field.name}`);
  }

  const rows: SummaryRow[] = rawRows.map((raw) => {
    const row: SummaryRow = {};
    input.groupNames.forEach((name, i) => {
      row[name] = (raw[groupAliases[i]!] ?? null) as string | number | boolean | null;
    });
    if (input.aggregates.includes('count')) row['count'] = Number(raw['__count'] ?? 0);
    if (input.wantsArea) {
      row['area'] = roundTo(Number(raw['__area'] ?? 0) * input.areaFactor, 6);
    }
    if (input.wantsLength) {
      row['length'] = roundTo(Number(raw['__length'] ?? 0), 6);
    }
    for (const kind of numericKinds) {
      if (!input.aggregates.includes(kind)) continue;
      input.numericFields.forEach((field, i) => {
        const value = raw[`__${kind}_${i}`];
        const column = `${NUMERIC_PREFIX[kind]}${field.name}`;
        if (value === null || value === undefined) {
          row[column] = null;
        } else if (kind === 'min' || kind === 'max') {
          row[column] = Number(value);
        } else {
          row[column] = roundTo(Number(value), 6);
        }
      });
    }
    if (input.aggregates.includes('distinct')) {
      input.distinctFields.forEach((field, i) => {
        row[`distinct_${field.name}`] = Number(raw[`__distinct_${i}`] ?? 0);
      });
    }
    return row;
  });

  const caveats: string[] = [];
  if (nullGeometry > 0) {
    caveats.push(`${nullGeometry} 条要素没有几何（面积与长度按 0 算）`);
  }
  if (input.wantsLength && input.measureKind === 'geographic') {
    caveats.push('length 的单位是度（这个图层是经纬度坐标），不是米');
  }
  if (input.wantsLength && input.measureKind === 'unknown') {
    caveats.push('这个图层没有坐标系，length 用的是坐标单位');
  }
  caveats.push('超大图层用数据库原生汇总，分组按文件顺序');

  const parts: string[] = [];
  parts.push(`按「${input.groupNames.join('、')}」分成 ${rows.length} 组`);
  parts.push(`统计项 ${input.aggregates.join('、')}`);
  if (input.wantsArea && input.rawAreaUnit !== undefined) {
    parts.push(`面积单位 ${areaUnitLabel(input.rawAreaUnit)}`);
  }
  parts.push(`共 ${total} 条要素`);
  if (input.dryRun) parts.push('预演：没有写盘');

  return {
    kind: 'value',
    summary: parts.join('，') + (caveats.length > 0 ? `（${caveats.join('；')}）` : ''),
    data: {
      target: input.targetRel,
      groupBy: input.groupNames,
      aggregates: input.aggregates,
      ...(input.rawAreaUnit !== undefined ? { areaUnit: input.rawAreaUnit } : {}),
      lengthUnit: input.lengthUnit,
      featureCount: total,
      groupCount: rows.length,
      columns,
      rows,
      ...(caveats.length > 0 ? { caveats } : {}),
      ...(input.dryRun ? { dryRun: true } : {}),
      streamed: true,
    },
  };
}
