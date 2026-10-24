/**
 * 导出报告（compat-report / health-report / csv）。
 *
 * 三种 kind 的内容各不相同，但**产出形状**一致：都是"一段正文 + 若干元信息块"，
 * 再按 format 序列化成 csv / html / json。
 *
 * 为什么只有这三种：
 *   - `compat-report` —— 兼容性自检报告（交差用），正文由 report/compat-report.ts 生成；
 *   - `health-report` —— 数据体检报告，正文是体检规则的结果；
 *   - `csv` —— **数据表导出**：把矢量数据集的属性表导成 CSV
 *     （几何以 WKT 形式带上，否则导出来的表会静默丢掉空间信息）。
 *   - `change-report` / `audit-log` —— **尚未支持**：引擎这一侧还没有改动台账，
 *     执行器拿不到"本次改了哪些、备份在哪、改前改后的校验和"的记录。
 *     拿一份通用内容冒充这两种报告，比直接报错糟得多，所以这里明确报错。
 *
 * `include` 的语义：列出报告里要带的**元信息块**（机器可读的那部分）。
 * 报告正文**始终完整** —— 报告是给人照着做的材料，裁成半截就失去意义。
 * 不在该 kind 支持范围内的 include 项一律报错（并说清支持哪些），
 * 不静默忽略：被忽略的参数会让人以为报告里有那部分内容。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeDataset, type DatasetInfo } from '../gdal/probe.ts';
import { runHealthCheck, type Finding, type HealthReport } from '../health/checks.ts';
import { renderCompatReport } from '../report/compat-report.ts';
import { tools, type GdalTools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { WorkspaceAdapter } from '../workspace/types.ts';
import { csvTable, parseCsvRecords } from './csv-text.ts';
import { escapeHtml, htmlDocument, markdownToHtml } from './markdown-html.ts';

export type ReportKind = 'csv' | 'change-report' | 'health-report' | 'audit-log' | 'compat-report';
export type ReportFormat = 'csv' | 'html' | 'pdf' | 'json';

/** 契约里 export.report 的 include 取值全集 */
export const REPORT_INCLUDE_ITEMS: readonly string[] = [
  'before-after-image', 'op-list', 'impact-metrics', 'file-hashes', 'operator',
  'timestamps', 'backups', 'crs', 'sidecars', 'arcgis-notes',
];

interface KindSpec {
  readonly label: string;
  /** 该 kind 支持的输出格式 */
  readonly formats: readonly ReportFormat[];
  /** 该 kind 支持的 include 项 */
  readonly include: readonly string[];
  /** 尚未支持时的原因（写进错误消息） */
  readonly unsupportedReason?: string;
}

/**
 * 每种 kind 的能力表。
 *
 * 为什么把"哪些 include 项做得到"写成一张表而不是散在代码里：
 * 做得到的项与做不到的项必须能一眼分清 —— 做不到就报错，
 * 不能悄悄跳过（跳过等于让调用方以为报告里有那部分内容）。
 */
const KIND_SPECS: Readonly<Record<ReportKind, KindSpec>> = {
  'compat-report': {
    label: '兼容性自检报告',
    formats: ['html', 'json', 'csv'],
    include: ['file-hashes', 'crs', 'sidecars', 'timestamps'],
  },
  'health-report': {
    label: '数据体检报告',
    formats: ['html', 'json', 'csv'],
    include: ['file-hashes', 'crs', 'sidecars', 'timestamps'],
  },
  csv: {
    label: '数据表导出',
    formats: ['csv', 'html', 'json'],
    include: [],
  },
  'change-report': {
    label: '改动报告',
    formats: [],
    include: [],
    unsupportedReason:
      '引擎这一侧还没有改动台账 —— 执行器拿不到"本次改了哪些、备份在哪、改前改后的校验和"这些记录，' +
      '编一份出来就是假的。',
  },
  'audit-log': {
    label: '审计日志',
    formats: [],
    include: [],
    unsupportedReason:
      '引擎这一侧还没有审计日志的读取入口（留痕文件在项目目录里，不在工作区适配器能到的范围），' +
      '拿不到就只能编。',
  },
};

export interface ReportExportOptions {
  readonly loc: GdalLocation;
  readonly store: WorkspaceAdapter;
  /** 目标（工作区相对路径；路径闸门由调用方负责） */
  readonly target: string;
  readonly kind: ReportKind;
  readonly format: ReportFormat;
  /** 报告要带的元信息块 */
  readonly include?: readonly string[];
  /** 产出文件（工作区相对路径） */
  readonly outputPath: string;
  /** true = 只算不写（预演） */
  readonly dryRun?: boolean;
}

export interface ReportExportResult {
  readonly outputPath: string;
  readonly kind: ReportKind;
  readonly format: ReportFormat;
  /** 一句话结论 */
  readonly summary: string;
  /** 报告正文（Markdown 或 CSV 文本，按 kind） */
  readonly body: string;
  /** 体检结论（compat-report / health-report 才有） */
  readonly hasBlocker?: boolean;
  readonly manualChecks?: readonly string[];
  readonly findings?: readonly Finding[];
  readonly dryRun: boolean;
}

/**
 * 导出报告。
 *
 * 失败一律带着原因抛错：kind 尚未支持、格式不支持、include 项不支持、
 * 目标不存在、打不开、是栅格却要导属性表、转换失败 —— 都不静默降级。
 */
export async function exportReport(options: ReportExportOptions): Promise<ReportExportResult> {
  const { loc, store, target, kind, format, outputPath } = options;
  const spec = KIND_SPECS[kind];
  if (!spec) {
    throw new Error(
      `不支持的报告类型：${kind}（可选：${Object.keys(KIND_SPECS).sort().join('、')}）`,
    );
  }
  if (spec.unsupportedReason) {
    throw new Error(`该报告类型尚未支持：${kind}（${spec.unsupportedReason}）`);
  }
  if (!spec.formats.includes(format)) {
    throw new Error(
      `该报告类型不支持 ${format} 格式（${kind} 支持的是：${spec.formats.join('、')}）`,
    );
  }
  const include = options.include ?? [];
  for (const item of include) {
    if (!REPORT_INCLUDE_ITEMS.includes(item)) {
      throw new Error(
        `include 项 ${item} 不在契约里（可选值见 ops.schema.json）`,
      );
    }
    if (!spec.include.includes(item)) {
      throw new Error(
        `include 项 ${item} 在 ${kind} 里没有对应的内容` +
          `（该报告支持的 include 项：${spec.include.length > 0 ? spec.include.join('、') : '无'}）`,
      );
    }
  }
  if (!(await store.exists(target))) {
    throw new Error(`目标不存在，无法生成报告：${target}`);
  }
  const abs = store.resolve(target);

  // kind 只有三种能落到内容上：属性表（csv）、兼容性自检、数据体检。
  // 其余两种（改动报告 / 审计日志）引擎侧没有数据来源 —— 上面已经报过"尚未支持"，
  // 这里再兜一次是为了把类型收窄到可实现的分支上。
  const built =
    kind === 'csv'
      ? await buildTableReport(loc, store, target, abs, include)
      : kind === 'compat-report' || kind === 'health-report'
        ? await buildInspectionReport(loc, store, target, abs, include, kind)
        : (() => {
            throw new Error(
              `该报告类型尚未支持：${kind}（${spec.unsupportedReason ?? '引擎侧还没有这类报告的数据来源'}）`,
            );
          })();

  const text = serialize(built, format);
  if (!options.dryRun) {
    await writeOutput(store, outputPath, text);
  }
  return {
    outputPath,
    kind,
    format,
    summary: built.summary,
    body: built.body,
    ...(built.hasBlocker !== undefined ? { hasBlocker: built.hasBlocker } : {}),
    ...(built.manualChecks ? { manualChecks: built.manualChecks } : {}),
    ...(built.findings ? { findings: built.findings } : {}),
    dryRun: options.dryRun === true,
  };
}

/* ── 报告内容 ─────────────────────────────────────────────────── */

/** 一段元信息：给 HTML 表格、JSON 键、CSV 列用的都是同一份 */
interface MetaRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

interface BuiltReport {
  readonly summary: string;
  /** 正文（Markdown 或 CSV 文本） */
  readonly body: string;
  /** 正文之外的附加块（体检明细表等） */
  readonly findings?: readonly Finding[];
  readonly meta: readonly MetaRow[];
  readonly hasBlocker?: boolean;
  readonly manualChecks?: readonly string[];
  /** 数据表（kind='csv' 时有） */
  readonly records?: ReadonlyArray<Record<string, string>>;
  /** 数据表的表头（kind='csv' 时有） */
  readonly columns?: readonly string[];
}

/**
 * 兼容性自检报告 / 数据体检报告。
 *
 * 两种 kind 共用同一套采集（探查 + 体检），差别只在正文：
 * compatibility 走 report/compat-report.ts 的交差正文，health 只给规则明细。
 */
async function buildInspectionReport(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  target: string,
  abs: string,
  include: readonly string[],
  kind: 'compat-report' | 'health-report',
): Promise<BuiltReport> {
  const { dataset, error } = await probeDataset(loc, abs);
  if (!dataset) {
    throw new Error(
      `打不开数据集，无法生成报告：${target}（${error?.message ?? '未知原因'}）`,
    );
  }
  const health = await runHealthCheck(loc, abs);
  const at = localTimestamp();
  const meta = await buildMetaRows(store, target, abs, dataset, include, at);

  if (kind === 'health-report') {
    const blockers = health.blockers.length;
    const errors = health.findings.filter((f) => f.severity === 'error').length;
    const warnings = health.findings.filter((f) => f.severity === 'warn').length;
    const body = healthMarkdown(target, at, health);
    return {
      summary: `体检：${blockers} 条阻断项、${errors} 条错误、${warnings} 条提示`,
      body,
      findings: health.findings,
      meta,
      hasBlocker: blockers > 0,
      manualChecks: [],
    };
  }

  const compat = renderCompatReport({ path: target, dataset, health, at });
  return {
    summary: compat.hasBlocker
      ? `兼容性自检报告：有阻断项，需修复后再交付`
      : `兼容性自检报告：未发现阻断问题`,
    body: compat.markdown,
    findings: health.findings,
    meta,
    hasBlocker: compat.hasBlocker,
    manualChecks: compat.manualChecks,
  };
}

/**
 * 数据表导出（kind='csv'）。
 *
 * 用 ogr2ogr 的 CSV 驱动出属性表，并**带上几何（WKT）**：
 * 默认的 CSV 驱动会把几何丢掉，那导出来的表看着正常、其实空间信息没了。
 */
async function buildTableReport(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  target: string,
  abs: string,
  include: readonly string[],
): Promise<BuiltReport> {
  const { dataset, error } = await probeDataset(loc, abs);
  if (!dataset) {
    throw new Error(
      `打不开数据集，无法导出数据表：${target}（${error?.message ?? '未知原因'}）`,
    );
  }
  if (dataset.kind !== 'vector') {
    throw new Error(
      `CSV 导出的是属性表，目标必须是矢量数据集；${target} 是栅格，没有属性表。`,
    );
  }
  const gdal = tools(loc);
  const outDir = mkdtempSync(join(tmpdir(), 'cartouche-csv-'));
  let csvText: string;
  try {
    // 多图层数据集必须先拦下来：CSV 驱动一次只写一个图层，
    // 剩下的会被静默丢掉 —— 那等于导出了一份缺数据的表。
    const layerCount = await countLayers(gdal, abs);
    if (layerCount > 1) {
      throw new Error(
        `数据集里有 ${layerCount} 个图层，一次只能导出一个；请先拆成单图层数据集。`,
      );
    }
    // ⚠️ ogr2ogr 的参数顺序是 **dst 在前、src 在后**（与 ogrinfo 相反）。
    //    CSV 驱动的目标必须是**文件**（给目录会被当成已存在的同名文件而报错）。
    const outCsv = join(outDir, 'table.csv');
    const res = await gdal.ogr2ogr(['-f', 'CSV', '-lco', 'GEOMETRY=AS_WKT', outCsv, abs]);
    if (!res.ok) {
      throw new Error(`导出属性表失败：${target}（${res.stderr.trim() || '未知原因'}）`);
    }
    if (!existsSync(outCsv)) {
      throw new Error(`转换命令成功但没有产出 CSV 文件：${target}`);
    }
    csvText = readFileSync(outCsv, 'utf8');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

  const records = parseCsvRecords(csvText);
  const columns = records.length > 0 ? Object.keys(records[0]!) : [];
  const at = localTimestamp();
  const meta = await buildMetaRows(store, target, abs, dataset, include, at);
  return {
    summary: `导出属性表：${records.length} 条记录、${columns.length} 个字段`,
    body: csvText,
    records,
    columns,
    meta,
  };
}

/**
 * 组装元信息块。
 *
 * 只放该 kind 明确支持的项；不做"没要就悄悄补上"的事 ——
 * 报告里出现调用方没要的内容，会让人以为那些内容是查出来的结论。
 */
async function buildMetaRows(
  store: WorkspaceAdapter,
  target: string,
  abs: string,
  dataset: DatasetInfo,
  include: readonly string[],
  at: string,
): Promise<MetaRow[]> {
  const rows: MetaRow[] = [];
  for (const item of include) {
    if (item === 'file-hashes') {
      const stat = await store.stat(target);
      const bytes = await store.read(target);
      const sha = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
      rows.push({ key: 'file', label: '文件', value: `${target}（${stat.size} 字节）` });
      rows.push({ key: 'sha256', label: 'SHA-256', value: sha });
    } else if (item === 'crs') {
      const { crs } = dataset;
      const epsg = crs.epsg !== undefined ? `EPSG:${crs.epsg}` : epsgFromWkt(crs.wkt);
      const source =
        crs.source === 'embedded' ? '文件内嵌' : crs.source === 'sidecar' ? '来自侧车文件' : '来源未知';
      rows.push({
        key: 'crs',
        label: '坐标系',
        value: crs.present ? `${epsg}（${source}）` : '缺失',
      });
    } else if (item === 'sidecars') {
      const parts: string[] = [];
      if (dataset.kind === 'raster') {
        const sc = dataset.sidecars;
        if (sc.worldFile) parts.push(`世界文件 ${sc.worldFile}`);
        if (sc.prj) parts.push(`坐标系侧车 ${sc.prj}`);
        if (sc.auxXml) parts.push(`辅助元数据 ${sc.auxXml}`);
      } else {
        const sc = dataset.sidecars;
        if (sc.prj) parts.push(`坐标系侧车 ${sc.prj}`);
        if (sc.cpg) parts.push(`编码标记 ${sc.cpg}`);
      }
      rows.push({
        key: 'sidecars',
        label: '伴随文件',
        value: parts.length > 0 ? parts.join('；') : '无',
      });
    } else if (item === 'timestamps') {
      rows.push({ key: 'at', label: '报告时间', value: at });
    }
  }
  return rows;
}

/* ── 序列化 ───────────────────────────────────────────────────── */

/** 按目标格式把报告序列化 */
function serialize(built: BuiltReport, format: ReportFormat): string {
  if (format === 'json') {
    return `${JSON.stringify(
      {
        ...(built.columns ? { columns: built.columns } : {}),
        ...(built.records ? { records: built.records } : {}),
        ...(built.findings ? { findings: built.findings } : {}),
        ...(built.hasBlocker !== undefined ? { hasBlocker: built.hasBlocker } : {}),
        ...(built.manualChecks ? { manualChecks: built.manualChecks } : {}),
        metadata: Object.fromEntries(built.meta.map((m) => [m.key, m.value])),
        body: built.body,
      },
      null,
      2,
    )}\n`;
  }
  if (format === 'html') {
    return htmlDocument(reportTitle(built), htmlBody(built));
  }
  if (format === 'csv') {
    return csvBody(built);
  }
  throw new Error(`该报告类型不支持 ${format} 格式`);
}

function reportTitle(built: BuiltReport): string {
  const file = built.meta.find((m) => m.key === 'file')?.value ?? '';
  return file ? `报告 — ${file}` : '报告';
}

/** HTML 正文：元信息表 + 正文 + 体检明细表 */
function htmlBody(built: BuiltReport): string {
  const parts: string[] = [];
  if (built.meta.length > 0) {
    parts.push('<table>');
    parts.push('<tr><th>项目</th><th>内容</th></tr>');
    for (const m of built.meta) {
      parts.push(`<tr><td>${escapeHtml(m.label)}</td><td>${escapeHtml(m.value)}</td></tr>`);
    }
    parts.push('</table>');
  }
  if (built.records) {
    parts.push('<table>');
    parts.push(
      `<tr>${(built.columns ?? []).map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`,
    );
    for (const rec of built.records) {
      parts.push(
        `<tr>${(built.columns ?? [])
          .map((c) => `<td>${escapeHtml(rec[c] ?? '')}</td>`)
          .join('')}</tr>`,
      );
    }
    parts.push('</table>');
  }
  if (built.findings) {
    parts.push('<h2>体检明细</h2>');
    parts.push('<table>');
    parts.push('<tr><th>规则</th><th>级别</th><th>问题</th><th>说明</th><th>怎么改</th></tr>');
    for (const f of built.findings) {
      parts.push(
        `<tr><td><code>${escapeHtml(f.ruleId)}</code></td>` +
          `<td>${escapeHtml(f.severity)}</td>` +
          `<td>${escapeHtml(f.title)}</td>` +
          `<td>${escapeHtml(f.detail)}</td>` +
          `<td>${escapeHtml(f.hint ?? '')}</td></tr>`,
      );
    }
    parts.push('</table>');
  }
  parts.push(`<section>${markdownToHtml(built.body)}</section>`);
  return parts.join('\n');
}

/**
 * CSV 正文。
 *
 * kind='csv' 时正文就是属性表本身（列与行都按 OGR 写出来的那张表）。
 * 体检类报告的 CSV 是**规则明细表**，元信息块作为额外的列附在每一行上 ——
 * 扁平表里没有"元信息"的位置，附成列是最不容易丢信息的做法。
 */
function csvBody(built: BuiltReport): string {
  if (built.records) {
    return built.body.endsWith('\n') ? built.body : `${built.body}\n`;
  }
  const metaColumns = built.meta.map((m) => m.key);
  const header = [...metaColumns, 'ruleId', 'severity', 'title', 'detail', 'hint'];
  const rows = (built.findings ?? []).map((f) => [
    ...built.meta.map((m) => m.value),
    f.ruleId,
    f.severity,
    f.title,
    f.detail,
    f.hint ?? '',
  ]);
  if (rows.length === 0 && metaColumns.length > 0) {
    // 一条规则都没有时也把元信息带出去：只给一个表头的 CSV 等于把信息全丢了
    rows.push([...built.meta.map((m) => m.value), '', '', '', '', '']);
  }
  // 一条规则都没有、也没要元信息时，**只留表头**：
  // 补一条全空的记录会被下游当成"有一条空记录"。
  return csvTable(header, rows);
}

/** 体检报告的 Markdown 正文 */
function healthMarkdown(target: string, at: string, health: HealthReport): string {
  const md: string[] = [];
  md.push('# 数据体检报告');
  md.push('');
  md.push(`> 文件：\`${target}\`　|　检查时间：${at}`);
  md.push('');
  md.push('## 结论');
  md.push('');
  if (health.passed) {
    md.push('- ✅ 未发现阻断问题。');
  } else {
    md.push(`- ⛔ 发现 ${health.blockers.length} 个阻断问题：`);
    for (const b of health.blockers) {
      md.push(`  - \`${b.ruleId}\` ${b.title} —— ${b.detail}`);
      if (b.hint) md.push(`    - 怎么改：${b.hint}`);
    }
  }
  md.push('');
  md.push(`## 体检明细（${health.findings.length} 条）`);
  md.push('');
  if (health.findings.length === 0) {
    // 零结论不等于「都查过没问题」—— 没查的那几项要单独说清楚。
    const notChecked = (health.coverage ?? []).filter((c) => c.status !== 'checked');
    md.push(
      notChecked.length === 0
        ? '- 已执行的检查项都没发现问题。'
        : `- 已执行的检查项都没发现问题；但有 ${notChecked.length} 项**没查**（见下方「未执行的检查」）。`,
    );
  } else {
    for (const f of health.findings) {
      md.push(`- \`${f.ruleId}\` **[${f.severity}]** ${f.title} —— ${f.detail}`);
      if (f.hint) md.push(`  - 建议：${f.hint}`);
    }
  }
  md.push('');

  // 「没查」必须写出来。
  //
  // 体检报告里一句「未发现自相交」会被读成「查过自相交、没问题」——
  // 而引擎可能压根没查这一项。这个仓库在这件事上栽过：
  // 曾经写「✅ 未发现自相交、空几何、零面积等几何问题」，而自相交从来没被查过。
  const coverage = health.coverage ?? [];
  const notChecked = coverage.filter((c) => c.status !== 'checked');
  if (notChecked.length > 0) {
    md.push(`## 未执行的检查（${notChecked.length} 项）`);
    md.push('');
    md.push('下面这些**没有查**，所以不能算「未发现问题」：');
    md.push('');
    for (const c of notChecked) {
      const label =
        c.status === 'skipped'
          ? '未执行'
          : c.status === 'not-applicable'
            ? '不适用'
            : '未实现';
      md.push(`- \`${c.check}\` —— ${label}${c.reason ? `：${c.reason}` : ''}`);
    }
    md.push('');
  }

  return md.join('\n');
}

/* ── 工具 ─────────────────────────────────────────────────────── */

/**
 * 从 WKT 里取 EPSG 授权码。
 *
 * 为什么不用探查结果里的 crs.epsg 就完事：gdalinfo -json 给的
 * `coordinateSystem.id` 是**对象**（{"authority":"EPSG","code":4326}），
 * 而探查模块只认字符串形式，于是 crs.epsg 常常是空的 ——
 * 报告里写「无授权码」会让人以为文件真的没标坐标系。
 * 这里退回从 WKT 里取**最后一个** ID["EPSG",N]（口径与 raster-image.ts 一致：
 * 投影坐标系的 WKT 里基准 CRS 的 ID 排在前面，取第一个会认错）。
 */
function epsgFromWkt(wkt: string | undefined): string {
  if (!wkt) return '无授权码';
  const ids = [...wkt.matchAll(/ID\["EPSG",(\d+)\]/g)].map((m) => Number(m[1]));
  if (ids.length === 0) return '无授权码';
  return `EPSG:${ids[ids.length - 1]!}`;
}

/** 数一数数据集里有几个图层（拿不到就按 1 走，后面的转换失败会自己报错） */
async function countLayers(gdal: GdalTools, path: string): Promise<number> {
  const res = await gdal.ogrInfo(['-json', path]);
  if (!res.ok) return 1;
  try {
    const j = JSON.parse(res.stdout) as { layers?: unknown[] };
    return Array.isArray(j.layers) ? j.layers.length : 1;
  } catch {
    return 1;
  }
}

/** 给人看的本地时间 */
function localTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 写盘；失败要把原因说出来（空间不足、目录写不了…） */
async function writeOutput(
  store: WorkspaceAdapter,
  outputPath: string,
  text: string,
): Promise<void> {
  try {
    await store.write(outputPath, new TextEncoder().encode(text));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOSPC') {
      throw new Error(`磁盘空间不足，报告未写出：${outputPath}`);
    }
    throw new Error(`写入报告失败：${outputPath}（${(err as Error).message}）`);
  }
}
