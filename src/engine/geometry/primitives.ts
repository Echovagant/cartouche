/**
 * 平面几何的基本运算：包围盒、点线关系、线线关系、距离。
 *
 * 坐标系口径：**一律按平面直角坐标处理**，不做投影畸变修正。
 *
 * 为什么这么定：空间连接是「两个图层按位置对上」，判定的是拓扑关系
 * （在不在里面、有没有相交），这类判定在投影坐标下与在经纬度下
 * **结论一致**（只要图层不是跨半球这种极端情况），差别只体现在
 * 「距离」和「面积」这类带量纲的结果上。引擎这一层拿到的几何来自
 * 用户自己的数据文件，坐标系未知或各异，要做真实投影必须引入 PROJ
 * （GDAL 里有，但那是子进程，不该进纯函数层），成本与复杂度都划不来。
 *
 * 已知偏差（写在这里是为了别让人误以为是精确量测）：
 *   - 经纬度直接当米算：1° 纬度 ≈ 111 km，1° 经度随纬度变化。
 *     跨大范围（比如一个省的行政区）时，点到点的「距离」会明显偏大或偏小。
 *   - 高斯投影的形变：同一条线在投影坐标下长度与经纬度下按平面算的长度不同。
 *   - 跨 180° 经线的图层：平面算法会认为经度 179 与 -179 相距 358 度。
 *   - 因此 `distanceBetween` 只适合**同一局部范围内**的近邻判断，
 *     跨大范围的量测必须先投影（由上层 op 负责）。
 */
import type { BBox, Position } from './types.ts';

/**
 * 浮点容差（绝对值）。
 *
 * 为什么取 1e-12：它比任何真实数据的坐标精度小得多（经纬度写到 15 位小数
 * 也只有 1e-15 量级的噪声，投影坐标的米级数据更是远离这个量级），
 * 但又足以吸收叉积、射线法这类运算本身的舍入误差。没有容差的话，
 * 「点正好在边上」会因为 1e-16 的偏差被判成「不在边上」，
 * 同一份数据换个平台算结果就不一样——那比偏一点点糟糕得多。
 */
export const EPS = 1e-12;

/** 叉积：(b-a) × (c-a)。 */
export function cross(a: Position, b: Position, c: Position): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/**
 * 叉积的符号：1 / -1 / 0（共线或退化）。
 *
 * 为什么按线长缩放容差：叉积的量纲是「长度²」，坐标一大（比如投影坐标
 * 几百万），同样的浮点误差会让叉积膨胀好几个数量级。固定容差会把
 * 明明不平行的两条线判成共线。
 */
export function orientation(a: Position, b: Position, c: Position): number {
  const v = cross(a, b, c);
  const scale = Math.max(
    1,
    Math.abs(b[0] - a[0]),
    Math.abs(b[1] - a[1]),
    Math.abs(c[0] - a[0]),
    Math.abs(c[1] - a[1]),
  );
  if (Math.abs(v) <= EPS * scale) return 0;
  return v > 0 ? 1 : -1;
}

/** 点 p 是否落在线段 ab 上（含端点）。 */
export function pointOnSegment(p: Position, a: Position, b: Position): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len <= EPS) {
    // 退化线段（两点重合）：退化成「点到点」
    return Math.hypot(p[0] - a[0], p[1] - a[1]) <= EPS;
  }
  const v = cross(a, b, p);
  if (Math.abs(v) > EPS * len) return false;
  // 叉积过了说明共线，再用投影判断是否落在段内
  const dot = (p[0] - a[0]) * dx + (p[1] - a[1]) * dy;
  if (dot < -EPS) return false;
  if (dot > len * len + EPS) return false;
  return true;
}

/** 点 p 是否落在线段集合中的任意一段上。 */
export function pointOnAnySegment(p: Position, segments: readonly (readonly [Position, Position])[]): boolean {
  for (const [a, b] of segments) {
    if (pointOnSegment(p, a, b)) return true;
  }
  return false;
}

/** 两条线段是否相交（含共线重叠与端点相碰）。 */
export function segmentsIntersect(
  a1: Position,
  a2: Position,
  b1: Position,
  b2: Position,
): boolean {
  const s1 = orientation(b1, b2, a1);
  const s2 = orientation(b1, b2, a2);
  const s3 = orientation(a1, a2, b1);
  const s4 = orientation(a1, a2, b2);
  // 严格穿过：两侧符号相反
  if (s1 * s2 < 0 && s3 * s4 < 0) return true;
  // 端点落在对方线段上（含共线接触）
  if (s1 === 0 && pointOnSegment(a1, b1, b2)) return true;
  if (s2 === 0 && pointOnSegment(a2, b1, b2)) return true;
  if (s3 === 0 && pointOnSegment(b1, a1, a2)) return true;
  if (s4 === 0 && pointOnSegment(b2, a1, a2)) return true;
  return false;
}

/**
 * 线段 (p,q) 与线段 (a,b) 的交点参数（以 p→q 为参数轴，取值 0~1）。
 *
 * 为什么需要这个而不是「只判断是否相交」：判断「一段线是否整段落在面里」
 * 时，必须把这段线按它与面边界的交点切成若干小段，逐段取中点判断。
 * 共线重叠的情况要一并算进来，否则「沿着边界走了一半然后拐出多边形」
 * 这种线会被整段当成在内部。
 *
 * 返回空数组表示不相交；返回一个值表示单点相交；两个值表示共线重叠的两端。
 */
export function segmentIntersectionParams(
  p: Position,
  q: Position,
  a: Position,
  b: Position,
): number[] {
  const rx = q[0] - p[0];
  const ry = q[1] - p[1];
  const sx = b[0] - a[0];
  const sy = b[1] - a[1];
  const denom = rx * sy - ry * sx;
  const qpx = a[0] - p[0];
  const qpy = a[1] - p[1];
  const scale = Math.max(
    1,
    Math.abs(rx),
    Math.abs(ry),
    Math.abs(sx),
    Math.abs(sy),
    Math.abs(qpx),
    Math.abs(qpy),
  );
  const tol = EPS * scale;
  if (Math.abs(denom) > tol) {
    const t = (qpx * sy - qpy * sx) / denom;
    const u = (qpx * ry - qpy * rx) / denom;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return [];
    return [clamp01(t)];
  }
  // 平行：再判是否共线
  if (Math.abs(qpx * ry - qpy * rx) > tol) return [];
  const rr = rx * rx + ry * ry;
  if (rr === 0) return [];
  const t1 = (qpx * rx + qpy * ry) / rr;
  const t2 = ((b[0] - p[0]) * rx + (b[1] - p[1]) * ry) / rr;
  const lo = Math.max(0, Math.min(t1, t2));
  const hi = Math.min(1, Math.max(t1, t2));
  if (lo > hi) return [];
  if (lo === hi) return [lo];
  return [lo, hi];
}

/** 把参数夹到 0~1。 */
export function clamp01(t: number): number {
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

/** 由顶点集合算包围盒。 */
export function bboxOfVertices(vertices: readonly Position[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of vertices) {
    if (v[0] < minX) minX = v[0];
    if (v[0] > maxX) maxX = v[0];
    if (v[1] < minY) minY = v[1];
    if (v[1] > maxY) maxY = v[1];
  }
  return { minX, minY, maxX, maxY };
}

/** 两个包围盒是否可能相交（含边界接触）。 */
export function bboxOverlaps(a: BBox, b: BBox): boolean {
  return (
    a.minX <= b.maxX + EPS &&
    b.minX <= a.maxX + EPS &&
    a.minY <= b.maxY + EPS &&
    b.minY <= a.maxY + EPS
  );
}

/** 包围盒 a 是否包含包围盒 b（允许 EPS 级别的边界误差）。 */
export function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    inner.minX >= outer.minX - EPS &&
    inner.maxX <= outer.maxX + EPS &&
    inner.minY >= outer.minY - EPS &&
    inner.maxY <= outer.maxY + EPS
  );
}

/** 两点距离。 */
export function distancePoints(a: Position, b: Position): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 点到线段的最短距离。 */
export function distancePointSegment(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distancePoints(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const proj: Position = [a[0] + t * dx, a[1] + t * dy];
  return distancePoints(p, proj);
}

/** 两条线段的最短距离（相交时为 0）。 */
export function distanceSegmentSegment(
  a1: Position,
  a2: Position,
  b1: Position,
  b2: Position,
): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    distancePointSegment(a1, b1, b2),
    distancePointSegment(a2, b1, b2),
    distancePointSegment(b1, a1, a2),
    distancePointSegment(b2, a1, a2),
  );
}

/**
 * 把线切成线段（**不**首尾相接）。
 *
 * 为什么和环要分开：LineString 是开放的，两端之间没有连线；
 * 环是闭合的，少写最后一个点的数据要按闭合处理（见 ringSegments）。
 * 用同一个函数会让开放线多出一条「回到起点」的假线段——
 * 那条线段会让一条根本没碰到面的线被判成相交。
 */
export function lineSegments(line: readonly Position[]): [Position, Position][] {
  const out: [Position, Position][] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    if (!a || !b) continue;
    out.push([a, b]);
  }
  return out;
}

/**
 * 把环切成线段（首尾相接）。
 *
 * 为什么显式闭合：GeoJSON 规定环应当首尾相同，但真实数据常常少写最后一个点。
 * 这里一律按「隐式闭合」处理，两种数据得到同一组线段，结果一致。
 */
export function ringSegments(ring: readonly Position[]): [Position, Position][] {
  const out: [Position, Position][] = [];
  const n = ring.length;
  for (let i = 0; i + 1 < n; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if (!a || !b) continue;
    out.push([a, b]);
  }
  if (n >= 2) {
    const a = ring[n - 1];
    const b = ring[0];
    if (a && b) out.push([a, b]);
  }
  return out;
}
