/**
 * 数据体检规则集。
 *
 * 设计原则：
 *  1. **静默错误优先**——凡是"算错了但用户看不出来"的问题，一律 block 级，
 *     阻断写回。坐标系缺失就是典型：没有坐标系时面积、长度、叠加全是错的，
 *     而用户完全看不出异常。
 *  2. **只报告不修改**——体检本身不改数据，修复是另一个 op。
 *  3. **说人话**——每条 finding 都要有"怎么改"的提示，不能抛 GDAL 原始异常。
 */
import { tools } from '../gdal/runner.ts';
import { probeDataset, type DatasetInfo, type VectorInfo } from '../gdal/probe.ts';
import type { GdalLocation } from '../gdal/env.ts';

export type Severity = 'info' | 'warn' | 'error' | 'blocker';

export interface Finding {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  /** 给用户看的下一步动作 */
  readonly hint?: string;
  readonly affectedCount?: number;
  readonly samples?: readonly string[];
}

export interface HealthReport {
  readonly path: string;
  readonly kind: 'raster' | 'vector' | 'unknown';
  readonly driver: string | null;
  readonly findings: Finding[];
  readonly blockers: Finding[];
  readonly passed: boolean;
  readonly checkedAt: string;
}

export interface HealthOptions {
  /** 要素级检查的最大要素数；超过则只做元信息检查并在报告中说明 */
  readonly maxFeatureScan?: number;
}

const DEFAULT_MAX_SCAN = 5000;

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

/* ───────────────────────── 矢量规则 ───────────────────────── */

const DEFAULT_FIELDS = new Set(['FID', 'Shape', 'OBJECTID', 'Shape_Leng', 'Shape_Area', 'Shape_Len', 'GlobalID']);

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

/* ───────────────────────── 要素级检查（受限扫描） ───────────────────────── */

interface ScannedFeature {
  readonly id: string | number | null;
  readonly geometry: { type?: string; coordinates?: unknown } | null;
}

/** 拉取要素（限制条数），用于空几何 / 零面积检查 */
async function scanFeatures(
  loc: GdalLocation,
  path: string,
  limit: number,
): Promise<{ features: ScannedFeature[]; truncated: boolean } | null> {
  const gdal = tools(loc);
  const res = await gdal.ogr2ogr([
    '-f', 'GeoJSON',
    '-limit', String(limit + 1),
    '-lco', 'RFC7946=NO',
    '/vsistdout/',
    path,
  ]);
  if (!res.ok || !res.stdout.trim()) return null;
  try {
    const j = JSON.parse(res.stdout) as { features?: ScannedFeature[] };
    const feats = j.features ?? [];
    const truncated = feats.length > limit;
    return { features: truncated ? feats.slice(0, limit) : feats, truncated };
  } catch {
    return null;
  }
}

function ringArea(coords: unknown): number {
  // 鞋带公式，支持 Polygon 的多环结构
  if (!Array.isArray(coords)) return Number.NaN;
  let total = 0;
  for (const ring of coords as unknown[]) {
    if (!Array.isArray(ring) || ring.length < 3) continue;
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const p = ring[i] as number[];
      const q = ring[i + 1] as number[];
      if (!Array.isArray(p) || !Array.isArray(q)) continue;
      const px = p[0] ?? 0, py = p[1] ?? 0;
      const qx = q[0] ?? 0, qy = q[1] ?? 0;
      a += px * qy - qx * py;
    }
    total += Math.abs(a) / 2;
  }
  return total;
}

function isNullGeometry(g: ScannedFeature['geometry']): boolean {
  if (!g) return true;
  const c = g.coordinates;
  if (c === undefined || c === null) return true;
  if (Array.isArray(c) && c.length === 0) return true;
  return false;
}

async function checkFeatureLevel(
  loc: GdalLocation,
  info: VectorInfo,
  limit: number,
): Promise<Finding[]> {
  const out: Finding[] = [];
  const scan = await scanFeatures(loc, info.path, limit);
  if (!scan) return out;

  const nullGeoms = scan.features.filter((f) => isNullGeometry(f.geometry));
  if (nullGeoms.length > 0) {
    out.push(
      finding(
        'V-GEOM-001',
        'error',
        '存在空几何要素',
        `${nullGeoms.length} 个要素没有几何信息。`,
        {
          affectedCount: nullGeoms.length,
          samples: nullGeoms.slice(0, 5).map((f) => String(f.id)),
          hint: '空几何要素在出图时不可见，但会污染统计；建议单独清理。',
        },
      ),
    );
  }

  const zeroArea = scan.features.filter((f) => {
    const g = f.geometry;
    if (!g || isNullGeometry(g)) return false;
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const a = ringArea(g.coordinates);
      return Number.isFinite(a) && a === 0;
    }
    return false;
  });
  if (zeroArea.length > 0) {
    out.push(
      finding(
        'V-GEOM-002',
        'error',
        '存在零面积面要素',
        `${zeroArea.length} 个面的面积为 0，通常是几何退化或坐标重复造成的。`,
        {
          affectedCount: zeroArea.length,
          samples: zeroArea.slice(0, 5).map((f) => String(f.id)),
          hint: '可用"修复几何"操作处理；请注意修复可能改变面积。',
        },
      ),
    );
  }

  if (scan.truncated) {
    out.push(
      finding(
        'V-SCAN-001',
        'info',
        '要素扫描已截断',
        `本次只扫描了前 ${limit} 个要素，全量检查需缩小数据量或分批处理。`,
      ),
    );
  }

  return out;
}

/* ───────────────────────── 入口 ───────────────────────── */

export async function runHealthCheck(
  loc: GdalLocation,
  path: string,
  options: HealthOptions = {},
): Promise<HealthReport> {
  const maxScan = options.maxFeatureScan ?? DEFAULT_MAX_SCAN;
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
    };
  }

  let findings: Finding[] = [];
  if (dataset.kind === 'raster') {
    findings = checkRaster(dataset, Boolean(dataset.sidecars.prj));
  } else {
    findings = checkVector(dataset);
    findings = findings.concat(await checkFeatureLevel(loc, dataset, maxScan));
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
  };
}

export { probeDataset };
export type { DatasetInfo, VectorInfo };
