/**
 * 兼容性自检报告。
 *
 * 用途（docs/06 §4）：最终验收者是**用户**而不是 ArcGIS。
 * 用户改完图后点一下"生成兼容性报告"，产出一份**可以直接转给 GIS 同事**的材料，
 * 让对方不用装我们的软件、也不用打开 ArcGIS，就能确认"这个文件在 Pro 里没问题"。
 *
 * 报告覆盖六块（docs/06 §4 原文）：
 *   1. 文件格式        2. 坐标系        3. 几何有效性
 *   4. 缺失的伴随文件  5. 在 ArcGIS 中打开需要注意什么   6. 本次改动的量化摘要
 *
 * 纯函数：输入探查结果 + 体检结果 + 操作记录，输出 Markdown。
 * 不读文件、不联网、不抛异常——数据不全时降级为"未检查"而不是编造。
 */
import type { DatasetInfo } from '../gdal/probe.ts';
import type { HealthReport } from '../health/checks.ts';

export interface CompatOperation {
  /** 操作名，如 raster.erase */
  readonly op: string;
  /** 目标文件 */
  readonly target: string;
  /** 影响像元数（栅格） */
  readonly affectedPixels?: number;
  /** 影响要素数（矢量） */
  readonly affectedFeatures?: number;
  /** 总像元数 / 总要素数，用于算占比 */
  readonly totalPixels?: number;
  readonly totalFeatures?: number;
  /** 备份文件相对路径 */
  readonly backupPath?: string | null;
  readonly checksumBefore?: string;
  readonly checksumAfter?: string;
}

export interface CompatReportInput {
  /** 被检查的文件（相对工作区路径） */
  readonly path: string;
  readonly dataset: DatasetInfo;
  readonly health: HealthReport;
  readonly operations?: readonly CompatOperation[];
  /** 操作人 */
  readonly operator?: string;
  /** 报告时间；不传就用调用方给的字符串（保持纯函数可测） */
  readonly at?: string;
  /** 引擎版本 */
  readonly engineVersion?: string;
}

export interface CompatReport {
  readonly markdown: string;
  /** 是否存在会阻断"在 ArcGIS 中正常使用"的问题 */
  readonly hasBlocker: boolean;
  /** 人工确认项（需要用户/GIS 同事自己看一眼的） */
  readonly manualChecks: readonly string[];
}

function fmt(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN');
}

/** 把 EPSG 授权名缩成一行人能读的描述 */
function describeCrs(dataset: DatasetInfo): { line: string; arcgisNote: string | null } {
  const { crs } = dataset;
  if (!crs.present) {
    return {
      line: '**缺失** —— 无法解析出坐标参考信息',
      arcgisNote:
        'ArcGIS 打开时会提示「坐标系未知」。此时叠加、量算面积长度、缓冲都会出错，**且不会报错**，只会给出错误结果。',
    };
  }
  const epsg = crs.epsg ? `EPSG:${crs.epsg}` : '自定义/未标注 EPSG';
  const sourceText =
    crs.source === 'embedded' ? '文件内嵌' : crs.source === 'sidecar' ? '来自同名侧车文件' : '来源未知';
  const line = `**${epsg}**（${sourceText}）`;
  let note: string | null = null;
  if (dataset.kind === 'raster' && crs.source !== 'embedded') {
    note =
      '这个栅格的坐标系不在文件内部。Esri 软件会读同名 `.prj`，但 **GTiff 驱动不会** —— ' +
      '同一份文件在 Pro 里显示正常、在别的工具里却没有坐标系。交差前建议把 CRS 内嵌进 GeoTIFF。';
  }
  return { line, arcgisNote: note };
}

/** 缺失或异常的伴随文件 */
function describeSidecars(dataset: DatasetInfo): { lines: string[]; arcgisNote: string | null } {
  const lines: string[] = [];
  let arcgisNote: string | null = null;
  if (dataset.kind === 'raster') {
    const { worldFile, prj, auxXml } = dataset.sidecars;
    lines.push(`- 世界文件 \`.tfw\`：${worldFile ? `✅ ${worldFile}` : '❌ 缺失（影像将无法定位）'}`);
    lines.push(`- 坐标系侧车 \`.prj\`：${prj ? `✅ ${prj}` : '❌ 缺失'}`);
    lines.push(`- 辅助元数据 \`.aux.xml\`：${auxXml ? `✅ ${auxXml}` : '—（非必需）'}`);
    if (!worldFile && dataset.crs.present) {
      arcgisNote = '缺少世界文件，影像在 ArcGIS 中会落到错误位置。';
    }
  } else {
    const { prj, cpg } = dataset.sidecars;
    lines.push(`- 坐标系侧车 \`.prj\`：${prj ? `✅ ${prj}` : '❌ 缺失（ArcGIS 会提示坐标系未知）'}`);
    lines.push(`- 编码标记 \`.cpg\`：${cpg ? `✅ ${cpg}` : '❌ 缺失（中文属性可能乱码）'}`);
    if (!prj) arcgisNote = '缺少 `.prj`，ArcGIS 打开时会提示坐标系未知。';
    if (!cpg) arcgisNote = (arcgisNote ? `${arcgisNote} ` : '') + '缺少 `.cpg`，不同软件会用不同编码猜中文，可能乱码。';
  }
  return { lines, arcgisNote };
}

/** 几何有效性 */
function describeGeometry(dataset: DatasetInfo, health: HealthReport): { lines: string[]; note: string | null } {
  const lines: string[] = [];
  let note: string | null = null;
  if (dataset.kind === 'vector') {
    const geo = health.findings.filter((f) => f.ruleId.startsWith('V-GEOM'));
    if (geo.length === 0) {
      lines.push('- ✅ 未发现自相交、空几何、零面积等几何问题');
    } else {
      for (const f of geo) {
        lines.push(`- ⚠️ \`${f.ruleId}\` ${f.title}${f.affectedCount !== undefined ? `（${f.affectedCount} 个要素）` : ''}`);
      }
      note =
        '几何有问题的要素在 ArcGIS 里**能显示、但做拓扑检查会报错**，做拼接/裁切也可能失败。' +
        '建议在 Pro 里跑一次「检查几何」再交付。';
    }
  } else {
    const geo = health.findings.filter((f) => f.ruleId.startsWith('R-GEO'));
    if (geo.length === 0) {
      lines.push('- ✅ 未发现栅格几何问题');
    } else {
      for (const f of geo) lines.push(`- ⚠️ \`${f.ruleId}\` ${f.title}`);
    }
  }
  return { lines, note };
}

/** 本次改动的量化摘要 */
function describeOperations(ops: readonly CompatOperation[] | undefined): string[] {
  if (!ops || ops.length === 0) return ['- 本次没有记录到修改操作（仅体检，未改数据）'];
  const lines: string[] = [];
  for (const op of ops) {
    const parts: string[] = [`- **${op.op}** → \`${op.target}\``];
    if (op.affectedPixels !== undefined) {
      const ratio =
        op.totalPixels && op.totalPixels > 0
          ? `（占 ${((op.affectedPixels / op.totalPixels) * 100).toFixed(2)}%）`
          : '';
      parts.push(`：影响像元 ${fmt(op.affectedPixels)}${ratio}`);
    }
    if (op.affectedFeatures !== undefined) {
      const ratio =
        op.totalFeatures && op.totalFeatures > 0
          ? `（占 ${((op.affectedFeatures / op.totalFeatures) * 100).toFixed(2)}%）`
          : '';
      parts.push(`：影响要素 ${fmt(op.affectedFeatures)}${ratio}`);
    }
    if (op.checksumBefore && op.checksumAfter) {
      parts.push(`｜校验和 \`${op.checksumBefore.slice(0, 12)}\` → \`${op.checksumAfter.slice(0, 12)}\``);
    }
    if (op.backupPath) parts.push(`｜备份 \`${op.backupPath}\``);
    lines.push(parts.join(''));
  }
  return lines;
}

/**
 * 生成兼容性自检报告（Markdown）。
 */
export function renderCompatReport(input: CompatReportInput): CompatReport {
  const { dataset, health } = input;
  const manualChecks: string[] = [];

  const crs = describeCrs(dataset);
  const sidecars = describeSidecars(dataset);
  const geometry = describeGeometry(dataset, health);
  const operations = describeOperations(input.operations);

  const notes: string[] = [];
  if (crs.arcgisNote) notes.push(crs.arcgisNote);
  if (sidecars.arcgisNote) notes.push(sidecars.arcgisNote);
  if (geometry.note) notes.push(geometry.note);

  // 编码提醒（矢量）
  if (dataset.kind === 'vector' && dataset.encoding && !/^utf-?8$/i.test(dataset.encoding)) {
    notes.push(
      `属性表编码是 **${dataset.encoding}**（非 UTF-8）。按声明读取没问题，` +
        '但若转成 UTF-8 再交差，该编码表示不了的生僻字会丢失或变成问号。',
    );
    manualChecks.push(`确认属性里没有生僻字（转 UTF-8 会丢）。`);
  }
  if (dataset.kind === 'vector') {
    const fieldCount = dataset.fields.length;
    if (fieldCount > 30) {
      manualChecks.push(`属性表有 ${fieldCount} 个字段，交差前确认业务只需要其中一部分。`);
    }
  }

  const blockers = health.blockers;
  const warnings = health.findings.filter((f) => f.severity === 'warn');
  const infos = health.findings.filter((f) => f.severity === 'info');

  const formatLine =
    dataset.kind === 'raster'
      ? `栅格 · 驱动 \`${dataset.driver}\` · ${dataset.width}×${dataset.height} · ${dataset.bandCount} 波段`
      : `矢量 · 驱动 \`${dataset.driver}\` · ${dataset.featureCount} 个要素 · ${dataset.geometryType ?? '未知几何'} · ${dataset.fields.length} 个字段`;

  const md: string[] = [];
  md.push(`# 兼容性自检报告`);
  md.push('');
  md.push(`> 文件：\`${input.path}\`　|　检查时间：${input.at ?? '（未提供）'}${input.operator ? `　|　操作人：${input.operator}` : ''}${input.engineVersion ? `　|　引擎：${input.engineVersion}` : ''}`);
  md.push(`> 用途：转给 GIS 同事即可确认"这份文件在 ArcGIS Pro 里没有问题"，无需安装本软件。`);
  md.push('');

  md.push(`## 结论`);
  md.push('');
  if (blockers.length === 0) {
    md.push('- ✅ **未发现阻断问题**。该文件在 ArcGIS Pro 中可以正常打开与使用。');
  } else {
    md.push(`- ⛔ **发现 ${blockers.length} 个阻断问题**，建议修复后再交付：`);
    for (const b of blockers) {
      md.push(`  - \`${b.ruleId}\` ${b.title} —— ${b.detail}`);
      // ⚠️ 必须把 hint（**怎么改**）带上。
      //    只说"缺坐标系"而不说"写回时会内嵌进 GeoTIFF"，收件人会以为这工具
      //    只会报错、修不了——报告是给对方"照着做"的材料，不是故障单。
      if (b.hint) md.push(`    - 怎么改：${b.hint}`);
    }
  }
  for (const w of warnings) md.push(`- ⚠️ ${w.title}：${w.detail}`);
  md.push('');
  // 这一段**始终输出**：没有注意事项时也要明确说"没有"，否则读者会以为漏检了。
  md.push(`**在 ArcGIS 中打开需要注意：**`);
  if (notes.length > 0) {
    for (const n of notes) md.push(`- ${n}`);
  } else {
    md.push('- 无特别注意事项：该文件的格式、坐标系、几何与伴随文件均正常。');
  }
  md.push('');

  md.push(`## 1. 文件格式`);
  md.push('');
  md.push(`- ${formatLine}`);
  md.push(`- 目录 / 驱动判定：${dataset.driver}`);
  md.push('');

  md.push(`## 2. 坐标系`);
  md.push('');
  md.push(`- ${crs.line}`);
  md.push('');

  md.push(`## 3. 几何有效性`);
  md.push('');
  for (const l of geometry.lines) md.push(l);
  md.push('');

  md.push(`## 4. 伴随文件`);
  md.push('');
  for (const l of sidecars.lines) md.push(l);
  md.push('');

  md.push(`## 5. 本次改动的量化摘要`);
  md.push('');
  for (const l of operations) md.push(l);
  md.push('');

  if (blockers.length > 0 || warnings.length > 0 || infos.length > 0) {
    md.push(`## 附：体检明细`);
    md.push('');
    // blocker 也要进明细：结论里给的是摘要，明细里给的是完整依据与建议。
    for (const f of [...blockers, ...warnings, ...infos]) {
      md.push(`- \`${f.ruleId}\` **[${f.severity}]** ${f.title} —— ${f.detail}`);
      if (f.hint) md.push(`  - 建议：${f.hint}`);
    }
    md.push('');
  }

  if (manualChecks.length > 0) {
    md.push(`## 附：需要人工确认`);
    md.push('');
    for (const c of manualChecks) md.push(`- [ ] ${c}`);
    md.push('');
  }

  md.push('---');
  md.push('');
  md.push(`*本报告由 图签 Cartouche 兼容性自检生成器自动产出；检查项覆盖文件格式、坐标系、几何有效性与伴随文件，不替代 ArcGIS Pro 的实际打开验证。*`);
  md.push('');

  return {
    markdown: md.join('\n'),
    hasBlocker: blockers.length > 0,
    manualChecks,
  };
}
