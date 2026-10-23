/**
 * 几何的量：包围盒、质心、距离。
 *
 * 口径提醒：这里的坐标一律按平面直角坐标处理，不做投影畸变修正。
 * 跨大范围时距离会偏（经纬度直接当米算），详见 `primitives.ts` 顶部的说明。
 */
import { normalizeGeometry } from './normalize.ts';
import { intersectsNormalized } from './predicates.ts';
import {
  distancePointSegment,
  distancePoints,
  distanceSegmentSegment,
  lineSegments,
  ringSegments,
} from './primitives.ts';
import type { BBox, NormalizedGeometry, Position } from './types.ts';

/**
 * 几何的包围盒。
 *
 * 空几何（null / undefined）返回 null——这是「这个要素没有位置」，
 * 和「几何坏了」不是一回事，调用方据此决定跳过还是报错。
 * 几何存在但坐标非法（NaN、维数不对）一律抛错，不返回半成品包围盒。
 */
export function bboxOf(geometry: unknown): BBox | null {
  if (geometry === null || geometry === undefined) return null;
  const g = normalizeGeometry(geometry, '几何');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of g.vertices) {
    if (v[0] < minX) minX = v[0];
    if (v[0] > maxX) maxX = v[0];
    if (v[1] < minY) minY = v[1];
    if (v[1] > maxY) maxY = v[1];
  }
  return { minX, minY, maxX, maxY };
}

/* ───────────────────── 质心 ───────────────────── */

interface AreaCentroid {
  /** 有符号面积（用于按外环/洞的方位加权）。 */
  readonly area: number;
  readonly cx: number;
  readonly cy: number;
}

/** 环的面积与质心（鞋带公式，环按隐式闭合处理）。 */
function ringAreaCentroid(ring: readonly Position[]): AreaCentroid {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (!pi || !pj) continue;
    const f = pi[0] * pj[1] - pj[0] * pi[1];
    a += f;
    cx += (pi[0] + pj[0]) * f;
    cy += (pi[1] + pj[1]) * f;
  }
  const area = a * 0.5;
  if (area === 0) return { area: 0, cx: 0, cy: 0 };
  return { area, cx: cx / (6 * area), cy: cy / (6 * area) };
}

/**
 * 一个多边形（外环 + 洞）的面积与质心。
 *
 * 洞按面积扣减：外环面积减去各洞面积，质心按面积加权。
 * 环的绕向不参与判断（真实数据的绕向不可靠），一律以「第一个环是外环」为准。
 */
function polygonCentroid(group: readonly (readonly Position[])[]): AreaCentroid {
  const outer = group[0];
  if (!outer) return { area: 0, cx: 0, cy: 0 };
  const o = ringAreaCentroid(outer);
  const outerArea = Math.abs(o.area);
  let area = outerArea;
  let cx = outerArea * o.cx;
  let cy = outerArea * o.cy;
  for (let i = 1; i < group.length; i++) {
    const hole = group[i];
    if (!hole) continue;
    const h = ringAreaCentroid(hole);
    const holeArea = Math.abs(h.area);
    area -= holeArea;
    cx -= holeArea * h.cx;
    cy -= holeArea * h.cy;
  }
  if (area === 0) return { area: 0, cx: 0, cy: 0 };
  return { area, cx: cx / area, cy: cy / area };
}

/** 顶点的算术平均（退化几何的兜底质心）。 */
function vertexMean(vertices: readonly Position[]): [number, number] | null {
  if (vertices.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const v of vertices) {
    sx += v[0];
    sy += v[1];
  }
  return [sx / vertices.length, sy / vertices.length];
}

/**
 * 几何的质心。
 *
 * 口径：
 *   - 点：就是它自己；多点：算术平均。
 *   - 线：按段长加权（线越长，对质心贡献越大）。
 *   - 面：按面积加权，洞被扣掉。
 *   - 退化面（面积为 0，如共线点堆成的环）：退回顶点平均。
 *
 * 空几何返回 null。
 */
export function centroidOf(geometry: unknown): [number, number] | null {
  if (geometry === null || geometry === undefined) return null;
  const g = normalizeGeometry(geometry, '几何');
  return centroidNormalized(g);
}

/** 归一化几何的质心（供本包内部与空间连接复用）。 */
export function centroidNormalized(g: NormalizedGeometry): [number, number] | null {
  if (g.kind === 'point') {
    return vertexMean(g.points);
  }
  if (g.kind === 'line') {
    let totalLen = 0;
    let sx = 0;
    let sy = 0;
    for (const line of g.lines) {
      for (const [a, b] of lineSegments(line)) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        totalLen += len;
        sx += (len * (a[0] + b[0])) / 2;
        sy += (len * (a[1] + b[1])) / 2;
      }
    }
    if (totalLen > 0) return [sx / totalLen, sy / totalLen];
    return vertexMean(g.vertices);
  }
  let totalArea = 0;
  let sx = 0;
  let sy = 0;
  for (const group of g.polygons) {
    const c = polygonCentroid(group);
    const w = Math.abs(c.area);
    totalArea += w;
    sx += w * c.cx;
    sy += w * c.cy;
  }
  if (totalArea > 0) return [sx / totalArea, sy / totalArea];
  return vertexMean(g.vertices);
}

/* ───────────────────── 距离 ───────────────────── */

/** 点到线/面几何的最短距离（相交时已在上层判为 0）。 */
function distancePointToGeometry(p: Position, g: NormalizedGeometry): number {
  let best = Infinity;
  if (g.kind === 'line') {
    for (const line of g.lines) {
      for (const [a, b] of lineSegments(line)) {
        best = Math.min(best, distancePointSegment(p, a, b));
      }
    }
  } else {
    for (const group of g.polygons) {
      for (const ring of group) {
        for (const [a, b] of ringSegments(ring)) {
          best = Math.min(best, distancePointSegment(p, a, b));
        }
      }
    }
  }
  return best;
}

/** 线到面的最短距离。 */
function distanceLineToArea(
  lines: readonly (readonly Position[])[],
  area: NormalizedGeometry,
): number {
  let best = Infinity;
  for (const line of lines) {
    for (const [a, b] of lineSegments(line)) {
      for (const group of area.polygons) {
        for (const ring of group) {
          for (const [c, d] of ringSegments(ring)) {
            best = Math.min(best, distanceSegmentSegment(a, b, c, d));
          }
        }
      }
    }
  }
  return best;
}

/** 面到面的最短距离。 */
function distanceAreaToArea(a: NormalizedGeometry, b: NormalizedGeometry): number {
  let best = Infinity;
  for (const groupA of a.polygons) {
    for (const ringA of groupA) {
      for (const [a1, a2] of ringSegments(ringA)) {
        for (const groupB of b.polygons) {
          for (const ringB of groupB) {
            for (const [b1, b2] of ringSegments(ringB)) {
              best = Math.min(best, distanceSegmentSegment(a1, a2, b1, b2));
            }
          }
        }
      }
    }
  }
  return best;
}

/**
 * 两个几何的最短距离。
 *
 * - 点-点：精确欧氏距离。
 * - 点-线、线-线：线段之间的最短距离。
 * - 含面的组合：相交即为 0；不相交时取边界之间的最短距离。
 *
 * 坐标系按平面直角处理，跨大范围会有偏差（见 primitives.ts 顶部说明）。
 */
export function distanceBetween(a: unknown, b: unknown): number {
  const ga = normalizeGeometry(a, '几何 A');
  const gb = normalizeGeometry(b, '几何 B');
  return distanceNormalized(ga, gb);
}

/** 归一化几何之间的距离（供本包内部与空间连接复用）。 */
export function distanceNormalized(a: NormalizedGeometry, b: NormalizedGeometry): number {
  if (intersectsNormalized(a, b)) return 0;
  const pa = a.points[0];
  const pb = b.points[0];
  if (a.kind === 'point' && b.kind === 'point') {
    return pa && pb ? distancePoints(pa, pb) : 0;
  }
  if (a.kind === 'point' && pa) return distancePointToGeometry(pa, b);
  if (b.kind === 'point' && pb) return distancePointToGeometry(pb, a);
  if (a.kind === 'line' && b.kind === 'line') {
    let best = Infinity;
    for (const la of a.lines) {
      for (const [a1, a2] of lineSegments(la)) {
        for (const lb of b.lines) {
          for (const [b1, b2] of lineSegments(lb)) {
            best = Math.min(best, distanceSegmentSegment(a1, a2, b1, b2));
          }
        }
      }
    }
    return best;
  }
  if (a.kind === 'line') return distanceLineToArea(a.lines, b);
  if (b.kind === 'line') return distanceLineToArea(b.lines, a);
  return distanceAreaToArea(a, b);
}
