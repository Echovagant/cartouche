/**
 * 平面量算：面积、周长，以及"这个图层的坐标单位到底是什么"。
 *
 * ## 为什么面积必须先知道坐标系
 *
 * 面积是**带量纲**的量。坐标 (100, 100) 在米制投影里是 100 米 × 100 米 = 1 万 m²；
 * 在经纬度里是 100° × 100° —— 度² 不是面积，拿它换算成"多少平方米"是错的
 * （差了一个纬度方向的收缩因子，越往高纬偏得越多）。
 * 所以：
 *  - 图层是**经纬度**（GEOGCRS）→ 算面积直接报错，不给一个看着精确的数字；
 *  - 图层是**投影**（PROJCRS）→ 按平算，坐标单位通常是米，再按 areaUnit 换算；
 *  - 图层**没有坐标系** → 不知道坐标单位是什么，同样报错。
 *
 * 长度没有这个问题那么致命（度也是长度单位），所以经纬度下允许算长度，
 * 但必须说清单位是"度"而不是米。
 *
 * ## 为什么自己算而不用 GDAL 的 OGR_G_Area
 *
 * 引擎的几何层（src/engine/geometry/）是纯函数、不碰 GDAL，
 * 而这里要的量算跟空间连接是同一套口径（同样的归一化、同样的洞处理）。
 * 另起一套 GDAL 量算会出现"引擎说 100、ArcGIS 说 98"这种对不上的情况，
 * 而用户是拿着 ArcGIS 的数字来质疑的。
 */
import { normalizeGeometry } from '../geometry/index.ts';
import type { NormalizedGeometry, Position } from '../geometry/types.ts';
import type { FeatureGeometry, LayerInfo } from '../vector/types.ts';
import { VectorError } from '../vector/types.ts';

/**
 * 这个图层的坐标系是什么量纲。
 *
 * `metersPerUnit` 是「1 个坐标单位等于多少米」，面积要乘它的平方。
 * 认不出来时是 null —— 那时面积不能换算成 m²，要报错而不是猜。
 */
export interface CrsMeasure {
  readonly kind: 'geographic' | 'projected' | 'unknown';
  /** 1 个坐标单位等于多少米；null = 认不出来 */
  readonly metersPerUnit: number | null;
  /** 长度的单位说法（写进报告里） */
  readonly unitLabel: string;
  /** 是否是米制（面积能直接按 m² 算） */
  readonly isMeters: boolean;
}

/** 面积单位 → 1 个该单位等于多少 m²。 */
const AREA_UNITS: Readonly<Record<string, { readonly squareMeters: number; readonly label: string }>> = {
  m2: { squareMeters: 1, label: 'm²' },
  ha: { squareMeters: 10_000, label: '公顷' },
  mu: { squareMeters: 20000 / 3, label: '亩' },
  km2: { squareMeters: 1_000_000, label: 'km²' },
};

/** 契约里 areaUnit 的全部取值。 */
export const AREA_UNIT_KEYS: readonly string[] = Object.keys(AREA_UNITS);

/** 面积单位的换算系数（1 个该单位 = 多少 m²）。 */
export function areaUnitSquareMeters(unit: string): number {
  const found = AREA_UNITS[unit];
  if (!found) {
    throw new VectorError(
      `不认识面积单位「${unit}」（可选：${AREA_UNIT_KEYS.join(' / ')}）`,
    );
  }
  return found.squareMeters;
}

/** 面积单位的中文说法。 */
export function areaUnitLabel(unit: string): string {
  return AREA_UNITS[unit]?.label ?? unit;
}

/**
 * 从图层的坐标系里读出量纲。
 *
 * 判据用 WKT 的**第一个关键字**（GDAL 3.x 给的是 WKT2）：
 *  - `PROJCRS` / `PROJCS` → 投影坐标；单位取 WKT 里**最后一个** LENGTHUNIT
 *    （投影坐标系的 CS/AXIS 段在最后，椭球段里那个是椭球的单位，不是坐标系的）；
 *  - `GEOGCRS` / `GEOGCS` → 经纬度。
 *
 * ⚠️ 为什么不能简单地问"字符串里有没有 GEOGCRS"：
 * 投影坐标系的 WKT2 里有一段 `BASEGEOGCRS["WGS 84", ...]` ——
 * 那是它的基准大地坐标系，里面**含 GEOGCRS 这个子串**。
 * 用 includes 判会把 EPSG:3857 这种米制投影误判成经纬度，
 * 于是"面积算不了"的报错会出现在一个明明是米制的图层上（实测踩过）。
 * 所以只能看**开头那个关键字**。
 */
export function crsMeasureOf(info: LayerInfo): CrsMeasure {
  const wkt = info.srsWkt;
  if (!wkt || wkt.trim() === '') {
    return { kind: 'unknown', metersPerUnit: null, unitLabel: '坐标单位', isMeters: false };
  }
  const head = /^\s*([A-Za-z]+)\s*\[/.exec(wkt);
  const keyword = (head?.[1] ?? '').toUpperCase();

  // BOUNDCRS / COMPOUNDCRS：里面套着真正的坐标系，往里找一层
  let kind: 'geographic' | 'projected' | 'unknown' = 'unknown';
  if (keyword === 'PROJCRS' || keyword === 'PROJCS') {
    kind = 'projected';
  } else if (keyword === 'GEOGCRS' || keyword === 'GEOGCS' || keyword === 'GEODCRS' || keyword === 'ENGCRS') {
    kind = 'geographic';
  } else if (keyword === 'BOUNDCRS' || keyword === 'COMPOUNDCRS') {
    if (/PROJCRS\[|PROJCS\[/.test(wkt)) kind = 'projected';
    else if (/GEOGCRS\[|GEOGCS\[/.test(wkt)) kind = 'geographic';
  }

  if (kind === 'geographic') {
    return { kind: 'geographic', metersPerUnit: null, unitLabel: '度', isMeters: false };
  }
  if (kind !== 'projected') {
    return { kind: 'unknown', metersPerUnit: null, unitLabel: '坐标单位', isMeters: false };
  }

  const units = [...wkt.matchAll(/LENGTHUNIT\["([^"]+)",\s*([0-9.eE+-]+)\]/g)];
  const last = units[units.length - 1];
  if (!last) {
    return { kind: 'projected', metersPerUnit: null, unitLabel: '坐标单位', isMeters: false };
  }
  const factor = Number(last[2]);
  if (!Number.isFinite(factor) || factor <= 0) {
    return { kind: 'projected', metersPerUnit: null, unitLabel: '坐标单位', isMeters: false };
  }
  const name = last[1] ?? '';
  if (/metre|meter/i.test(name)) {
    return { kind: 'projected', metersPerUnit: factor, unitLabel: '米', isMeters: true };
  }
  return {
    kind: 'projected',
    metersPerUnit: factor,
    unitLabel: `${name}（1 单位 = ${factor} 米）`,
    isMeters: false,
  };
}

/**
 * 面积能不能按 areaUnit 算；不能就把原因说清楚。
 *
 * @throws {VectorError} 经纬度、没坐标系、或投影单位认不出来。
 */
export function requireAreaCapable(measure: CrsMeasure, epsg: number | null): void {
  if (measure.kind === 'geographic') {
    const tag = epsg !== null ? `EPSG:${epsg}` : '经纬度坐标';
    throw new VectorError(
      `这个图层的坐标系是${tag}，按平面算出来的面积没有意义（度² 不是面积，` +
        `越往高纬偏得越多）。要汇总面积，先把图层投影到米制投影坐标系；` +
        `或者去掉 area 这一项，只统计数量。`,
    );
  }
  if (measure.kind === 'unknown') {
    throw new VectorError(
      '这个图层没有坐标系，算不出面积（不知道坐标单位是什么，没法换算成 m²）。' +
        '给图层补上坐标系，或去掉 area 这一项。',
    );
  }
  if (measure.metersPerUnit === null) {
    throw new VectorError(
      '这个图层的投影坐标系单位认不出来，算不出面积（换算不到 m²）。' +
        '给图层补上能读出单位的坐标系，或去掉 area 这一项。',
    );
  }
}

/** 一个环的有符号面积（鞋带公式，环按隐式闭合处理）。 */
function ringArea(ring: readonly Position[]): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const pi = ring[i]!;
    const pj = ring[j]!;
    sum += (pj[0] - pi[0]) * (pj[1] + pi[1]);
  }
  return sum / 2;
}

/** 一个环的周长（首尾相接）。 */
function ringPerimeter(ring: readonly Position[]): number {
  let total = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

/** 一条线的长度。 */
function lineLength(line: readonly Position[]): number {
  let total = 0;
  for (let i = 0; i + 1 < line.length; i += 1) {
    const a = line[i]!;
    const b = line[i + 1]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

/**
 * 平面的面积（**坐标单位²**，不是 m²）。
 *
 * 口径与几何层一致（见 geometry/primitives.ts 顶部说明）：
 *  - 面：外环面积减去各洞的面积，绕向不参与判断（真实数据的绕向不可靠）；
 *  - 线、点：0（它们没有面积）。
 *
 * @param label 出错时用来定位是哪条要素的几何坏了。
 */
export function planarArea(geometry: FeatureGeometry | null, label = '要素'): number {
  if (!geometry) return 0;
  return areaOfNormalized(normalizeGeometry(geometry, label));
}

/** 归一化几何的面积（供内部复用：同一个几何不必归一化两遍）。 */
function areaOfNormalized(g: NormalizedGeometry): number {
  if (g.kind !== 'area') return 0;
  let total = 0;
  for (const group of g.polygons) {
    const outer = group[0];
    if (!outer) continue;
    let area = Math.abs(ringArea(outer));
    for (let i = 1; i < group.length; i += 1) {
      const hole = group[i];
      if (!hole) continue;
      area -= Math.abs(ringArea(hole));
    }
    total += area;
  }
  return total;
}

/**
 * 平面的长度（**坐标单位**，不是米）。
 *
 * 口径与 ArcGIS Pro 的 Shape Length 一致：
 *  - 线：线长；多段线是各段之和；
 *  - 面：周长（面要素的"长度"就是它的边长）；
 *  - 点：0。
 */
export function planarLength(geometry: FeatureGeometry | null, label = '要素'): number {
  if (!geometry) return 0;
  return lengthOfNormalized(normalizeGeometry(geometry, label));
}

/** 归一化几何的长度（供内部复用）。 */
function lengthOfNormalized(g: NormalizedGeometry): number {
  if (g.kind === 'line') {
    let total = 0;
    for (const line of g.lines) total += lineLength(line);
    return total;
  }
  if (g.kind === 'area') {
    let total = 0;
    for (const group of g.polygons) {
      for (const ring of group) total += ringPerimeter(ring);
    }
    return total;
  }
  return 0;
}

/** 几何是哪一类（点 / 线 / 面）。没有几何按点算（大小为 0）。 */
export function geometryKind(geometry: FeatureGeometry | null): 'point' | 'line' | 'area' {
  if (!geometry) return 'point';
  return normalizeGeometry(geometry, '要素').kind;
}

/**
 * 这个要素"有多大"（用来判 keep=largest）。
 *
 * 用的是同一套平面量算：面看面积、线看长度、点算 0。
 * 为什么单位不影响结果：largest 只比大小，不比绝对值 ——
 * 坐标系是米还是英尺，全都会按同一个系数缩放，名次不变。
 */
export function featureSize(geometry: FeatureGeometry | null, label = '要素'): number {
  if (!geometry) return 0;
  const g = normalizeGeometry(geometry, label);
  if (g.kind === 'area') return areaOfNormalized(g);
  if (g.kind === 'line') return lengthOfNormalized(g);
  return 0;
}

/** 归一化后的几何类别（给报告用："面要素 / 线要素 / 点要素"）。 */
export function geometryKindLabel(geometry: FeatureGeometry | null): string {
  if (!geometry) return '没有几何';
  const g: NormalizedGeometry = normalizeGeometry(geometry, '要素');
  if (g.kind === 'area') return '面要素';
  if (g.kind === 'line') return '线要素';
  return '点要素';
}
