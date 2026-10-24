/**
 * 数据体检规则集。
 *
 * 设计原则：
 *  1. **静默错误优先**——凡是"算错了但用户看不出来"的问题，一律重级，
 *     阻断写回。坐标系缺失就是典型：没有坐标系时面积、长度、叠加全是错的，
 *     而用户完全看不出异常。
 *  2. **只报告不修改**——体检本身不改数据，修复是另一个 op。
 *  3. **说人话**——每条 finding 都要有"怎么改"的提示，不能抛 GDAL 原始异常。
 *  4. **查了 ≠ 没查**——每一项检查都要报出自己**执行了没有**。
 *     「查了没问题」和「根本没查」在报告里长得几乎一样，
 *     用户看到「未发现自相交」会以为引擎查过自相交。
 *     这件事本仓库吃过亏：报告曾经写「✅ 未发现自相交、空几何、零面积等几何问题」，
 *     而引擎从来就没有自相交这一条规则。所以 coverage 是体检结果的一部分，
 *     不是可选的装饰。
 */
import { probeDataset, type DatasetInfo, type VectorInfo } from '../gdal/probe.ts';
import type { GdalLocation } from '../gdal/env.ts';
import { scanFeatures, isNullGeometry, type ScannedFeature } from './scan.ts';
import {
  checkZeroArea,
  checkZeroLengthLines,
  checkDuplicateVertices,
  checkRingIntegrity,
  checkSharpAngles,
  isZeroAreaFeature,
  isZeroLengthLineFeature,
  hasUnclosedRing,
} from './geometry.ts';
import {
  checkCrsRange,
  checkAxisOrder,
  checkExtentPlausibility,
  checkOutliers,
  checkFieldTypes,
  crsDomainOf,
  extentOf,
  OUTLIER_MIN_FEATURES,
} from './scope.ts';
import { runTopologyChecks } from './topology.ts';
import {
  checkCrsMismatch,
  checkExtentCompare,
  checkSystematicOffset,
  loadReferenceLayer,
} from './reference.ts';
import type { CheckCoverage, CheckStatus, Finding, Severity } from './types.ts';

export type { Severity, Finding, CheckStatus, CheckCoverage } from './types.ts';

export interface HealthReport {
  readonly path: string;
  readonly kind: 'raster' | 'vector' | 'unknown';
  readonly driver: string | null;
  readonly findings: Finding[];
  readonly blockers: Finding[];
  readonly passed: boolean;
  readonly checkedAt: string;
  /**
   * 每个检查项的执行状态。
   *
   * 没有这一段，报告就没法区分「查过没问题」和「没查」——
   * 这正是这个仓库此前栽过的地方，所以它是体检结果的一部分。
   */
  readonly coverage?: readonly CheckCoverage[];
}

export interface HealthOptions {
  /** 要素级检查的最大要素数；超过则只做元信息检查并在报告中说明 */
  readonly maxFeatureScan?: number;
  /** 参照层（绝对路径）：跨图层比较（crs-mismatch / extent-compare / systematic-offset）要用 */
  readonly reference?: string;
  /** 尖角阈值（度），默认 30 */
  readonly angleThresholdDeg?: number;
}

const DEFAULT_MAX_SCAN = 5000;

/**
 * 尖角阈值（度）。
 *
 * 取 10° 是量出来的，不是拍的：
 *   - 实测公开样本 GADM 中国省级（37 个面、2 万多个顶点）里，
 *     最锐的**合法**拐角约 19°，没有任何一个顶点小于 15°；
 *   - 而数字化尖刺（边界冲出去又折回来）通常在 5° 以下。
 * 所以 10° 能把「真缺陷」和「合法的窄角」分开。
 * 阈值可由调用方通过契约里的 angleThresholdDeg 调整。
 */
const DEFAULT_ANGLE_THRESHOLD = 10;

function finding(
  ruleId: string,
  severity: Severity,
  title: string,
  detail: string,
  extra?: { hint?: string; affectedCount?: number; samples?: string[] },
): Finding {
  return { ruleId, severity, title, detail, ...extra };
}

/* ───────────────────────── 栅格规则 ───────────────────────── */

function checkRaster(info: DatasetInfo & { kind: 'raster' }, sidecarPrjPresent: boolean): Finding[] {
  const out: Finding[] = [];
  const hasPrj = Boolean(info.sidecars.prj);

  // R-CRS-001：GDAL 解析不到坐标系 → 阻断
  if (!info.crs.present) {
    out.push(
      finding(
        'R-CRS-001',
        'blocker',
        '栅格没有可用的坐标系',
        'GDAL 无法从该栅格解析出坐标系。这种情况下面积、长度、叠加、缓冲的计算结果全部是错的，' +
          '而且界面上看不出来，因此必须先解决坐标系再写回。',
        {
          hint: hasPrj
            ? '检测到同名 .prj 侧车，但 GDAL 的栅格驱动不会自动读取它。请在坐标参考信息中选择正确的坐标系，' +
              '写回时会把它内嵌进 GeoTIFF。'
            : '请为该栅格指定正确的坐标系（EPSG 编号或坐标系文件），写回时会内嵌进 GeoTIFF。',
        },
      ),
    );
  } else if (hasPrj && info.crs.source === 'embedded') {
    out.push(
      finding(
        'R-CRS-002',
        'info',
        '坐标系已内嵌在影像内部',
        `GDAL 解析到坐标系${info.crs.authority ? `（${info.crs.authority}）` : ''}，同时存在同名 .prj 文件。` +
          '写回时会同时更新两者，保证 ArcGIS 与本工具读到的是同一个坐标系。',
      ),
    );
  }

  // R-GEO-001：缺少仿射变换 → 无法定位
  if (!info.geotransform) {
    out.push(
      finding(
        'R-GEO-001',
        'blocker',
        '栅格缺少地理定位信息',
        '既没有内嵌的仿射变换，也没有可用的世界文件，无法确定它在地图上的位置。',
        { hint: '请提供 .tfw 世界文件或在校验时指定范围（ULX/ULY/XSize/YSize）。' },
      ),
    );
  } else if (!info.crs.present && info.sidecars.worldFile) {
    out.push(
      finding(
        'R-GEO-002',
        'info',
        '地理定位来自世界文件',
        `仿射参数取自 ${info.sidecars.worldFile}。世界文件只给位置不给坐标系，两者必须配套才有意义。`,
      ),
    );
  }

  // R-SIZE-001：尺寸异常
  if (info.width <= 0 || info.height <= 0) {
    out.push(finding('R-SIZE-001', 'error', '栅格尺寸异常', `宽 ${info.width} × 高 ${info.height}，无法作为有效影像处理。`));
  }

  // R-BAND-001：波段数
  if (info.bandCount === 0) {
    out.push(finding('R-BAND-001', 'error', '栅格没有波段', '该文件不含任何波段数据。'));
  }

  return out;
}

/* ───────────────────────── 矢量元信息规则 ───────────────────────── */

function checkVector(info: VectorInfo): Finding[] {
  const out: Finding[] = [];

  // V-CRS-001：缺坐标系 → 阻断
  if (!info.crs.present) {
    out.push(
      finding(
        'V-CRS-001',
        'blocker',
        '图层没有坐标系',
        '该图层无法解析出坐标参考信息，叠加、缓冲与面积统计都会出错。',
        { hint: '请指定坐标系后重试；Shapefile 可通过同名 .prj 修复。' },
      ),
    );
  }

  // V-ENC-001：DBF 编码
  if (!info.encoding) {
    out.push(
      finding(
        'V-ENC-001',
        'warn',
        '未声明属性表编码',
        '没有 .cpg 编码标记文件时，不同软件会用不同编码猜测中文，可能出现乱码。',
        { hint: '写回时会自动生成 .cpg 标记为 UTF-8。' },
      ),
    );
  }

  // V-ENC-002：声明了编码，但不是 UTF-8
  //   读取本身没问题（按 .cpg 声明解），但**转码交差**时会丢字：
  //   GBK 只有 21886 个汉字，生僻地名（"㵘"、"㶮"一类）根本表示不了。
  if (info.encoding && !/^utf-?8$/i.test(info.encoding)) {
    out.push(
      finding(
        'V-ENC-002',
        'warn',
        `属性表编码为 ${info.encoding}（非 UTF-8）`,
        `按 .cpg 声明读取没有问题；但若转成 UTF-8 再交差，${info.encoding} 无法表示的生僻字会丢失或变成问号。`,
        { hint: '转换前先确认属性里没有生僻字；转换后必须写 .cpg 标记为 UTF-8，否则下次打开又乱码。' },
      ),
    );
  }

  // V-FIELD-001：默认字段
  const defaults = info.fields.filter((f) => DEFAULT_FIELDS.has(f.name));
  if (defaults.length > 0) {
    out.push(
      finding(
        'V-FIELD-001',
        'info',
        '包含系统默认字段',
        `发现默认字段：${defaults.map((f) => f.name).join('、')}。入库时通常需要清理。`,
      ),
    );
  }

  // V-FIELD-002：字段名可疑（乱码字符 / 全角 / 空格）
  const suspicious = info.fields.filter(
    (f) => /[\uFFFD]/.test(f.name) || /\s/.test(f.name) || /^[A-Za-z]{1,6}$/.test(f.name),
  );
  if (suspicious.length > 0) {
    out.push(
      finding(
        'V-FIELD-002',
        'warn',
        '字段命名可能不规范',
        `以下字段名可能需要规范：${suspicious.map((f) => f.name).join('、')}。`,
        { hint: '可使用"重命名字段"操作批量规范，修改前会自动备份。' },
      ),
    );
  }

  // V-COUNT-001
  if (info.featureCount === 0) {
    out.push(finding('V-COUNT-001', 'warn', '图层没有要素', '该图层要素数为 0，确认是否为预期。'));
  }

  return out;
}

const DEFAULT_FIELDS = new Set(['FID', 'Shape', 'OBJECTID', 'Shape_Leng', 'Shape_Area', 'Shape_Len', 'GlobalID']);

/* ───────────────────────── 矢量要素级检查 ───────────────────────── */

/** 一条覆盖记录 */
function cov(
  check: string,
  status: CheckStatus,
  rules?: readonly string[],
  reason?: string,
  scope: 'contract' | 'extra' = 'contract',
): CheckCoverage {
  return {
    check,
    status,
    ...(rules && rules.length > 0 ? { rules } : {}),
    ...(reason ? { reason } : {}),
    scope,
  };
}

interface VectorHealthOutcome {
  readonly findings: Finding[];
  readonly coverage: CheckCoverage[];
}

async function checkVectorHealth(
  loc: GdalLocation,
  info: VectorInfo,
  options: HealthOptions,
): Promise<VectorHealthOutcome> {
  const limit = options.maxFeatureScan ?? DEFAULT_MAX_SCAN;
  const angleThreshold = options.angleThresholdDeg ?? DEFAULT_ANGLE_THRESHOLD;
  const findings: Finding[] = [];
  const coverage: CheckCoverage[] = [];

  /* 元信息规则（不依赖要素读取，永远查得到） */
  findings.push(...checkVector(info));
  coverage.push(cov('crs-present', 'checked', ['V-CRS-001']));
  coverage.push(cov('encoding', 'checked', ['V-ENC-001', 'V-ENC-002']));
  coverage.push(cov('field-naming', 'checked', ['V-FIELD-002']));
  coverage.push(cov('default-fields', 'checked', ['V-FIELD-001']));

  /* 要素级检查 */
  const scan = await scanFeatures(loc, info.path, limit);
  const features: readonly ScannedFeature[] = scan?.features ?? [];

  if (!scan) {
    // 读不到要素 ≠ 没问题。这一项必须如实标成「没查」。
    const reason = '要素读取失败（GDAL 未能把图层转成 GeoJSON），要素级检查没有执行';
    coverage.push(cov('null-geometry', 'skipped', ['V-GEOM-001'], reason));
    coverage.push(cov('zero-area', 'skipped', ['V-GEOM-002'], reason));
    coverage.push(cov('sharp-angle', 'skipped', ['V-GEOM-008'], reason));
    coverage.push(cov('field-type', 'skipped', ['V-FIELD-003'], reason));
    coverage.push(cov('crs-range-sanity', 'skipped', ['V-CRS-003'], reason));
    coverage.push(cov('axis-order', 'skipped', ['V-CRS-004'], reason));
    coverage.push(cov('extent-plausibility', 'skipped', ['V-CRS-005'], reason));
    coverage.push(cov('outlier-extent', 'skipped', ['V-EXT-001'], reason));
    coverage.push(cov('geometry-degenerate', 'skipped', ['V-GEOM-005', 'V-GEOM-006', 'V-GEOM-007'], reason, 'extra'));
    coverage.push(cov('geometry-validity', 'skipped', ['V-GEOM-003', 'V-GEOM-009'], reason, 'extra'));
    coverage.push(cov('overlap', 'skipped', ['V-GEOM-004'], reason, 'extra'));
    await pushReferenceCoverage(loc, info, null, options, findings, coverage);
    return { findings, coverage };
  }

  /* 空几何 */
  const nullGeoms = features.filter((f) => isNullGeometry(f.geometry));
  if (nullGeoms.length > 0) {
    findings.push(
      finding('V-GEOM-001', 'error', '存在空几何要素', `${nullGeoms.length} 个要素没有几何信息。`, {
        affectedCount: nullGeoms.length,
        samples: nullGeoms.slice(0, 5).map((f) => String(f.id)),
        hint: '空几何要素在出图时不可见，但会污染统计；建议单独清理。',
      }),
    );
  }
  coverage.push(cov('null-geometry', 'checked', ['V-GEOM-001']));

  /* 零面积面 */
  findings.push(...checkZeroArea(features));
  coverage.push(cov('zero-area', 'checked', ['V-GEOM-002']));

  /* 几何退化（环、零长度线、重复顶点）——纯内存判定，不依赖 SpatiaLite */
  findings.push(...checkRingIntegrity(features));
  findings.push(...checkZeroLengthLines(features));
  findings.push(...checkDuplicateVertices(features));
  coverage.push(cov('geometry-degenerate', 'checked', ['V-GEOM-005', 'V-GEOM-006', 'V-GEOM-007'], undefined, 'extra'));

  /* 尖角 */
  findings.push(...checkSharpAngles(features, angleThreshold));
  coverage.push(cov('sharp-angle', 'checked', ['V-GEOM-008']));

  /* 字段类型 */
  findings.push(...checkFieldTypes(features, info.fields));
  coverage.push(cov('field-type', 'checked', ['V-FIELD-003']));

  /* 坐标系与坐标值 */
  const domain = crsDomainOf(info.crs);
  if (domain.kind === 'unknown') {
    coverage.push(cov('crs-range-sanity', 'skipped', ['V-CRS-003'], '图层没有坐标系，无法判断坐标值是否越界'));
    coverage.push(cov('axis-order', 'skipped', ['V-CRS-004'], '图层没有坐标系，无法判断轴序'));
  } else {
    findings.push(...checkCrsRange(features, domain));
    coverage.push(cov('crs-range-sanity', 'checked', ['V-CRS-003']));
    if (domain.kind === 'geographic') {
      findings.push(...checkAxisOrder(features, domain));
      coverage.push(cov('axis-order', 'checked', ['V-CRS-004']));
    } else {
      coverage.push(cov('axis-order', 'not-applicable', ['V-CRS-004'], '该坐标系不是经纬度坐标，不存在经纬度轴序互换的问题'));
    }
  }

  /* 范围合理性 */
  const extent = extentOf(features);
  if (extent) {
    findings.push(...checkExtentPlausibility(extent, domain, features.length));
    coverage.push(cov('extent-plausibility', 'checked', ['V-CRS-005']));
  } else {
    coverage.push(cov('extent-plausibility', 'skipped', ['V-CRS-005'], '图层没有要素几何，取不到范围'));
  }

  /* 离群要素 */
  if (features.length < OUTLIER_MIN_FEATURES) {
    coverage.push(
      cov(
        'outlier-extent',
        'skipped',
        ['V-EXT-001'],
        `要素数 ${features.length} 少于 ${OUTLIER_MIN_FEATURES}，离群统计不具统计意义`,
      ),
    );
  } else {
    findings.push(...checkOutliers(features));
    coverage.push(cov('outlier-extent', 'checked', ['V-EXT-001']));
  }

  /* 拓扑级检查（自相交 / 面重叠 / 几何有效性） */
  const flagged = new Set<string>();
  for (const f of features) {
    // 已经被上面几条点过名的要素不再重复报 ——
    // 同一个毛病（零面积 / 零长度 / 未闭合）报两遍，只会让错误条数虚高。
    if (isZeroAreaFeature(f) || isZeroLengthLineFeature(f) || hasUnclosedRing(f)) {
      flagged.add(String(f.id));
    }
  }
  const topology = await runTopologyChecks({
    loc,
    path: info.path,
    layerName: info.layerName,
    featureIds: features.map((f) => f.id),
    limit,
    totalFeatureCount: info.featureCount,
    checkOverlap: /polygon/i.test(info.geometryType ?? ''),
    alreadyFlagged: flagged,
  });
  findings.push(...topology.findings);
  coverage.push(cov('geometry-validity', topology.validity.status, ['V-GEOM-003', 'V-GEOM-009'], topology.validity.reason, 'extra'));
  coverage.push(cov('overlap', topology.overlap.status, ['V-GEOM-004'], topology.overlap.reason, 'extra'));

  /* 跨图层比较 */
  await pushReferenceCoverage(loc, info, extent, options, findings, coverage);

  if (scan.truncated) {
    findings.push(
      finding(
        'V-SCAN-001',
        'info',
        '要素扫描已截断',
        `本次只扫描了前 ${limit} 个要素，全量检查需缩小数据量或分批处理。`,
      ),
    );
  }

  return { findings, coverage };
}

/**
 * 跨图层比较的三条规则。
 *
 * 没有参照层就是「没查」—— 拿单层数据自己跟自己比，报出来的「一致」是自说自话。
 */
async function pushReferenceCoverage(
  loc: GdalLocation,
  info: VectorInfo,
  extent: ReturnType<typeof extentOf>,
  options: HealthOptions,
  findings: Finding[],
  coverage: CheckCoverage[],
): Promise<void> {
  const referencePath = options.reference;
  if (!referencePath) {
    const reason = '未提供参照层（契约里的 reference 参数），无法做跨图层比较';
    coverage.push(cov('crs-mismatch', 'skipped', ['V-CRS-002'], reason));
    coverage.push(cov('extent-compare', 'skipped', ['V-EXT-002'], reason));
    coverage.push(cov('systematic-offset', 'skipped', ['V-CRS-006'], reason));
    return;
  }
  const { layer: reference, error } = await loadReferenceLayer(loc, referencePath);
  if (!reference) {
    const reason = `参照层读取失败：${error ?? '未知原因'}`;
    coverage.push(cov('crs-mismatch', 'skipped', ['V-CRS-002'], reason));
    coverage.push(cov('extent-compare', 'skipped', ['V-EXT-002'], reason));
    coverage.push(cov('systematic-offset', 'skipped', ['V-CRS-006'], reason));
    return;
  }

  const mismatch = checkCrsMismatch(info.crs, reference);
  if (mismatch.finding) findings.push(mismatch.finding);
  coverage.push(cov('crs-mismatch', mismatch.status, ['V-CRS-002'], mismatch.reason));

  const compare = checkExtentCompare(extent, reference);
  if (compare.finding) findings.push(compare.finding);
  coverage.push(cov('extent-compare', compare.status, ['V-EXT-002'], compare.reason));

  const offset = checkSystematicOffset(extent, info.crs, reference);
  if (offset.finding) findings.push(offset.finding);
  coverage.push(cov('systematic-offset', offset.status, ['V-CRS-006'], offset.reason));
}

/* ───────────────────────── 入口 ───────────────────────── */

/** 契约里 dataset.healthCheck 声明的 15 个检查项 */
const CONTRACT_CHECKS: readonly string[] = [
  'crs-present', 'crs-mismatch', 'crs-range-sanity', 'axis-order', 'extent-plausibility',
  'systematic-offset', 'encoding', 'field-naming', 'field-type', 'default-fields',
  'null-geometry', 'zero-area', 'sharp-angle', 'outlier-extent', 'extent-compare',
];

export async function runHealthCheck(
  loc: GdalLocation,
  path: string,
  options: HealthOptions = {},
): Promise<HealthReport> {
  const { dataset, error } = await probeDataset(loc, path);

  if (!dataset) {
    const f = finding('H-OPEN-001', 'blocker', '无法打开数据集', error?.message ?? '未知原因', {
      hint: '确认文件存在、格式受支持，且没有被其它程序占用。',
    });
    return {
      path,
      kind: 'unknown',
      driver: null,
      findings: [f],
      blockers: [f],
      passed: false,
      checkedAt: new Date().toISOString(),
      coverage: [],
    };
  }

  let findings: Finding[] = [];
  let coverage: CheckCoverage[] = [];
  if (dataset.kind === 'raster') {
    findings = checkRaster(dataset, Boolean(dataset.sidecars.prj));
    coverage = rasterCoverage();
  } else {
    const outcome = await checkVectorHealth(loc, dataset, options);
    findings = outcome.findings;
    coverage = outcome.coverage;
  }

  const blockers = findings.filter((f) => f.severity === 'blocker');
  return {
    path,
    kind: dataset.kind,
    driver: dataset.driver,
    findings,
    blockers,
    passed: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    coverage,
  };
}

/**
 * 栅格的覆盖情况。
 *
 * 契约里的 15 项大多是逐要素的（几何、范围、离群），对栅格没有适用面；
 * 栅格自己的那几条（R-CRS-001 / R-GEO-001 等）在 checkRaster 里查。
 */
function rasterCoverage(): CheckCoverage[] {
  const out: CheckCoverage[] = [cov('crs-present', 'checked', ['R-CRS-001'])];
  for (const c of CONTRACT_CHECKS) {
    if (c === 'crs-present') continue;
    out.push(cov(c, 'not-applicable', undefined, '该项针对矢量图层的逐要素数据，栅格不适用'));
  }
  return out;
}

export { probeDataset };
export type { DatasetInfo, VectorInfo };
