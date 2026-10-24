/**
 * 坐标系与坐标值合理性的检查。
 *
 * 这一族检查回答的是同一个问题的不同侧面：**这批坐标值配这层坐标系，对不对？**
 *   - 坐标值超出了该坐标系的取值范围（比如经纬度图层里出现 -1e9）；
 *   - 经纬度两个轴写反了（lat/lon 互换）；
 *   - 图层整体范围与坐标系对不上；
 *   - 个别要素离群到不像同一份数据；
 *   - 属性字段声明的类型与实际存的值对不上。
 *
 * 为什么自己判而不交给 GDAL：GDAL 只负责「把坐标读出来」，
 * 「这个值在这套坐标系下合不合理」没有现成接口，只能自己算。
 */
import type { Finding } from './types.ts';
import type { ScannedFeature } from './scan.ts';
import { verticesOf } from './geometry.ts';
import type { CrsInfo, VectorFieldInfo } from '../gdal/probe.ts';

export type Extent = readonly [number, number, number, number];

/** 系统自带字段：不做字段类型检查（它们由软件维护，用户改不了） */
export const SYSTEM_FIELDS = new Set([
  'FID',
  'Shape',
  'OBJECTID',
  'Shape_Leng',
  'Shape_Area',
  'Shape_Len',
  'GlobalID',
]);

/* ───────────────────── 坐标系的取值范围 ───────────────────── */

/**
 * 一个坐标系的「合法坐标值」范围。
 *
 * kind:
 *   - geographic：经纬度（度）
 *   - webmercator：球面墨卡托（米）
 *   - projected：其它投影坐标（米或英尺，取一个宽松上限）
 *   - unknown：没有坐标系，判不了
 */
export interface CrsDomain {
  readonly kind: 'geographic' | 'webmercator' | 'projected' | 'unknown';
  readonly label: string;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** 球面墨卡托的有效范围（±20037508.34 米，约 ±85.05°） */
const WEBMERCATOR_LIMIT = 20037508.342789244;

/**
 * 投影坐标的宽松上限（1e8）。
 *
 * 取 1e8 而不是更紧的值，是因为投影坐标的量纲不统一（米 / 英尺 / 度都有），
 * 而高斯-克吕格带号前缀会把 x 推到 4e7 量级。1e8 对这些都留了余量，
 * 同时又足以把 -1e9 这种明显离谱的值挑出来。
 */
const PROJECTED_LIMIT = 1e8;

/** 常见的地理坐标系 EPSG 码（判定轴序与取值范围要用） */
const GEOGRAPHIC_EPSG = new Set([4326, 4322, 4324, 4269, 4258, 4267, 4284, 4490, 4979, 4978]);
/** 常见的 Web 墨卡托 EPSG 码 */
const WEBMERCATOR_EPSG = new Set([3857, 3785, 900913, 102100, 102113]);

/**
 * 由坐标系信息推出它的合法坐标范围。
 *
 * 判投影 / 地理用的是 **WKT 里的关键字**，而不是 EPSG 码表：
 * WKT1 的 .prj 写 "PROJCS["，WKT2 写 "PROJCRS["，两者都能认；
 * 而 EPSG 码表永远认不全（同一个投影会有几十个别名码）。
 *
 * 顺序很重要：投影坐标系的 WKT 里含有 "BASEGEOGCRS["（基准地理坐标系），
 * 先判 GEOGCRS 会把 UTM 图误判成经纬度。
 */
export function crsDomainOf(crs: CrsInfo): CrsDomain {
  if (!crs.present) {
    return { kind: 'unknown', label: '未知（没有坐标系）', minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity };
  }
  const wkt = crs.wkt ?? '';
  const epsg = crs.epsg;

  const isProjected = /PROJCS\[|PROJCRS\[/i.test(wkt);
  const isGeographic = !isProjected && /GEOGCS\[|GEOGCRS\[/i.test(wkt);

  if (epsg !== undefined && WEBMERCATOR_EPSG.has(epsg)) {
    return {
      kind: 'webmercator',
      label: `EPSG:${epsg}（球面墨卡托）`,
      minX: -WEBMERCATOR_LIMIT,
      maxX: WEBMERCATOR_LIMIT,
      minY: -WEBMERCATOR_LIMIT,
      maxY: WEBMERCATOR_LIMIT,
    };
  }
  if (isGeographic || (epsg !== undefined && GEOGRAPHIC_EPSG.has(epsg))) {
    return {
      kind: 'geographic',
      label: epsg !== undefined ? `EPSG:${epsg}（经纬度）` : '经纬度（自定义地理坐标系）',
      // 这里刻意把纬度也放到 ±180：轴序写反的经纬度数据，纬度会落在 [-90,90]、
      // 经度落在 [-180,180]，用 ±90 卡纬度会把「轴序写反」误报成「坐标越界」。
      // 轴序的问题交给 checkAxisOrder 单独说，两条规则不重复报同一件事。
      minX: -180,
      maxX: 180,
      minY: -180,
      maxY: 180,
    };
  }
  if (isProjected || epsg !== undefined) {
    return {
      kind: 'projected',
      label: epsg !== undefined ? `EPSG:${epsg}（投影坐标）` : '投影坐标（自定义）',
      minX: -PROJECTED_LIMIT,
      maxX: PROJECTED_LIMIT,
      minY: -PROJECTED_LIMIT,
      maxY: PROJECTED_LIMIT,
    };
  }
  return { kind: 'unknown', label: '未知坐标系', minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity };
}

/* ───────────────────── 坐标值范围 ───────────────────── */

/**
 * V-CRS-003 坐标值超出该坐标系的合理范围。
 *
 * 为什么这条重要：坐标值越界时，图层**照样能打开、照样能出图**，
 * 但算面积、叠加、缓冲全是错的 —— 用户完全看不出异常。
 */
export function checkCrsRange(features: readonly ScannedFeature[], domain: CrsDomain): Finding[] {
  if (domain.kind === 'unknown') return [];
  const offenders: string[] = [];
  let worst: string | null = null;
  for (const f of features) {
    if (!f.geometry) continue;
    let bad = false;
    for (const [x, y] of verticesOf(f.geometry)) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        bad = true;
        worst = `要素 ${f.id} 的坐标不是有限数`;
        break;
      }
      if (x < domain.minX || x > domain.maxX || y < domain.minY || y > domain.maxY) {
        bad = true;
        worst = `要素 ${f.id} 的坐标 (${x}, ${y})`;
        break;
      }
    }
    if (bad) offenders.push(String(f.id));
  }
  if (offenders.length === 0) return [];
  return [
    {
      ruleId: 'V-CRS-003',
      severity: 'error',
      title: '坐标值超出该坐标系的合理范围',
      detail:
        `${offenders.length} 个要素的坐标超出 ${domain.label} 的取值范围` +
        (worst ? `，例如 ${worst}` : '') +
        '。这类图层能打开也能出图，但面积、长度、叠加的计算结果全是错的，且界面上看不出来。',
      affectedCount: offenders.length,
      samples: offenders.slice(0, 5),
      hint: '先确认这层数据本该用哪个坐标系：常见成因是投影坐标的数据被写成了经纬度，或坐标值录入时多了一位。',
    },
  ];
}

/* ───────────────────── 坐标轴顺序 ───────────────────── */

/**
 * V-CRS-004 坐标轴顺序（经纬度写反）。
 *
 * 判据：纬度不可能超过 90°，经度可以。
 *   - 所有 x 都 ≤ 90° 且有 y > 90° → x 是纬度、y 是经度，**确定写反了**；
 *   - 有 x > 90° → x 是经度，轴序正确；
 *   - x、y 都在 ±90° 以内 → 数值上看不出差别，**判不了**。
 *
 * 判不了的时候要说「判不了」，不能写成「未发现问题」—— 两者的差别是
 * 用户要不要再去核对一遍源数据。
 */
export function checkAxisOrder(features: readonly ScannedFeature[], domain: CrsDomain): Finding[] {
  if (domain.kind !== 'geographic') return [];
  let maxAbsX = 0;
  let maxAbsY = 0;
  let any = false;
  for (const f of features) {
    if (!f.geometry) continue;
    for (const [x, y] of verticesOf(f.geometry)) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      any = true;
      maxAbsX = Math.max(maxAbsX, Math.abs(x));
      maxAbsY = Math.max(maxAbsY, Math.abs(y));
    }
  }
  if (!any) return [];
  if (maxAbsX <= 90 && maxAbsY > 90) {
    return [
      {
        ruleId: 'V-CRS-004',
        severity: 'error',
        title: '经纬度两个轴疑似写反',
        detail:
          `所有 x 坐标都在 ±90° 以内（最大 ${maxAbsX.toFixed(2)}°），但有 y 坐标超过 90°` +
          `（最大 ${maxAbsY.toFixed(2)}°）。纬度不可能超过 90°，说明存的是「纬度、经度」` +
          '而不是「经度、纬度」。',
        hint: '这层数据在地图上会落在错误的位置，且偏移量随纬度变化，很难一眼看出来；请核对源数据的轴序。',
      },
    ];
  }
  if (maxAbsX <= 90) {
    return [
      {
        ruleId: 'V-CRS-004',
        severity: 'info',
        title: '坐标轴顺序无法判定',
        detail:
          `所有坐标都落在 ±90° 以内（x 最大 ${maxAbsX.toFixed(2)}°、y 最大 ${maxAbsY.toFixed(2)}°），` +
          '经纬度互换在数值上分辨不出来，本次未能判定轴序是否正确。',
        hint: '若这层数据确实来自经纬度表，请人工核对一条记录的实际位置。',
      },
    ];
  }
  return [];
}

/* ───────────────────── 范围合理性 ───────────────────── */

/** 所有要素顶点的总范围 */
export function extentOf(features: readonly ScannedFeature[]): Extent | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const f of features) {
    if (!f.geometry) continue;
    for (const [x, y] of verticesOf(f.geometry)) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      any = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return any ? [minX, minY, maxX, maxY] : null;
}

/**
 * V-CRS-005 图层整体范围是否合理。
 *
 * 两种情况：
 *   1. 范围整体越出坐标系的取值范围（与 V-CRS-003 是同一事实的两个视角：
 *      一条说图层，一条说具体要素），这里给的是图层级结论；
 *   2. 范围退化成零（有要素但全挤在一个点上）。
 */
export function checkExtentPlausibility(
  extent: Extent | null,
  domain: CrsDomain,
  featureCount: number,
): Finding[] {
  if (!extent) return [];
  const out: Finding[] = [];
  const [minX, minY, maxX, maxY] = extent;
  if (domain.kind !== 'unknown' && (minX < domain.minX || maxX > domain.maxX || minY < domain.minY || maxY > domain.maxY)) {
    out.push({
      ruleId: 'V-CRS-005',
      severity: 'warn',
      title: '图层整体范围超出该坐标系的取值范围',
      detail:
        `图层范围 (${minX}, ${minY}) ~ (${maxX}, ${maxY}) 越出了 ${domain.label} 的有效范围。` +
        '逐要素的越界明细见 V-CRS-003。',
      hint: '这通常意味着这层数据的坐标系标错了，先定坐标系再谈别的。',
    });
  }
  if (featureCount > 1 && minX === maxX && minY === maxY) {
    out.push({
      ruleId: 'V-CRS-005',
      severity: 'warn',
      title: '图层范围退化成一个点',
      detail: `图层有 ${featureCount} 个要素，但全部落在同一个位置 (${minX}, ${minY})。`,
      hint: '要么是坐标写错了，要么是这批要素本就在同一处；请确认数据来源。',
    });
  }
  return out;
}

/* ───────────────────── 离群要素 ───────────────────── */

/** 线性插值分位数（R-7 口径，与常见统计软件一致） */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/** 离群判定要多少个要素才具统计意义 */
export const OUTLIER_MIN_FEATURES = 4;

/**
 * V-EXT-001 离群要素。
 *
 * 判据用四分位距（IQR）而不是平均值 ± 标准差：标准差会被离群点自己带偏，
 * 一个 -1e9 的点能把阈值撑到天上，反而把真正的离群点藏起来。
 * IQR 对离群点不敏感，这正是它适合干这件事的原因。
 */
export function checkOutliers(features: readonly ScannedFeature[]): Finding[] {
  const centers: { id: string; x: number; y: number }[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    const vs = verticesOf(f.geometry);
    if (vs.length === 0) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of vs) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    centers.push({ id: String(f.id), x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
  }
  if (centers.length < OUTLIER_MIN_FEATURES) return [];
  const xs = centers.map((c) => c.x).sort((a, b) => a - b);
  const ys = centers.map((c) => c.y).sort((a, b) => a - b);
  const q1x = quantile(xs, 0.25);
  const q3x = quantile(xs, 0.75);
  const q1y = quantile(ys, 0.25);
  const q3y = quantile(ys, 0.75);
  const iqrX = q3x - q1x;
  const iqrY = q3y - q1y;
  // IQR 为 0（绝大多数要素挤在同一点）时给一个兜底下限，
  // 否则任何微小差别都会被判成离群。
  const spanX = Math.max(iqrX, 1e-9);
  const spanY = Math.max(iqrY, 1e-9);
  const loX = q1x - 3 * spanX;
  const hiX = q3x + 3 * spanX;
  const loY = q1y - 3 * spanY;
  const hiY = q3y + 3 * spanY;
  const hits = centers.filter((c) => c.x < loX || c.x > hiX || c.y < loY || c.y > hiY);
  if (hits.length === 0) return [];
  return [
    {
      ruleId: 'V-EXT-001',
      severity: 'warn',
      title: '存在离群要素',
      detail: `${hits.length} 个要素的位置离这批数据的整体范围明显更远，例如要素 ${hits[0]!.id}。`,
      affectedCount: hits.length,
      samples: hits.slice(0, 5).map((c) => c.id),
      hint: '离群要素多半是坐标录错或来自另一批数据；确认后可单独删除。',
    },
  ];
}

/* ───────────────────── 字段类型 ───────────────────── */

/** 看起来像数字的文本 */
const NUMERIC_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function looksNumericText(v: unknown): boolean {
  return typeof v === 'string' && NUMERIC_TEXT.test(v.trim());
}

/**
 * V-FIELD-003 字段声明的类型与实际存的值对不上。
 *
 * 最常见的是「数字存成了文本」：属性表里看着是一串数字，类型却是文本。
 * 这种字段在 ArcGIS 里排序、筛选、做表达式运算都会出错，
 * 而且在属性表里**看不出来**。
 */
export function checkFieldTypes(
  features: readonly ScannedFeature[],
  fields: readonly VectorFieldInfo[],
): Finding[] {
  if (features.length === 0) return [];
  const out: Finding[] = [];
  for (const field of fields) {
    if (SYSTEM_FIELDS.has(field.name)) continue;
    const type = field.type.toLowerCase();
    const isNumericType = type.includes('integer') || type.includes('real') || type.includes('float') || type.includes('double');
    const isStringType = type.includes('string') || type.includes('text') || type.includes('character');
    const isDateType = type.includes('date') || type.includes('time');

    const values: unknown[] = [];
    for (const f of features) {
      const v = f.properties ? f.properties[field.name] : undefined;
      if (v === undefined || v === null) continue;
      values.push(v);
    }
    if (values.length === 0) continue;

    if (isNumericType) {
      const bad = values.filter((v) => typeof v === 'string');
      if (bad.length > 0) {
        out.push({
          ruleId: 'V-FIELD-003',
          severity: 'error',
          title: `字段「${field.name}」的类型与实际值不符`,
          detail: `该字段声明为${field.type}，但有 ${bad.length} 个值是文本（例如「${String(bad[0])}」）。`,
          affectedCount: bad.length,
          hint: '数值字段里混进文本会让求和、平均值等统计直接失效，请先清理这些值。',
        });
      }
      continue;
    }
    if (isStringType) {
      const allNumeric = values.every((v) => typeof v === 'number' || looksNumericText(v));
      if (allNumeric) {
        out.push({
          ruleId: 'V-FIELD-003',
          severity: 'warn',
          title: `字段「${field.name}」存的是数字但类型是文本`,
          detail: `该字段声明为${field.type}，实际存的全是数字。`,
          affectedCount: values.length,
          hint: '文本型的数字排序会按字典序（"10" 排在 "9" 前面），做数值表达式时也需要显式转换；如无特殊原因建议改成数值型。',
        });
      }
      continue;
    }
    if (isDateType) {
      const bad = values.filter((v) => typeof v === 'string' && Number.isNaN(Date.parse(v)));
      if (bad.length > 0) {
        out.push({
          ruleId: 'V-FIELD-003',
          severity: 'error',
          title: `字段「${field.name}」里有无法解析的日期`,
          detail: `该字段声明为${field.type}，但有 ${bad.length} 个值解析不成日期（例如「${String(bad[0])}」）。`,
          affectedCount: bad.length,
          hint: '日期字段里的非法值会让按时间筛选的结果不可信。',
        });
      }
    }
  }
  return out;
}
