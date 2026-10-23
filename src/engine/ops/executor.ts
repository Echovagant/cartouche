/**
 * 操作计划调度器（栅格编辑闭环）。
 *
 * 一份计划 = 一串 op。调度器的职责只有四件，**一件都不多**：
 *   1. 逐条执行；
 *   2. 每条给出**量化影响**（改了多少像元、改前改后的校验和、备份在哪）；
 *   3. 失败**不回滚** —— 已完成的条目照常生效，报告里写清"已完成 N 条、第 K 条失败"；
 *   4. 没实现的 op 明确说"该操作尚未支持"，**不静默跳过**。
 *
 * 为什么失败不回滚：单条 op 的写回是原子的（临时文件 → 原子替换 → 回读校验），
 * 一条失败不会把文件改坏到"半截状态"。这时把前面几条一起撤掉，
 * 反而会让用户手里的文件和报告对不上 —— 报告说的是"改了 2 处"，
 * 磁盘上却回到 0 处，那才叫说不清。
 *
 * 两套输入形状都收：
 *   - 计划文档 `{ version, intent?, ops: [...] }`（ops.schema.json 里的那个形状）
 *   - 单条 `{ op, params }`（模板产出的形状）
 */
import { randomBytes } from 'node:crypto';
import { RasterEditor, type OverviewOutcome, type RasterOpResult } from '../raster/index.ts';
import {
  buildPixelMask,
  geoToPixelRegion,
  regionHitsRaster,
  regionOffRasterMessage,
  zeroImpactMessage,
  type GeoBounds,
  type PixelMask,
  type PixelRegion,
} from '../raster/mask.ts';
import { probeDataset, type DatasetInfo } from '../gdal/probe.ts';
import { runVectorQuery } from '../vector/query.ts';
import { runVectorAddField } from '../vector/field.ts';
import { runVectorSpatialJoin } from '../vector/spatial-join.ts';
import { runVectorReproject } from '../vector/reproject.ts';
import { runVectorRenameFields } from '../vector/rename-fields.ts';
import { runVectorRecode } from '../vector/recode.ts';
import {
  runFeatureSetAttributes,
  runFeatureDelete,
  runFeatureSummarize,
} from '../feature/index.ts';
import { runHealthCheck } from '../health/checks.ts';
import { renderCompatReport } from '../report/compat-report.ts';
import {
  exportImage,
  exportReport,
  isImageExportFormat,
  IMAGE_EXPORT_EXTENSIONS,
  IMAGE_EXPORT_FORMATS,
} from '../export/index.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { WorkspaceAdapter } from '../workspace/index.ts';

/* ── 对外类型 ─────────────────────────────────────────────── */

export interface OperationSpec {
  readonly op: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** 执行前的前置条件（如 crsEqual / sourceExists） */
  readonly preconditions?: Readonly<Record<string, unknown>>;
  /** 执行前的预期上限；超出则中止并报告 */
  readonly expect?: Readonly<Record<string, unknown>>;
  /** 涉及删除、批量修改时必须人工确认 */
  readonly requireUserConfirm?: boolean;
}

export interface PlanDocument {
  readonly version?: string;
  readonly intent?: string;
  readonly ops: readonly OperationSpec[];
}

export interface OpImpact {
  readonly affectedPixels: number;
  readonly totalPixels: number;
  /** 受影响比例 0~1 */
  readonly affectedRatio: number;
  readonly backupPath: string | null;
  readonly verified: boolean;
  readonly checksumBefore: string;
  readonly checksumAfter: string;
  readonly width: number;
  readonly height: number;
  readonly bandCount: number;
  /**
   * 金字塔这一步的结果（写回之后建没建成）。
   *
   * 为什么放进影响面：金字塔建不起来**不影响**改图本身（不能因此判整次操作失败），
   * 但界面会因此"影像还是卡"，原因必须能查 —— 所以它跟着结果一路回到界面。
   */
  readonly overview?: OverviewOutcome;
  /** true = 这是预演的结果，文件没被写过 */
  readonly dryRun?: boolean;
}

/**
 * 非栅格型 op 的结果。
 *
 * 为什么需要它：执行器的影响面模型是**像元**形状的（改了多少像元、校验和…），
 * 而"打开数据集""做体检""快照"这类 op 不改像元 ——
 * 硬塞一个 affectedPixels: 0 进去，只会被"改了 0 像元就是失败"那道闸门误杀。
 */
export interface OpValueResult {
  readonly kind: 'value';
  /** 一句话结论，进报告与确认卡 */
  readonly summary: string;
  /** 产出文件（工作区相对路径）；没有产出就不要这个字段 */
  readonly outputPath?: string;
  /** 结构化结果 */
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface OpExecutionRecord {
  readonly index: number;
  readonly op: string;
  readonly ok: boolean;
  readonly target: string;
  /** 该 op 尚未实现 */
  readonly unimplemented?: boolean;
  /** 栅格型 op 的影响面；非栅格型 op 不填 */
  readonly impact?: OpImpact;
  /** 非栅格型 op 的结果（打开 / 体检 / 快照）：与 impact 二选一 */
  readonly value?: OpValueResult;
  readonly error?: string;
}

export interface PlanExecutionResult {
  readonly ok: boolean;
  readonly results: readonly OpExecutionRecord[];
  /** 成功执行的条数 */
  readonly completed: number;
  /** 失败那条的下标（0 起）；没有失败则不存在 */
  readonly failedAt?: number;
}

export interface ExecutorDeps {
  readonly loc: GdalLocation;
  readonly store: WorkspaceAdapter;
  /**
   * 用户是否已经在确认卡上点过确认。
   *
   * 计划里 `requireUserConfirm: true` 的 op 必须拿到它才动手 ——
   * 这是契约里那个字段在引擎侧唯一的落点（2026-10-23 实测：
   * 改之前它只是接口声明，executePlan 从不读，等于没有这道闸门）。
   */
  readonly confirmed?: boolean;
}

/** 计划文档或单条 op —— 两种形状都能收 */
export type PlanInput = PlanDocument | OperationSpec;

/* ── op 注册表 ─────────────────────────────────────────────── */

interface OpHandler {
  /** 中文名，给报告和确认卡用 */
  readonly label: string;
  /**
   * 能不能预演。
   * GDAL 级操作（裁切 / 重采样 / 拼接）要真的产出临时文件才知道影响面，
   * 预演不了 —— 这种 op 在预演时直接说"该操作无法预演影响面"，
   * 而不是给一个假的像元数。
   */
  readonly previewable: boolean;
  /**
   * true = affectedPixels 是「真正被改动的像元数」，
   *        0 就意味着这次什么都没改 —— 必须判失败
   *        （「改了 0 像元却报成功」是最严重的一类缺陷）。
   * false = affectedPixels 只是产出规模（拼接）或粗略对比（GDAL 级操作），
   *        0 不代表失败。
   *
   * 非栅格型 op（打开 / 体检 / 快照）不走像元口径，这条对它没有意义。
   */
  readonly countsChangedPixels: boolean;
  run(
    editor: RasterEditor,
    params: Readonly<Record<string, unknown>>,
    dryRun: boolean,
    /**
     * 工作区与 GDAL 环境。
     *
     * 为什么放在最后：非栅格型 op 不碰栅格编辑器，需要的是 store（路径闸门）
     * 与 loc（探查 / 体检）。放在末尾就不用改已有那八个 handler 的签名。
     */
    deps: ExecutorDeps,
  ): Promise<RasterOpResult | OpValueResult>;
}

/* ── 数据集类 op 的常量 ─────────────────────────────────────── */

/**
 * 契约里 `dataset.healthCheck` 的 checks 取值全集。
 *
 * 为什么在这里再抄一份而不是读 ops.schema.json：
 * 引擎的运行时产物（dist）不带 schema 文件，读它会把 JSON 拖进运行期依赖。
 * 抄一份的风险是**漂移** —— schema 改了这里没改就会把合法检查项当成非法值拒掉，
 * 所以 `npm run check:schema` 要盯着这一处。
 */
const HEALTH_CHECK_NAMES: readonly string[] = [
  'crs-present', 'crs-mismatch', 'crs-range-sanity', 'axis-order', 'extent-plausibility',
  'systematic-offset', 'encoding', 'field-naming', 'field-type', 'default-fields',
  'null-geometry', 'zero-area', 'sharp-angle', 'outlier-extent', 'extent-compare',
];

/**
 * 检查项 → 引擎里对应的规则前缀。
 *
 * R- 前缀的规则只对栅格生效，V- 前缀的只对矢量生效。
 * 没出现在这张表里的检查项 = 引擎还没做，不是"检查了没问题"。
 */
const HEALTH_CHECK_RULES: Readonly<Record<string, readonly string[]>> = {
  'crs-present': ['R-CRS-', 'V-CRS-'],
  'encoding': ['V-ENC-'],
  'field-naming': ['V-FIELD-002'],
  'default-fields': ['V-FIELD-001'],
  'null-geometry': ['V-GEOM-001'],
  'zero-area': ['V-GEOM-002'],
};

/** 快照目录（工作区相对路径） */
const SNAPSHOT_ROOT = '_snapshots';

/**
 * 产出物目录（工作区相对路径）。
 *
 * 为什么落在隐藏目录里：导出物是**派生结果**，不是用户的数据。
 * 混在数据目录里，用户一打开文件夹就分不清哪个是原图、哪个是导出的图；
 * 放进 `.cartouche/outputs/` 与项目清单（project/store.ts）里的产出物口径一致。
 */
const OUTPUT_ROOT = '.cartouche/outputs';

/**
 * 契约里 export.report 的 kind 取值全集。
 *
 * 与 IMAGE_EXPORT_FORMATS 一样，这里抄一份而不是读 ops.schema.json：
 * 引擎的运行时产物（dist）不带 schema 文件。
 */
const REPORT_KINDS: readonly string[] = [
  'csv', 'change-report', 'health-report', 'audit-log', 'compat-report',
];

/** 契约里 export.report 的 format 取值全集 */
const REPORT_FORMATS: readonly string[] = ['csv', 'html', 'pdf', 'json'];

/** 报告格式 → 文件扩展名 */
const REPORT_EXTENSIONS: Readonly<Record<string, string>> = {
  csv: 'csv',
  html: 'html',
  pdf: 'pdf',
  json: 'json',
};

/**
 * 数据伴随文件的后缀白名单。
 *
 * 判定口径：与主文件**同名**（同一主名）、后缀不同、且后缀在下表里。
 * 锁标记（.lock / .lck）**不在**下表里 —— 它们表示"数据正被 ArcGIS 打开"，
 * 拷进快照只会让人误以为快照里也有一份数据被锁着。
 *
 * 为什么把 Shapefile 的数据部件也算进来：Shapefile 是多文件数据集，
 * 只拷 .shp 会得到一个**打不开**的快照 —— 那不是快照，是半个数据集。
 */
const DATA_SIDECAR_SUFFIXES: readonly string[] = [
  // 坐标系与编码标记
  '.prj', '.cpg',
  // 世界文件
  '.tfw', '.wld', '.tifw', '.jgw',
  // 辅助元数据
  '.aux.xml',
  // Shapefile 的数据部件
  '.shx', '.dbf', '.sbn', '.sbx', '.qix', '.fbn', '.fbx', '.ain', '.aih', '.ixs', '.mxs', '.atx',
];

/**
 * 已实现的 op。
 *
 * 这里只登记**引擎里真的能跑**的。schema 里的 26 个 op 里，
 * 几何写回类（feature.create / feature.editGeometry / vector.repairGeometry
 * 与 vector.overlay）尚未实现；export.* 的两个（出图 / 出报告）
 * 在这里落地 —— 它们**不改像元**，产出的是文件，走的是非栅格型结果那条路。
 * dataset.* 的三个（打开 / 体检 / 快照）同样是值结果。
 */
const IMPLEMENTED: Readonly<Record<string, OpHandler>> = {
  'dataset.open': {
    label: '打开数据集',
    previewable: true,
    countsChangedPixels: false,
    run: async (_editor, params, _dryRun, deps) => {
      const targets = requireStringArray(params, 'targets');
      const purpose = readString(params, 'purpose');
      const opened: Array<{ readonly rel: string; readonly info: DatasetInfo }> = [];
      for (const raw of targets) {
        const rel = toRelPathChecked(raw, 'targets');
        // 路径闸门在这里生效：绝对路径与 .. 都过不去
        const { dataset, error } = await probeDataset(deps.loc, deps.store.resolve(rel));
        if (!dataset) {
          // 任一目标打不开 → 整个 op 失败，并点名是哪个目标。
          // 只报一半等于让调用方以为其余的都打开了。
          throw new Error(`打不开数据集：${rel}（${error?.message ?? '未知原因'}）`);
        }
        opened.push({ rel, info: dataset });
      }
      return {
        kind: 'value',
        summary: `打开 ${opened.length} 个数据集：${opened
          .map(({ rel, info }) => `${stemOf(rel)}（${describeDatasetKind(info)}）`)
          .join('、')}`,
        data: {
          datasets: opened.map(({ rel, info }) => datasetRecord(rel, info)),
          ...(purpose ? { purpose } : {}),
        },
      };
    },
  },
  'dataset.healthCheck': {
    label: '数据体检',
    previewable: true,
    countsChangedPixels: false,
    run: async (_editor, params, _dryRun, deps) => {
      const rel = requireTarget(params);
      const checks = requireStringArray(params, 'checks');
      const unknown = checks.filter((c) => !HEALTH_CHECK_NAMES.includes(c));
      if (unknown.length > 0) {
        throw new Error(
          `参数 checks 里有契约里没有的检查项：${unknown.join('、')}（可选值见 ops.schema.json）`,
        );
      }
      const abs = deps.store.resolve(rel);
      // 体检内部自己探查一次；渲染兼容性报告还要 DatasetInfo，所以这里探查两遍。
      // 探查失败必须报错 —— 拿不到数据集就没有"体检结论"可言。
      const { dataset, error } = await probeDataset(deps.loc, abs);
      if (!dataset) {
        throw new Error(`打不开数据集，无法体检：${rel}（${error?.message ?? '未知原因'}）`);
      }
      const health = await runHealthCheck(deps.loc, abs);
      const compat = renderCompatReport({ path: rel, dataset, health, at: localTimestamp() });

      // 契约里的 15 项检查，引擎只实现了其中一部分。
      // 三种状态要分清：查了 / 这类数据集没有这项检查的适用面 / 引擎还没做。
      // 混成一句"检查通过"就是骗人。
      const covered: string[] = [];
      const notApplicable: string[] = [];
      const unsupported: string[] = [];
      for (const c of checks) {
        const rules = HEALTH_CHECK_RULES[c];
        if (!rules) {
          unsupported.push(c);
        } else if (rulesApplies(rules, dataset.kind)) {
          covered.push(c);
        } else {
          notApplicable.push(c);
        }
      }
      const blockers = health.blockers.length;
      const errors = health.findings.filter((f) => f.severity === 'error').length;
      const warnings = health.findings.filter((f) => f.severity === 'warn').length;
      const caveats: string[] = [];
      if (unsupported.length > 0) {
        caveats.push(`请求的 ${unsupported.join('、')} 引擎尚未实现，未检查`);
      }
      if (notApplicable.length > 0) {
        caveats.push(`${notApplicable.join('、')} 对${dataset.kind === 'raster' ? '栅格' : '矢量'}不适用`);
      }
      return {
        kind: 'value',
        summary:
          `体检：${blockers} 条阻断项、${errors} 条错误、${warnings} 条提示` +
          (caveats.length > 0 ? `（${caveats.join('；')}）` : ''),
        data: {
          path: rel,
          kind: dataset.kind,
          driver: dataset.driver,
          passed: health.passed,
          hasBlocker: compat.hasBlocker,
          manualChecks: compat.manualChecks,
          requestedChecks: checks,
          coveredChecks: covered,
          notApplicableChecks: notApplicable,
          unsupportedChecks: unsupported,
          findings: health.findings.map((f) => ({
            ruleId: f.ruleId,
            severity: f.severity,
            title: f.title,
            ...(f.hint ? { hint: f.hint } : {}),
          })),
          markdown: compat.markdown,
        },
      };
    },
  },
  'dataset.snapshot': {
    label: '快照',
    previewable: true,
    countsChangedPixels: false,
    run: async (_editor, params, dryRun, deps) => {
      const rel = requireTarget(params);
      const label = readString(params, 'label');
      const includeSidecars = readBoolean(params, 'includeSidecars') ?? true;
      const abs = deps.store.resolve(rel);
      if (!(await deps.store.exists(rel))) {
        throw new Error(`目标不存在，无法快照：${rel}`);
      }
      const sidecars = includeSidecars ? await findDataSidecars(deps.store, rel) : [];
      // 目录名带时间戳：同一份数据要能反复快照，不能互相覆盖。
      // 预演算出来的目录名与真正落盘时差一个时刻 —— 快照目录本来就由执行时刻决定。
      const dirName = await uniqueSnapshotDir(
        deps.store,
        `${sanitizeLabel(label ?? 'snapshot')}-${timestamp()}`,
      );
      const snapshotDir = `${SNAPSHOT_ROOT}/${dirName}`;
      const outputPath = `${snapshotDir}/${baseNameOf(rel)}`;
      if (!dryRun) {
        // 预演绝不落盘：确认卡上点一下就留下快照文件，这个"预演"就是假的
        await copySnapshotFile(deps.store, rel, outputPath);
        for (const sc of sidecars) {
          await copySnapshotFile(deps.store, sc.path, `${snapshotDir}/${sc.name}`);
        }
      }
      const copiedSidecars = sidecars.map((sc) => `${snapshotDir}/${sc.name}`);
      return {
        kind: 'value',
        summary:
          `${dryRun ? '将快照' : '已快照'}：${rel} → ${outputPath}` +
          `（${sidecars.length} 个伴随文件）`,
        outputPath,
        data: {
          target: rel,
          directory: snapshotDir,
          label: label ?? 'snapshot',
          includeSidecars,
          files: [outputPath, ...copiedSidecars],
          sidecars: copiedSidecars,
          dryRun,
        },
      };
    },
  },
  'export.image': {
    label: '导出图片',
    previewable: true,
    countsChangedPixels: false,
    run: async (_editor, params, dryRun, deps) => {
      const rel = requireTarget(params);
      const format = readString(params, 'format');
      if (format === undefined) {
        throw new Error(`缺少参数 format（可选：${IMAGE_EXPORT_FORMATS.join('、')}）`);
      }
      if (!isImageExportFormat(format)) {
        throw new Error(
          `不支持的导出格式：${format}（可选：${IMAGE_EXPORT_FORMATS.join('、')}）`,
        );
      }
      const dpi = readNumber(params, 'dpi');
      if (dpi !== undefined && (!Number.isInteger(dpi) || dpi < 72 || dpi > 1200)) {
        throw new Error(`dpi 必须是 72~1200 之间的整数，实为 ${dpi}`);
      }
      const bbox = readBbox4326(params);
      const layers = params['layers'];
      if (layers !== undefined && layers !== null) {
        if (!Array.isArray(layers)) {
          throw new Error('参数 layers 必须是数组');
        }
        if (layers.length > 0) {
          // layers 指的是图层标识，引擎这一侧没有图层树 —— 明确说"尚未支持"，
          // 不拿单幅栅格冒充合成结果。
          throw new Error(
            '多图层合成（layers）尚未支持：引擎只认 dataset:// 开头的工作区相对路径，没有图层树。',
          );
        }
      }
      // 文件名带执行时刻：同一份数据要能反复导出而不互相覆盖。
      const outputPath = `${OUTPUT_ROOT}/${stemOf(rel)}-${timestamp()}.${IMAGE_EXPORT_EXTENSIONS[format]}`;
      const res = await exportImage({
        loc: deps.loc,
        store: deps.store,
        target: rel,
        format,
        outputPath,
        dryRun,
        ...(bbox ? { bbox } : {}),
        ...(dpi !== undefined ? { dpi } : {}),
      });
      return {
        kind: 'value',
        summary:
          `${dryRun ? '将导出图片' : '已导出图片'}：${rel} → ${outputPath}` +
          `（${format.toUpperCase()}，${res.width}×${res.height}）`,
        outputPath,
        data: {
          target: rel,
          format,
          outputPath,
          width: res.width,
          height: res.height,
          byteLength: res.byteLength,
          ...(bbox ? { bbox } : {}),
          ...(dpi !== undefined ? { dpi } : {}),
          dryRun,
        },
      };
    },
  },
  'export.report': {
    label: '导出报告',
    previewable: true,
    countsChangedPixels: false,
    run: async (_editor, params, dryRun, deps) => {
      const kind = readString(params, 'kind');
      if (kind === undefined) {
        throw new Error(`缺少参数 kind（可选：${REPORT_KINDS.join('、')}）`);
      }
      if (!REPORT_KINDS.includes(kind)) {
        throw new Error(`不支持的报告类型：${kind}（可选：${REPORT_KINDS.join('、')}）`);
      }
      const format = readString(params, 'format') ?? 'html';
      if (!REPORT_FORMATS.includes(format)) {
        throw new Error(`不支持的报告格式：${format}（可选：${REPORT_FORMATS.join('、')}）`);
      }
      // 契约里 target 是可选的，但引擎实现的每一种报告都要有对象：
      // 兼容性自检、体检、属性表导出都得针对一个数据集。
      const rel = requireRelPath(params, 'target');
      const include = readOptionalStringArray(params, 'include');
      const outputPath = `${OUTPUT_ROOT}/${stemOf(rel)}-${timestamp()}.${REPORT_EXTENSIONS[format] ?? 'txt'}`;
      const res = await exportReport({
        loc: deps.loc,
        store: deps.store,
        target: rel,
        kind: kind as Parameters<typeof exportReport>[0]['kind'],
        format: format as Parameters<typeof exportReport>[0]['format'],
        outputPath,
        dryRun,
        ...(include ? { include } : {}),
      });
      return {
        kind: 'value',
        summary: `${dryRun ? '将导出报告' : '已导出报告'}：${rel} → ${outputPath}（${res.summary}）`,
        outputPath,
        data: {
          target: rel,
          kind,
          format,
          outputPath,
          summary: res.summary,
          // 正文只给 Markdown 类的报告；kind='csv' 的正文是整张属性表，
          // 可能有成千上万行，塞进结果里会把确认卡撑爆。
          ...(kind === 'csv' ? {} : { body: res.body }),
          ...(res.hasBlocker !== undefined ? { hasBlocker: res.hasBlocker } : {}),
          ...(res.manualChecks ? { manualChecks: res.manualChecks } : {}),
          ...(res.findings ? { findings: res.findings } : {}),
          ...(include ? { include } : {}),
          dryRun,
        },
      };
    },
  },
  'vector.query': {
    label: '属性查询',
    previewable: true,
    // 不改像元：命中 0 条是合法结果（条件太窄），不是"什么都没做"
    countsChangedPixels: false,
    run: async (_editor, params, _dryRun, deps) =>
      runVectorQuery(params, { loc: deps.loc, store: deps.store }),
  },
  'vector.addField': {
    label: '计算字段',
    previewable: true,
    countsChangedPixels: false,
    run: async (_editor, params, dryRun, deps) =>
      runVectorAddField(params, { loc: deps.loc, store: deps.store }, dryRun),
  },
  'vector.spatialJoin': {
    label: '空间连接',
    previewable: true,
    countsChangedPixels: false,
    run: async (_editor, params, dryRun, deps) =>
      runVectorSpatialJoin(params, { loc: deps.loc, store: deps.store }, dryRun),
  },
  'vector.reproject': {
    label: '重投影',
    previewable: true,
    countsChangedPixels: false,
    run: async (_editor, params, dryRun, deps) =>
      runVectorReproject(params, { loc: deps.loc, store: deps.store }, dryRun),
  },
  'vector.renameFields': {
    label: '重命名字段',
    previewable: true,
    countsChangedPixels: false,
    run: async (_editor, params, dryRun, deps) =>
      runVectorRenameFields(params, { loc: deps.loc, store: deps.store }, dryRun),
  },
  'vector.recode': {
    label: '重编码',
    previewable: true,
    countsChangedPixels: false,
    run: async (_editor, params, dryRun, deps) =>
      runVectorRecode(params, { loc: deps.loc, store: deps.store }, dryRun),
  },
  'feature.setAttributes': {
    label: '按条件改属性',
    previewable: true,
    // 不改像元：命中 0 条是合法结果（条件太窄），不是"什么都没做"
    countsChangedPixels: false,
    run: async (_editor, params, dryRun, deps) =>
      runFeatureSetAttributes(params, { loc: deps.loc, store: deps.store }, dryRun),
  },
  'feature.delete': {
    label: '按条件删要素',
    previewable: true,
    countsChangedPixels: false,
    run: async (_editor, params, dryRun, deps) =>
      runFeatureDelete(params, { loc: deps.loc, store: deps.store }, dryRun),
  },
  'feature.summarize': {
    label: '分组汇总',
    previewable: true,
    // 汇总只读不写：没有像元口径
    countsChangedPixels: false,
    run: async (_editor, params, dryRun, deps) =>
      runFeatureSummarize(params, { loc: deps.loc, store: deps.store }, dryRun),
  },
  'raster.paint': {
    label: '涂色',
    previewable: true,
    countsChangedPixels: true,
    run: async (editor, params, dryRun) => {
      const mask = readMask(params);
      return editor.paint(
        {
          target: requireTarget(params),
          region: requireRegion(params),
          color: requireColor(params),
          ...(mask ? { mask } : {}),
        },
        { dryRun },
      );
    },
  },
  'raster.erase': {
    label: '擦除',
    previewable: true,
    countsChangedPixels: true,
    run: async (editor, params, dryRun) => {
      const source = readRelPath(params, 'source');
      return editor.erase(
        {
          target: requireTarget(params),
          region: requireRegion(params),
          ...(source ? { source } : {}),
        },
        { dryRun },
      );
    },
  },
  'raster.replaceRegion': {
    label: '区域替换',
    previewable: true,
    countsChangedPixels: true,
    run: async (editor, params, dryRun) => {
      const bbox = readBbox(params);
      // region 缺省时必须给 undefined，不能给一个零区域：
      // 零区域会把「region ?? bbox 换算」里的 bbox 分支挡掉，
      // 结果是预演与执行都报 ok，却一个像元都没改。
      const region = requireRegion(params, { optional: true });
      const featherPx = readNumber(params, 'featherPx');
      return editor.replaceRegion(
        {
          source: requireRelPath(params, 'source'),
          target: requireTarget(params),
          ...(region ? { region } : {}),
          ...(bbox ? { bbox } : {}),
          ...(featherPx !== undefined ? { featherPx } : {}),
        },
        { dryRun },
      );
    },
  },
  'raster.inpaint': {
    label: '边界修补',
    previewable: true,
    countsChangedPixels: true,
    run: async (editor, params, dryRun) => {
      const radiusPx = readNumber(params, 'radiusPx');
      return editor.inpaint(
        {
          target: requireTarget(params),
          region: requireRegion(params),
          ...(radiusPx !== undefined ? { radiusPx } : {}),
        },
        { dryRun },
      );
    },
  },
  'raster.adjustLevels': {
    label: '亮度对比度调整',
    previewable: true,
    countsChangedPixels: true,
    run: async (editor, params, dryRun) => {
      const method = readString(params, 'method');
      const brightness = readNumber(params, 'brightness');
      const contrast = readNumber(params, 'contrast');
      const gamma = readNumber(params, 'gamma');
      return editor.adjustLevels(
        {
          target: requireTarget(params),
          ...(method ? { method: method as 'linear-stretch' | 'gamma' | 'manual' } : {}),
          ...(brightness !== undefined ? { brightness } : {}),
          ...(contrast !== undefined ? { contrast } : {}),
          ...(gamma !== undefined ? { gamma } : {}),
        },
        { dryRun },
      );
    },
  },
  'raster.clip': {
    label: '裁切',
    previewable: false,
    countsChangedPixels: false,
    run: async (editor, params) => {
      const bbox = readBbox(params);
      const clip = readRelPath(params, 'clip');
      // 两个范围都不给 → gdalwarp 会原样复制一张，等于「裁了但没裁」还报成功。
      // 这里明确报错，不让静默的空跑混过去。
      if (!bbox && !clip) {
        throw new Error('必须给出裁切范围（bbox 或 clip）：都不给的话只会把原图原样复制一遍');
      }
      return editor.clip({
        target: requireTarget(params),
        ...(bbox ? { bbox } : {}),
        ...(clip ? { clip } : {}),
      });
    },
  },
  'raster.resample': {
    label: '重采样',
    previewable: false,
    countsChangedPixels: false,
    run: async (editor, params) => {
      const targetResolution = readNumber(params, 'targetResolution');
      const resampleMethod = readString(params, 'resampleMethod');
      return editor.resample({
        target: requireTarget(params),
        ...(targetResolution !== undefined ? { targetResolution } : {}),
        ...(resampleMethod ? { resampleMethod: resampleMethod as 'nearest' | 'bilinear' | 'cubic' | 'average' } : {}),
      });
    },
  },
  'raster.mosaic': {
    label: '拼接',
    previewable: false,
    countsChangedPixels: false,
    run: async (editor, params) => {
      const inputs = params['inputs'];
      if (!Array.isArray(inputs) || inputs.length < 2) {
        throw new Error('拼接至少需要两幅影像');
      }
      const output = readString(params, 'output');
      // 拼接的输入输出同样是工作区里的文件，路径也要过闸门：
      // 绝对路径与 .. 会让它读到工作区之外（其余 op 早就是这么做的，
      // 只有拼接漏了 —— 2026-10-23 实测：`C:/Windows/System32/...` 能被放行）。
      return editor.mosaic({
        inputs: inputs.map((x) => toRelPathChecked(String(x), 'inputs')),
        ...(output ? { output: toRelPathChecked(output, 'output') } : {}),
      });
    },
  },
};

/** 已实现的 op 名字 */
export function listImplementedOps(): string[] {
  return Object.keys(IMPLEMENTED).sort();
}

/* ── 计划归一化 ───────────────────────────────────────────── */

/**
 * 把两种输入形状统一成"一份计划"。
 *
 * 单条 op 直接包成一条计划 —— 快捷路径和完整路径走**同一段代码**，
 * 免得两条路各修一半、行为不一致。
 */
export function normalizePlan(input: PlanInput): PlanDocument {
  if (Array.isArray((input as PlanDocument).ops)) {
    const p = input as PlanDocument;
    return {
      ...(p.version !== undefined ? { version: p.version } : {}),
      ...(p.intent !== undefined ? { intent: p.intent } : {}),
      ops: p.ops,
    };
  }
  const single = input as OperationSpec;
  if (typeof single?.op !== 'string') {
    throw new Error('操作计划格式不对：需要 { op, params } 或 { version, ops: [...] }');
  }
  return { ops: [single] };
}

/* ── 预演与执行 ───────────────────────────────────────────── */

/**
 * 预演一条 op：**不写盘**，只算出影响面。
 *
 * 确认卡要在用户点头之前报出"会影响多少像元"。如果这里给的是估算值，
 * 确认卡就成了摆设 —— 用户看到的数字和真执行对不上，闸门形同虚设。
 */
export async function previewOp(deps: ExecutorDeps, spec: OperationSpec): Promise<OpExecutionRecord> {
  const handler = IMPLEMENTED[spec.op];
  const target = targetOf(spec);
  if (!handler) {
    return {
      index: 0,
      op: spec.op,
      ok: false,
      target,
      unimplemented: true,
      error: `该操作尚未支持：${spec.op}`,
    };
  }
  if (!handler.previewable) {
    return {
      index: 0,
      op: spec.op,
      ok: false,
      target,
      error: `该操作无法预演影响面（${handler.label}需要真的产出文件才能知道改了什么）；确认后可直接执行。`,
    };
  }
  try {
    const params = await normalizeParams(deps, spec);
    const editor = new RasterEditor({ loc: deps.loc, store: deps.store });
    const result = await handler.run(editor, params, true, deps);
    return {
      index: 0,
      op: spec.op,
      ok: true,
      target,
      ...outcomeOf(verdictOf(handler, result, params)),
    };
  } catch (err) {
    return { index: 0, op: spec.op, ok: false, target, error: messageOf(err) };
  }
}

/**
 * 执行一份计划。
 *
 * 逐条执行；**第一条失败就停**（后面的 op 依赖前面的结果，盲目继续只会越改越乱），
 * 但**已经完成的不回滚**。
 */
export async function executePlan(deps: ExecutorDeps, input: PlanInput): Promise<PlanExecutionResult> {
  const plan = normalizePlan(input);
  const editor = new RasterEditor({ loc: deps.loc, store: deps.store });
  const results: OpExecutionRecord[] = [];
  let completed = 0;
  let failedAt: number | undefined;

  for (let i = 0; i < plan.ops.length; i++) {
    const spec = plan.ops[i]!;
    const target = targetOf(spec);
    const handler = IMPLEMENTED[spec.op];

    if (!handler) {
      // 没实现的 op 不静默跳过：明确写出来，并就地停下
      results.push({
        index: i,
        op: spec.op,
        ok: false,
        target,
        unimplemented: true,
        error: `该操作尚未支持：${spec.op}`,
      });
      failedAt = i;
      break;
    }

    let params: Readonly<Record<string, unknown>>;
    try {
      params = await normalizeParams(deps, spec);
    } catch (err) {
      results.push({ index: i, op: spec.op, ok: false, target, error: messageOf(err) });
      failedAt = i;
      break;
    }

    // 人工确认闸门：契约里 requireUserConfirm 为 true 的 op 必须真的拿到确认。
    // 确认卡点过「确认执行」时才会带 confirmed；没带就不许动手。
    if (spec.requireUserConfirm === true && deps.confirmed !== true) {
      results.push({
        index: i,
        op: spec.op,
        ok: false,
        target,
        error: '该操作要求人工确认（requireUserConfirm），没有收到确认，已中止；未做任何改动。',
      });
      failedAt = i;
      break;
    }

    // 预期上限要在**动手之前**核对，所以先预演一次
    const cap = readNumber(spec.expect ?? {}, 'maxAffectedPixels');
    let impact: OpImpact | undefined;
    if (cap !== undefined) {
      if (!handler.previewable) {
        results.push({
          index: i,
          op: spec.op,
          ok: false,
          target,
          error: `该操作无法预演影响面，无法核对 maxAffectedPixels 上限（${handler.label}）；已中止，未做任何改动。`,
        });
        failedAt = i;
        break;
      }
      try {
        const preview = await handler.run(editor, params, true, deps);
        const outcome = verdictOf(handler, preview, params);
        if (isValueResult(outcome)) {
          // 非栅格型 op 不改像元，像元上限无从核对 —— 明确报出来，
          // 不能悄悄跳过这道闸门（那等于让用户以为上限被核对过了）
          results.push({
            index: i,
            op: spec.op,
            ok: false,
            target,
            value: outcome,
            error:
              `maxAffectedPixels 上限只对像素级操作有效；${handler.label} 不改像元，无法核对上限，` +
              '已中止；未做任何改动。',
          });
          failedAt = i;
          break;
        }
        impact = outcome;
        if (impact.affectedPixels > cap) {
          results.push({
            index: i,
            op: spec.op,
            ok: false,
            target,
            impact,
            error:
              `实际影响 ${impact.affectedPixels} 个像元，超出预期上限 ${cap}，已中止；` +
              '前面已完成的条目照常生效，不会回滚。',
          });
          failedAt = i;
          break;
        }
      } catch (err) {
        results.push({ index: i, op: spec.op, ok: false, target, error: messageOf(err) });
        failedAt = i;
        break;
      }
    }

    try {
      const result = await handler.run(editor, params, false, deps);
      results.push({
        index: i,
        op: spec.op,
        ok: true,
        target,
        ...outcomeOf(verdictOf(handler, result, params)),
      });
      completed++;
    } catch (err) {
      results.push({ index: i, op: spec.op, ok: false, target, error: messageOf(err) });
      failedAt = i;
      break;
    }
  }

  return {
    ok: failedAt === undefined,
    results,
    completed,
    ...(failedAt !== undefined ? { failedAt } : {}),
  };
}

/* ── 数据集类 op 的工具 ─────────────────────────────────────── */

/** 相对路径里的主名（不含扩展名） */
function stemOf(rel: string): string {
  const base = baseNameOf(rel);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 相对路径里的文件名（含扩展名） */
function baseNameOf(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** 相对路径里的目录（没有目录时是空串） */
function dirOf(rel: string): string {
  const slash = rel.lastIndexOf('/');
  return slash >= 0 ? rel.slice(0, slash) : '';
}

/** 一句话描述数据集的规模，给 summary 用 */
function describeDatasetKind(info: DatasetInfo): string {
  return info.kind === 'raster'
    ? `栅格 ${info.width}×${info.height}`
    : `矢量 ${info.featureCount} 个要素`;
}

/**
 * 数据集信息（工作区相对路径口径）。
 *
 * 探查返回的是**绝对路径**（探查发生在工作区根之下），直接放进结果会让报告里
 * 出现本机路径 —— 结果是要给人看、也可能外发的，所以这里换成相对路径，
 * 尺寸、波段、要素、字段、坐标系这些量一律照抄探查结果，不自己重算。
 */
function datasetRecord(rel: string, info: DatasetInfo): Record<string, unknown> {
  const crs = {
    present: info.crs.present,
    source: info.crs.source,
    ...(info.crs.epsg !== undefined ? { epsg: info.crs.epsg } : {}),
    ...(info.crs.authority !== undefined ? { authority: info.crs.authority } : {}),
  };
  if (info.kind === 'raster') {
    return {
      path: rel,
      kind: 'raster',
      driver: info.driver,
      width: info.width,
      height: info.height,
      bandCount: info.bandCount,
      bandTypes: info.bandTypes,
      nodata: info.nodata,
      geotransform: info.geotransform,
      pixelSize: info.pixelSize,
      crs,
    };
  }
  return {
    path: rel,
    kind: 'vector',
    driver: info.driver,
    layerName: info.layerName,
    featureCount: info.featureCount,
    fieldCount: info.fields.length,
    fields: info.fields.map((f) => ({ name: f.name, type: f.type })),
    geometryType: info.geometryType,
    encoding: info.encoding,
    crs,
  };
}

/** 规则前缀是否对这类数据集适用（R- 只对栅格，V- 只对矢量） */
function rulesApplies(rulePrefixes: readonly string[], kind: 'raster' | 'vector'): boolean {
  return rulePrefixes.some((p) => (kind === 'raster' ? p.startsWith('R-') : p.startsWith('V-')));
}

/**
 * 找出与主文件同名的数据伴随文件。
 *
 * 判据：同目录 + 同一主名 + 后缀在白名单里。
 * 锁标记（.lock / .lck）不在白名单 —— 它们是"数据正被打开"的信号，
 * 拷进快照会误导人以为快照里的数据也被锁着。
 */
async function findDataSidecars(
  store: WorkspaceAdapter,
  rel: string,
): Promise<Array<{ readonly name: string; readonly path: string }>> {
  const dir = dirOf(rel);
  const stem = stemOf(rel);
  const base = baseNameOf(rel);
  let siblings: string[];
  try {
    siblings = await store.list(dir);
  } catch (err) {
    // 读不到目录就说不清有没有伴随文件 —— 不能当成"没有伴随文件"糊弄过去
    throw new Error(`读取目标目录失败，无法识别伴随文件：${dir || '.'}（${messageOf(err)}）`);
  }
  const out: Array<{ readonly name: string; readonly path: string }> = [];
  for (const name of siblings) {
    if (name === base) continue;
    if (!name.startsWith(`${stem}.`)) continue;
    const lower = name.toLowerCase();
    if (lower.endsWith('.lock') || lower.endsWith('.lck')) continue;
    if (!DATA_SIDECAR_SUFFIXES.some((ext) => lower.endsWith(ext))) continue;
    out.push({ name, path: dir ? `${dir}/${name}` : name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 快照目录名去重：同一秒内做两次快照也要各自独立 */
async function uniqueSnapshotDir(store: WorkspaceAdapter, name: string): Promise<string> {
  if (await store.exists(`${SNAPSHOT_ROOT}/${name}`)) {
    return `${name}.${randomBytes(3).toString('hex')}`;
  }
  return name;
}

/**
 * 快照标签清洗。
 *
 * 标签会进目录名，所以必须挡住路径分隔符与 .. ——
 * 快照目录只允许落在工作区里，不能被标签带到别处去。
 */
function sanitizeLabel(label: string): string {
  const cleaned = label
    .replace(/[^\w.\-㐀-鿿]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 60);
  return cleaned || 'snapshot';
}

/** 复制一个快照文件；失败要把原因说出来（空间不足、源文件没了…） */
async function copySnapshotFile(
  store: WorkspaceAdapter,
  fromRel: string,
  toRel: string,
): Promise<void> {
  try {
    await store.copy(fromRel, toRel);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOSPC') {
      throw new Error(`磁盘空间不足，快照未完成：${fromRel} → ${toRel}`);
    }
    if (code === 'ENOENT') {
      throw new Error(`快照源文件已消失：${fromRel}`);
    }
    throw new Error(`复制快照文件失败：${fromRel} → ${toRel}（${messageOf(err)}）`);
  }
}

/** 时间戳（与备份文件名的口径一致：20261023-200000） */
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 给人看的本地时间（兼容性报告抬头用） */
function localTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/* ── 内部工具 ─────────────────────────────────────────────── */

/**
 * 一次 op 的结论。
 *
 * **「改了 0 像元」不是成功，是什么都没做。**
 * 对像素级操作来说，affectedPixels === 0 就意味着这次改动没落到任何像元上
 * （区域落在影像之外、掩膜没覆盖到东西……）—— 这种情况一律判失败。
 *
 * 判断放在这里，预演与执行共用同一段代码：
 * 之前预演如实报 0、执行却无条件 ok:true，两边结论对不上，
 * 确认卡上那个「0 / 192 像元（0.0%）」看着像"最轻松的改动"，点下去却什么都不会发生。
 *
 * 非栅格型 op（打开 / 体检 / 快照）**不适用**这条规则：它们本来就不改像元，
 * 拿"0 像元"去判它们，等于把一次正常的体检报成失败。
 */
function verdictOf(
  handler: OpHandler,
  result: RasterOpResult | OpValueResult,
  params: Readonly<Record<string, unknown>>,
): OpImpact | OpValueResult {
  if (isValueResult(result)) return result;
  const impact = toImpact(result);
  if (!handler.countsChangedPixels || impact.affectedPixels > 0) return impact;
  const region = pixelRegionOf(params['region']);
  if (region && !regionHitsRaster(region, impact.width, impact.height)) {
    throw new Error(regionOffRasterMessage(region, impact.width, impact.height));
  }
  throw new Error(zeroImpactMessage(impact.width, impact.height, region));
}

/**
 * 非栅格型结果的判别。
 *
 * 参数放宽到 object：栅格型结论（OpImpact）与栅格型原始结果（RasterOpResult）
 * 都要拿它判，而这三者之间没有继承关系，只能靠有没有 kind 字段区分。
 */
function isValueResult(r: object): r is OpValueResult {
  return (r as { kind?: string }).kind === 'value';
}

/** 把结论摊到执行记录上：栅格型给 impact，非栅格型给 value */
function outcomeOf(outcome: OpImpact | OpValueResult): {
  readonly impact?: OpImpact;
  readonly value?: OpValueResult;
} {
  return isValueResult(outcome) ? { value: outcome } : { impact: outcome };
}

/** 从参数里读出一个像元区域（地理范围数组在 normalizeParams 里已换算成对象） */
function pixelRegionOf(raw: unknown): PixelRegion | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const minX = Number(o['minX']);
  const minY = Number(o['minY']);
  const maxX = Number(o['maxX']);
  const maxY = Number(o['maxY']);
  if (![minX, minY, maxX, maxY].every((x) => Number.isFinite(x))) return undefined;
  return { minX, minY, maxX, maxY };
}

function toImpact(r: RasterOpResult): OpImpact {
  return {
    affectedPixels: r.affectedPixels,
    totalPixels: r.totalPixels,
    affectedRatio: r.totalPixels > 0 ? r.affectedPixels / r.totalPixels : 0,
    backupPath: r.backupPath,
    verified: r.verified,
    checksumBefore: r.checksumBefore,
    checksumAfter: r.checksumAfter,
    width: r.width,
    height: r.height,
    bandCount: r.bandCount,
    ...(r.overview ? { overview: r.overview } : {}),
    ...(r.dryRun !== undefined ? { dryRun: r.dryRun } : {}),
  };
}

/**
 * 把 `dataset://x.tff` 这类引用剥成工作区相对路径。
 *
 * `layer://` / `summary://` 指的是图层标识，不是文件路径 —— 这里不猜，
 * 直接报错让调用方给一个能落地的路径。
 */
function toRelPath(raw: string): string {
  const m = /^(?:dataset|layer|summary):\/\/(.+)$/.exec(raw);
  if (m) {
    if (!/^dataset:\/\//.test(raw)) {
      throw new Error(
        `目标引用不是文件路径（${raw}）；引擎只能处理 dataset:// 开头的工作区相对路径`,
      );
    }
    return m[1]!;
  }
  return raw;
}

/** 目标路径（相对项目根）：绝对路径一律拒绝 */
function requireTarget(params: Readonly<Record<string, unknown>>): string {
  return requireRelPath(params, 'target');
}

function requireRelPath(params: Readonly<Record<string, unknown>>, key: string): string {
  const raw = readString(params, key);
  if (raw === undefined) throw new Error(`缺少参数 ${key}`);
  return toRelPathChecked(raw, key);
}

/** 可选的相对路径参数：不给就没有，给了就得是安全的相对路径 */
function readRelPath(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const raw = readString(params, key);
  if (raw === undefined) return undefined;
  return toRelPathChecked(raw, key);
}

function toRelPathChecked(raw: string, key: string): string {
  const rel = toRelPath(raw);
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) {
    throw new Error(
      `${key} 必须是相对路径，不能是绝对路径：${raw}（绝对路径不在已登记的工作区根之下）`,
    );
  }
  if (rel.split(/[\\/]/).includes('..')) {
    throw new Error(`${key} 不能包含 .. ：${raw}（这样的路径不在已登记的工作区根之下）`);
  }
  return rel;
}

/** 目标路径（只用于报告展示）：剥 scheme，不做安全校验 */
function targetOf(spec: OperationSpec): string {
  const raw = spec.params['target'];
  if (typeof raw === 'string' && raw.trim() !== '') return stripScheme(raw);
  // dataset.open 这类 op 用的是 targets 数组：报告里要看得见它打开了哪些文件
  const targets = spec.params['targets'];
  if (Array.isArray(targets)) {
    const names = targets
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      .map((x) => stripScheme(x));
    if (names.length > 0) return names.join('、');
  }
  return '';
}

/** 剥掉 dataset:// / layer:// / summary:// 前缀 */
function stripScheme(raw: string): string {
  const m = /^(?:dataset|layer|summary):\/\/(.+)$/.exec(raw);
  return m?.[1] ?? raw;
}

function readString(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** 字符串数组参数（如 dataset.open 的 targets）：至少一项，每项都要是非空字符串 */
function requireStringArray(params: Readonly<Record<string, unknown>>, key: string): string[] {
  const raw = params[key];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`缺少参数 ${key}（至少要给一项）`);
  }
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== 'string' || x.trim() === '') {
      throw new Error(`参数 ${key} 只能是非空字符串`);
    }
    out.push(x);
  }
  return out;
}

/** 可选的布尔参数；给了就必须是布尔值（"false" 那种字符串不算数） */
function readBoolean(params: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const v = params[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`参数 ${key} 必须是布尔值`);
  return v;
}

function readNumber(params: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function requireColor(params: Readonly<Record<string, unknown>>): string | readonly number[] {
  const v = params['color'];
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (Array.isArray(v) && v.length >= 3) return v.map((x) => Number(x) || 0);
  throw new Error('缺少参数 color（填色用 #RRGGBB，或 [r,g,b]）');
}

/**
 * 区域：两种形状。
 *   - `{ minX, minY, maxX, maxY }` —— 原生像元坐标
 *   - `[minX, minY, maxX, maxY]` —— 地理范围（目标坐标系），由 normalizeParams 换算
 *
 * optional 形态缺参时返回 **undefined**（不是零区域）：
 * 零区域会让下游的「region ?? 其它来源」分支永远走不到，
 * 把「没给范围」变成「改了 0 像元却报成功」。
 *
 * 这里只管**形状**；区域与影像是否相交的判定要拿到影像尺寸才做得了，
 * 放在栅格层（raster/ops.ts）与结果汇总处（verdictOf），
 * 两处共用 mask.ts 里的同一份文案。
 */
function requireRegion(params: Readonly<Record<string, unknown>>): PixelRegion;
function requireRegion(
  params: Readonly<Record<string, unknown>>,
  opts: { readonly optional: true },
): PixelRegion | undefined;
function requireRegion(
  params: Readonly<Record<string, unknown>>,
  opts?: { readonly optional?: boolean },
): PixelRegion | undefined {
  const raw = params['region'];
  if (raw === undefined || raw === null) {
    if (opts?.optional) return undefined;
    throw new Error('缺少参数 region（要改动的像元区域）');
  }
  if (Array.isArray(raw)) {
    throw new Error('region 的地理范围形式还没接上，请给像元坐标 { minX, minY, maxX, maxY }');
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const minX = Number(o['minX']);
    const minY = Number(o['minY']);
    const maxX = Number(o['maxX']);
    const maxY = Number(o['maxY']);
    if (![minX, minY, maxX, maxY].every((x) => Number.isFinite(x))) {
      throw new Error('region 必须是 { minX, minY, maxX, maxY } 四个数字');
    }
    // 归一化：用户拖框的方向不该决定结果
    const region = {
      minX: Math.min(minX, maxX),
      minY: Math.min(minY, maxY),
      maxX: Math.max(minX, maxX),
      maxY: Math.max(minY, maxY),
    };
    // 空区域（宽或高为 0）什么都不会改：明确报错，
    // 别让它一路走到「改了 0 像元」。
    if (region.maxX <= region.minX || region.maxY <= region.minY) {
      throw new Error(
        `region 是空的（宽或高为 0）：这样不会改到任何像元（minX=${region.minX}，maxX=${region.maxX}，minY=${region.minY}，maxY=${region.maxY}）`,
      );
    }
    return region;
  }
  throw new Error('region 形状不认识：给 { minX, minY, maxX, maxY }');
}

/** 地理范围形式的 region —— 需要目标栅格的仿射参数才能换算成像元 */
async function normalizeParams(
  deps: ExecutorDeps,
  spec: OperationSpec,
): Promise<Readonly<Record<string, unknown>>> {
  const params: Record<string, unknown> = { ...spec.params };
  const raw = params['region'];
  if (Array.isArray(raw) && raw.length === 4) {
    const nums = raw.map((x) => Number(x));
    if (!nums.every((x) => Number.isFinite(x))) {
      throw new Error('region 的地理范围必须是四个数字：[minX, minY, maxX, maxY]');
    }
    const bounds: GeoBounds = {
      minX: Math.min(nums[0]!, nums[2]!),
      minY: Math.min(nums[1]!, nums[3]!),
      maxX: Math.max(nums[0]!, nums[2]!),
      maxY: Math.max(nums[1]!, nums[3]!),
    };
    const target = requireTarget(params);
    const probe = await probeDataset(deps.loc, deps.store.resolve(target));
    // DatasetInfo 是按 kind 区分的联合类型：只有栅格才有仿射参数
    const gt = probe.dataset?.kind === 'raster' ? probe.dataset.geotransform : null;
    if (!gt) {
      throw new Error('该栅格没有仿射参数，无法把地理范围换算成像元区域');
    }
    params['region'] = geoToPixelRegion(bounds, gt);
  }
  return params;
}

function readBbox(params: Readonly<Record<string, unknown>>): GeoBounds | undefined {
  const raw = params['bbox'];
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const nums = raw.map((x) => Number(x));
  if (!nums.every((x) => Number.isFinite(x))) return undefined;
  return {
    minX: Math.min(nums[0]!, nums[2]!),
    minY: Math.min(nums[1]!, nums[3]!),
    maxX: Math.max(nums[0]!, nums[2]!),
    maxY: Math.max(nums[1]!, nums[3]!),
  };
}

/**
 * export.image 的 bbox：EPSG:4326 的 [minX,minY,maxX,maxY]。
 *
 * 为什么不像 readBbox 那样"给不了就当没有"：
 * 那条口径适合**可选**参数，而这里的 bbox 一旦给了就是"只导这一块"。
 * 形状不对却当成没给 → 悄悄导了整幅，用户拿到的是错的范围，而且毫无提示。
 */
function readBbox4326(params: Readonly<Record<string, unknown>>): [number, number, number, number] | undefined {
  const raw = params['bbox'];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length !== 4) {
    throw new Error('bbox 必须是四个数字：[minX,minY,maxX,maxY]（EPSG:4326 经纬度）');
  }
  const nums = raw.map((x) => Number(x));
  if (!nums.every((x) => Number.isFinite(x))) {
    throw new Error('bbox 必须是四个数字：[minX,minY,maxX,maxY]（EPSG:4326 经纬度）');
  }
  const [minX, minY, maxX, maxY] = nums as [number, number, number, number];
  if (maxX <= minX || maxY <= minY) {
    throw new Error(
      `bbox 的范围不合法（要求 minX<maxX 且 minY<maxY，顺序为 [minX,minY,maxX,maxY]）：${nums.join(', ')}`,
    );
  }
  return [minX, minY, maxX, maxY];
}

/**
 * 可选的字符串数组参数（如 export.report 的 include）。
 *
 * 给了就每一项都得是非空字符串：形状不对的参数如果被当成"没给"，
 * 报告就会少掉调用方要的内容，而调用方毫不知情。
 */
function readOptionalStringArray(
  params: Readonly<Record<string, unknown>>,
  key: string,
): string[] | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error(`参数 ${key} 必须是字符串数组`);
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== 'string' || x.trim() === '') {
      throw new Error(`参数 ${key} 的每一项都必须是非空字符串`);
    }
    out.push(x);
  }
  return out;
}

/** 自由形状掩膜（画笔）：base64 的逐像元字节 */
function readMask(params: Readonly<Record<string, unknown>>): PixelMask | undefined {
  const raw = params['mask'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const width = Number(o['width']);
  const height = Number(o['height']);
  const data = o['data'];
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('mask 的 width / height 必须是正整数');
  }
  if (typeof data !== 'string') {
    throw new Error('mask 的 data 必须是 base64 字符串');
  }
  const bytes = new Uint8Array(Buffer.from(data, 'base64'));
  const need = width * height;
  if (bytes.length < need) {
    throw new Error(`mask 的数据长度不对：需要 ${need} 字节（${width}×${height}），实际 ${bytes.length}`);
  }
  return buildPixelMask(width, height, bytes);
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
