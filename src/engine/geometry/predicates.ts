/**
 * 空间谓词：点在面内、两几何相交、一几何包含另一几何。
 *
 * ── 边界的统一口径（本模块最重要的一条约定） ──
 *
 * 面被当作**闭集**：点在面的外环边界上算「在面内」，点在洞（内环）的边界上
 * 也算「在面内」，只有洞的**内部**才算被挖掉。
 *
 * 为什么这么定：
 *   1. 与相交判定自洽。任何压在边界上的东西都算「与面相交」；如果边界点
 *      反而算「不在里面」，用户会拿到「相交了但没包含」这种看起来自相矛盾的
 *      组合——同一个点在两个算子里得到相反的结论。
 *   2. 不丢要素。落在行政区边界上的点如果判为「不在任何区内」，它会进
 *      「无匹配」列表，用户会以为数据漏了，而实际只是几何精度问题。
 *   3. 可测。边界判定有明确公式（有向距离 + 包围盒双重判定），
 *      能写测试钉死，换平台不会飘。
 *
 * 代价（必须写清楚）：紧邻两个面共享一条边界时，压在这条边界上的目标要素
 * 会**同时**匹配两个源要素。这与 GEOS 的 `covers` 语义一致，
 * 也是保守的选择——多匹配会暴露给用户，少匹配会静默丢数据。
 */
import { GeometryError } from './errors.ts';
import { normalizeGeometry, readInputPoint } from './normalize.ts';
import {
  bboxContains,
  bboxOfVertices,
  bboxOverlaps,
  clamp01,
  distancePoints,
  orientation,
  lineSegments,
  pointOnAnySegment,
  pointOnSegment,
  ringSegments,
  segmentIntersectionParams,
  segmentsIntersect,
} from './primitives.ts';
import type { BBox, NormalizedGeometry, Position } from './types.ts';

/* ───────────────────── 环内判定（射线法） ───────────────────── */

/** 射线法：数射线与环的交点个数，奇数在内、偶数在外。 */
function crossingTest(p: Position, ring: readonly Position[]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (!pi || !pj) continue;
    // 半开区间比较 ((yi > y) !== (yj > y))：顶点只会被数一次，不会重复计数
    if (pi[1] > p[1] !== pj[1] > p[1]) {
      const t = (p[1] - pi[1]) / (pj[1] - pi[1]);
      const xCross = pi[0] + t * (pj[0] - pi[0]);
      if (p[0] < xCross) inside = !inside;
    }
  }
  return inside;
}

/** 点是否落在环的边界上。 */
function pointOnRingBoundary(p: Position, ring: readonly Position[]): boolean {
  for (const [a, b] of ringSegments(ring)) {
    if (pointOnSegment(p, a, b)) return true;
  }
  return false;
}

/** 点在环内（闭集：边界算在内）。 */
function pointInRing(p: Position, ring: readonly Position[]): boolean {
  if (pointOnRingBoundary(p, ring)) return true;
  return crossingTest(p, ring);
}

/** 点在环的严格内部（边界不算）。 */
function pointInRingStrict(p: Position, ring: readonly Position[]): boolean {
  if (pointOnRingBoundary(p, ring)) return false;
  return crossingTest(p, ring);
}

/* ───────────────────── 归一化层面的判定 ───────────────────── */

/**
 * 点是否落在面内（闭集口径：外环边界算内，洞的边界也算内，只有洞的内部被挖掉）。
 *
 * 多部件面：落在任何一个部件里就算落在面内。
 */
export function pointInNormalizedPolygon(p: Position, area: NormalizedGeometry): boolean {
  for (const group of area.polygons) {
    const outer = group[0];
    if (!outer) continue;
    if (!pointInRing(p, outer)) continue;
    let inHole = false;
    for (let i = 1; i < group.length; i++) {
      const hole = group[i];
      if (!hole) continue;
      // 洞的边界属于面的边界，所以这里用「严格内部」：只有真的掉进洞里才排除
      if (pointInRingStrict(p, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/** 线段是否整段落在面内（闭集）。 */
function segmentContainedInPolygon(p: Position, q: Position, area: NormalizedGeometry): boolean {
  if (!pointInNormalizedPolygon(p, area)) return false;
  if (!pointInNormalizedPolygon(q, area)) return false;
  // 把线段按它与面边界的交点切开，逐段取中点判断。
  // 只判端点是不够的：一条线可以从面里出去再绕回来，端点都在里面。
  const cuts = new Set<number>([0, 1]);
  for (const group of area.polygons) {
    for (const ring of group) {
      for (const [a, b] of ringSegments(ring)) {
        for (const t of segmentIntersectionParams(p, q, a, b)) {
          cuts.add(clamp01(t));
        }
      }
    }
  }
  const ts = [...cuts].sort((x, y) => x - y);
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    if (t0 === undefined || t1 === undefined) continue;
    if (t1 - t0 <= 1e-12) continue;
    const tm = (t0 + t1) / 2;
    const mid: Position = [p[0] + (q[0] - p[0]) * tm, p[1] + (q[1] - p[1]) * tm];
    if (!pointInNormalizedPolygon(mid, area)) return false;
  }
  return true;
}

/** 归一化几何的包围盒。 */
export function bboxOfNormalized(g: NormalizedGeometry): BBox {
  return bboxOfVertices(g.vertices);
}

/** 点是否命中目标几何（点落在线上，或点落在面内）。 */
function pointHits(target: NormalizedGeometry, p: Position): boolean {
  if (target.kind === 'line') {
    for (const line of target.lines) {
      for (const [a, b] of lineSegments(line)) {
        if (pointOnSegment(p, a, b)) return true;
      }
    }
    return false;
  }
  return pointInNormalizedPolygon(p, target);
}

/** 线与面是否相交（线穿过面、压住边界、或整条线在面内）。 */
function lineHitsArea(lines: readonly (readonly Position[])[], area: NormalizedGeometry): boolean {
  for (const line of lines) {
    for (const [a, b] of lineSegments(line)) {
      for (const group of area.polygons) {
        for (const ring of group) {
          for (const [c, d] of ringSegments(ring)) {
            if (segmentsIntersect(a, b, c, d)) return true;
          }
        }
      }
    }
    // 整条线在面内（没有任何边界相交）时，端点必然在面内
    for (const p of line) {
      if (pointInNormalizedPolygon(p, area)) return true;
    }
  }
  return false;
}

/** 两个面是否相交（边界交叉，或一方整体落在另一方内）。 */
function areasIntersect(a: NormalizedGeometry, b: NormalizedGeometry): boolean {
  for (const groupA of a.polygons) {
    for (const ringA of groupA) {
      for (const [a1, a2] of ringSegments(ringA)) {
        for (const groupB of b.polygons) {
          for (const ringB of groupB) {
            for (const [b1, b2] of ringSegments(ringB)) {
              if (segmentsIntersect(a1, a2, b1, b2)) return true;
            }
          }
        }
      }
    }
  }
  // 一方完全在另一方内时，边界不会交叉，只能靠顶点判定
  for (const groupA of a.polygons) {
    for (const ringA of groupA) {
      for (const p of ringA) {
        if (pointInNormalizedPolygon(p, b)) return true;
      }
    }
  }
  for (const groupB of b.polygons) {
    for (const ringB of groupB) {
      for (const p of ringB) {
        if (pointInNormalizedPolygon(p, a)) return true;
      }
    }
  }
  return false;
}

/** 归一化几何是否相交。 */
export function intersectsNormalized(a: NormalizedGeometry, b: NormalizedGeometry): boolean {
  if (!bboxOverlaps(bboxOfNormalized(a), bboxOfNormalized(b))) return false;
  if (a.kind === 'point' && b.kind === 'point') {
    const pa = a.points[0];
    const pb = b.points[0];
    if (!pa || !pb) return false;
    return distancePoints(pa, pb) <= 1e-12;
  }
  if (a.kind === 'point') {
    const p = a.points[0];
    return p ? pointHits(b, p) : false;
  }
  if (b.kind === 'point') {
    const p = b.points[0];
    return p ? pointHits(a, p) : false;
  }
  if (a.kind === 'line' && b.kind === 'line') {
    for (const la of a.lines) {
      for (const [a1, a2] of lineSegments(la)) {
        for (const lb of b.lines) {
          for (const [b1, b2] of lineSegments(lb)) {
            if (segmentsIntersect(a1, a2, b1, b2)) return true;
          }
        }
      }
    }
    return false;
  }
  if (a.kind === 'line') return lineHitsArea(a.lines, b);
  if (b.kind === 'line') return lineHitsArea(b.lines, a);
  return areasIntersect(a, b);
}

/**
 * 归一化几何的包含判定：outer 是否**完整**包含 inner。
 *
 * 支持的组合（其余一律判为不包含）：
 *   - 外层是面：内层可以是点、线、面。点的判定用闭集射线法；线与面逐段判定
 *     「整段落在外层里」。
 *   - 外层是线：内层可以是点（落在线上）或线（整段落在外层的某一段上）。
 *     跨段折线的内层线不支持——那是「沿着外层走」而不是「落在外层里」，
 *     判成不包含更保守。
 *   - 外层是点：只有内层也是同一个点时才算包含。
 */
export function containsNormalized(outer: NormalizedGeometry, inner: NormalizedGeometry): boolean {
  if (outer.kind === 'area') {
    if (inner.kind === 'point') {
      return inner.points.every((p) => pointInNormalizedPolygon(p, outer));
    }
    if (inner.kind === 'line') {
      for (const line of inner.lines) {
        for (const [a, b] of lineSegments(line)) {
          if (!segmentContainedInPolygon(a, b, outer)) return false;
        }
      }
      return true;
    }
    for (const group of inner.polygons) {
      for (const ring of group) {
        for (const [a, b] of ringSegments(ring)) {
          if (!segmentContainedInPolygon(a, b, outer)) return false;
        }
      }
    }
    return true;
  }
  if (outer.kind === 'line') {
    const segments: [Position, Position][] = [];
    for (const line of outer.lines) {
      for (const seg of lineSegments(line)) segments.push(seg);
    }
    if (inner.kind === 'point') {
      return inner.points.every((p) => pointOnAnySegment(p, segments));
    }
    if (inner.kind === 'line') {
      for (const line of inner.lines) {
        for (const [a, b] of lineSegments(line)) {
          // 内层线段必须整体落在外层的某一段上
          const covered = segments.some(([s, e]) => pointOnSegment(a, s, e) && pointOnSegment(b, s, e));
          if (!covered) return false;
        }
      }
      return true;
    }
    return false;
  }
  // 外层是点
  const p = outer.points[0];
  if (!p) return false;
  if (inner.kind === 'point') {
    return inner.points.every((q) => distancePoints(p, q) <= 1e-12);
  }
  return false;
}

/* ───────────────────── 公开 API ───────────────────── */

/**
 * 点是否落在多边形内（射线法，闭集口径）。
 *
 * @param point 待判定的点
 * @param polygon 多边形几何（Polygon / MultiPolygon）
 */
export function pointInPolygon(
  point: readonly [number, number],
  polygon: unknown,
): boolean {
  const p = readInputPoint(point, '待判定的点');
  const g = normalizeGeometry(polygon, '多边形');
  if (g.kind !== 'area') {
    throw new GeometryError('pointInPolygon 需要面几何（Polygon / MultiPolygon）');
  }
  return pointInNormalizedPolygon(p, g);
}

/**
 * 两个几何是否相交（相交即可，不要求包含）。
 *
 * 先用包围盒粗判，不重叠直接返回 false；重叠才做真实判定。
 */
export function geometryIntersects(a: unknown, b: unknown): boolean {
  const ga = normalizeGeometry(a, '几何 A');
  const gb = normalizeGeometry(b, '几何 B');
  return intersectsNormalized(ga, gb);
}

/**
 * outer 是否完整包含 inner。
 *
 * 方向不可逆：`contains(a, b)` 为真不代表 `contains(b, a)` 为真。
 */
export function contains(outer: unknown, inner: unknown): boolean {
  const go = normalizeGeometry(outer, '外层几何');
  const gi = normalizeGeometry(inner, '内层几何');
  return containsNormalized(go, gi);
}

/**
 * 包围盒粗判的两个方向。
 *
 * 为什么单独提供：空间连接要筛掉大量不可能的候选对，「目标完全落在源里」
 * 必然意味着目标包围盒也被源包围盒包住，反之亦然——这是必要条件，
 * 用来做 O(n×m) 的前置剪枝。
 */
export function bboxPreFilter(
  relation: 'within' | 'intersects' | 'contains',
  targetBox: BBox,
  sourceBox: BBox,
): boolean {
  if (relation === 'intersects') return bboxOverlaps(targetBox, sourceBox);
  if (relation === 'within') return bboxContains(sourceBox, targetBox);
  return bboxContains(targetBox, sourceBox);
}

/** 供上层复用的「点是否在面上」（已归一化版本）。 */
export { pointInNormalizedPolygon as pointInNormalizedArea };

/** 只导出判定所需的内部工具（供本包其它模块复用，不进公开 API）。 */
export { orientation };
