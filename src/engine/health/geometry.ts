/**
 * 逐要素的几何退化检查 —— **纯内存**，不需要 GDAL、不需要 SpatiaLite。
 *
 * 为什么单独一层：这些判定只要拿到顶点序列就能算，放在纯函数层有三个好处：
 *   1. 单元测试不用起子进程；
 *   2. 不受 GDAL / SpatiaLite 版本影响（本机 GDAL 没编进 SpatiaLite 时，
 *      这一族检查照跑不误，不会跟着拓扑检查一起消失）；
 *   3. 判的是「数据是不是退化」，与 GEOS 判的「几何合不合法」是**两个角度**，
 *      两者都会报，但报的是不同的事实。
 *
 * 与拓扑检查（自相交 / 面重叠）的分工见 topology.ts。
 */
import type { Finding } from './types.ts';
import type { ScannedFeature, ScannedGeometry } from './scan.ts';

export type Position = readonly [number, number];

/** 一个面：外环 + 内环（洞） */
export interface PolygonGroup {
  readonly outer: readonly Position[];
  readonly holes: readonly (readonly Position[])[];
}

/* ───────────────────── 几何结构展开 ───────────────────── */

/** 把 GeoJSON 坐标里的一个点读成 [x, y]；读不出来就返回 null */
function toPosition(v: unknown): Position | null {
  if (!Array.isArray(v)) return null;
  const x = v[0];
  const y = v[1];
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

/** 一条坐标序列（点集） */
function toPositions(coords: unknown): Position[] {
  const out: Position[] = [];
  if (!Array.isArray(coords)) return out;
  for (const c of coords) {
    const p = toPosition(c);
    if (p) out.push(p);
  }
  return out;
}

/**
 * 面几何拆成「外环 + 洞」。
 *
 * Polygon：coordinates = [ring0, ring1, …]，ring0 是外环。
 * MultiPolygon：coordinates = [[ring0, ring1, …], …]。
 */
export function polygonGroupsOf(geom: ScannedGeometry | null): PolygonGroup[] {
  if (!geom) return [];
  const c = geom.coordinates;
  if (!Array.isArray(c)) return [];
  if (geom.type === 'Polygon') {
    const rings = c.map((r) => toPositions(r)).filter((r) => r.length > 0);
    const outer = rings[0];
    if (!outer) return [];
    return [{ outer, holes: rings.slice(1) }];
  }
  if (geom.type === 'MultiPolygon') {
    const out: PolygonGroup[] = [];
    for (const poly of c) {
      if (!Array.isArray(poly)) continue;
      const rings = poly.map((r) => toPositions(r)).filter((r) => r.length > 0);
      const outer = rings[0];
      if (!outer) continue;
      out.push({ outer, holes: rings.slice(1) });
    }
    return out;
  }
  return [];
}

/** 线几何拆成若干条线 */
export function linesOf(geom: ScannedGeometry | null): Position[][] {
  if (!geom) return [];
  const c = geom.coordinates;
  if (!Array.isArray(c)) return [];
  if (geom.type === 'LineString') {
    const line = toPositions(c);
    return line.length > 0 ? [line] : [];
  }
  if (geom.type === 'MultiLineString') {
    const out: Position[][] = [];
    for (const l of c) {
      const line = toPositions(l);
      if (line.length > 0) out.push(line);
    }
    return out;
  }
  return [];
}

/** 几何里的全部顶点（点 / 线 / 面都要） */
export function verticesOf(geom: ScannedGeometry | null): Position[] {
  if (!geom) return [];
  if (geom.type === 'Point') {
    const p = toPosition(geom.coordinates);
    return p ? [p] : [];
  }
  if (geom.type === 'MultiPoint') {
    return toPositions(geom.coordinates);
  }
  if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
    return linesOf(geom).flat();
  }
  if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
    return polygonGroupsOf(geom).flatMap((g) => [g.outer, ...g.holes]).flat();
  }
  return [];
}

/* ───────────────────── 环的基本量 ───────────────────── */

/**
 * 环的有向面积（鞋带公式）。
 *
 * 返回**带符号**的值：正 = 逆时针，负 = 顺时针，0 = 退化（面积为零）。
 * 环没显式闭合时按隐式闭合处理（少写最后一个点的数据也能算）。
 */
export function ringSignedArea(ring: readonly Position[]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** 环的面积绝对值 */
export function ringAbsArea(ring: readonly Position[]): number {
  return Math.abs(ringSignedArea(ring));
}

/** 环是否显式闭合（首点与末点相同） */
export function ringIsClosed(ring: readonly Position[]): boolean {
  if (ring.length < 3) return false;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  return first[0] === last[0] && first[1] === last[1];
}

/** 两个点是否同一个位置（严格相等：数据里重复写同一个坐标就是重复） */
function samePoint(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/* ───────────────────── 规则 ───────────────────── */

/**
 * 这个要素是不是零面积面。
 *
 * 单独抽出来是因为别处要用（拓扑检查要避开已经报过的要素，避免同一事实报两遍）。
 */
export function isZeroAreaFeature(f: ScannedFeature): boolean {
  if (!f.geometry) return false;
  const groups = polygonGroupsOf(f.geometry);
  if (groups.length === 0) return false;
  return groups.some((g) => ringAbsArea(g.outer) === 0);
}

/**
 * V-GEOM-002 零面积面。
 *
 * 一个面的面积为 0，通常是几何退化（点重合、共线）造成的。
 * 注意要**逐环**算：MultiPolygon 里只要有一个部件面积为 0，整个要素就不算正常。
 */
export function checkZeroArea(features: readonly ScannedFeature[]): Finding[] {
  const hits = features.filter((f) => isZeroAreaFeature(f));
  if (hits.length === 0) return [];
  return [
    {
      ruleId: 'V-GEOM-002',
      severity: 'error',
      title: '存在零面积面要素',
      detail: `${hits.length} 个面的面积为 0，通常是几何退化或坐标重复造成的。`,
      affectedCount: hits.length,
      samples: hits.slice(0, 5).map((f) => String(f.id)),
      hint: '可用"修复几何"操作处理；请注意修复可能改变面积。',
    },
  ];
}

/**
 * 这个要素是不是零长度线。
 *
 * 单独抽出来是因为别处要用（拓扑检查要避开已经报过的要素）。
 */
export function isZeroLengthLineFeature(f: ScannedFeature): boolean {
  if (!f.geometry) return false;
  const lines = linesOf(f.geometry);
  if (lines.length === 0) return false;
  return lines.some((line) => {
    if (line.length < 2) return true; // 单点线：长度为 0
    for (let i = 1; i < line.length; i++) {
      if (!samePoint(line[i - 1]!, line[i]!)) return false;
    }
    return true;
  });
}

/**
 * V-GEOM-006 零长度线。
 *
 * 整条线所有点重合 → 长度为 0。这类线在出图时看不见，但会污染长度统计，
 * 也会让「按长度排序 / 按长度筛选」的结果失真。
 */
export function checkZeroLengthLines(features: readonly ScannedFeature[]): Finding[] {
  const hits = features.filter((f) => isZeroLengthLineFeature(f));
  if (hits.length === 0) return [];
  return [
    {
      ruleId: 'V-GEOM-006',
      severity: 'error',
      title: '存在零长度线要素',
      detail: `${hits.length} 条线的长度为 0（所有顶点落在同一个位置上），出图时看不见，但会污染长度统计。`,
      affectedCount: hits.length,
      samples: hits.slice(0, 5).map((f) => String(f.id)),
      hint: '这类线通常是数字化时误操作产生的，可单独清理。',
    },
  ];
}

/**
 * V-GEOM-007 重复顶点。
 *
 * 相邻两个顶点坐标完全相同。这本身不致命，但往往是「重复数字化」或
 * 「转换时没去重」留下的痕迹，也会让拓扑检查报出难以定位的问题。
 */
export function checkDuplicateVertices(features: readonly ScannedFeature[]): Finding[] {
  const hits: ScannedFeature[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    let dup = false;
    for (const group of polygonGroupsOf(f.geometry)) {
      for (const ring of [group.outer, ...group.holes]) {
        for (let i = 1; i < ring.length; i++) {
          if (samePoint(ring[i - 1]!, ring[i]!)) {
            dup = true;
            break;
          }
        }
        if (dup) break;
      }
      if (dup) break;
    }
    if (!dup) {
      for (const line of linesOf(f.geometry)) {
        for (let i = 1; i < line.length; i++) {
          if (samePoint(line[i - 1]!, line[i]!)) {
            dup = true;
            break;
          }
        }
        if (dup) break;
      }
    }
    if (dup) hits.push(f);
  }
  if (hits.length === 0) return [];
  return [
    {
      ruleId: 'V-GEOM-007',
      severity: 'warn',
      title: '存在重复顶点',
      detail: `${hits.length} 个要素里有相邻两个顶点坐标完全相同。`,
      affectedCount: hits.length,
      samples: hits.slice(0, 5).map((f) => String(f.id)),
      hint: '重复顶点通常是数字化或格式转换时留下的，清理后拓扑检查会稳很多。',
    },
  ];
}

/**
 * 这个要素有没有未闭合的环。
 *
 * 单独抽出来是因为别处要用（拓扑检查要避开已经报过的要素，避免同一事实报两遍）。
 */
export function hasUnclosedRing(f: ScannedFeature): boolean {
  if (!f.geometry) return false;
  for (const g of polygonGroupsOf(f.geometry)) {
    for (const ring of [g.outer, ...g.holes]) {
      if (ring.length >= 3 && !ringIsClosed(ring)) return true;
    }
  }
  return false;
}

/**
 * V-GEOM-005 环没闭合 / 环方向不一致。
 *
 * 两件事放同一条规则，因为它们都出在「环」上：
 *   - 未闭合：环的首点与末点不是同一个位置；
 *   - 方向不一致：同一个图层里外环的绕向不统一，或某个洞与它的外环同向。
 *
 * 为什么方向也要管：很多工具（含部分 GIS 软件的拓扑检查）靠绕向判断
 * 哪条是外环、哪条是洞，同一层里绕向混用会让它们判错。
 */
export function checkRingIntegrity(features: readonly ScannedFeature[]): Finding[] {
  const unclosed: ScannedFeature[] = [];
  const mixed: ScannedFeature[] = [];
  const outerSigns = new Set<number>();

  for (const f of features) {
    if (!f.geometry) continue;
    const groups = polygonGroupsOf(f.geometry);
    if (groups.length === 0) continue;
    let featureUnclosed = false;
    let featureMixed = false;
    for (const g of groups) {
      const rings = [g.outer, ...g.holes];
      for (const ring of rings) {
        if (ring.length >= 3 && !ringIsClosed(ring)) featureUnclosed = true;
      }
      const outerSign = Math.sign(ringSignedArea(g.outer));
      if (outerSign !== 0) outerSigns.add(outerSign);
      for (const hole of g.holes) {
        const holeSign = Math.sign(ringSignedArea(hole));
        // 洞与外环同向 → 外内分不清
        if (holeSign !== 0 && outerSign !== 0 && holeSign === outerSign) featureMixed = true;
      }
    }
    if (featureUnclosed) unclosed.push(f);
    if (featureMixed) mixed.push(f);
  }

  const out: Finding[] = [];
  if (unclosed.length > 0) {
    out.push({
      ruleId: 'V-GEOM-005',
      severity: 'error',
      title: '存在未闭合的环',
      detail: `${unclosed.length} 个面的环首点与末点不是同一个位置。`,
      affectedCount: unclosed.length,
      samples: unclosed.slice(0, 5).map((f) => String(f.id)),
      hint: '未闭合的环在部分软件里会被直接丢弃或自动补闭，两边结果会对不上。',
    });
  }
  if (outerSigns.size > 1) {
    out.push({
      ruleId: 'V-GEOM-005',
      severity: 'warn',
      title: '同一图层里的环绕向不一致',
      detail: '不同要素的外环绕向不统一（有顺时针也有逆时针），靠绕向判断外环/洞的工具会判错。',
      affectedCount: mixed.length,
      hint: '统一外环绕向后，拓扑检查与面积统计的结果才稳定。',
    });
  } else if (mixed.length > 0) {
    out.push({
      ruleId: 'V-GEOM-005',
      severity: 'warn',
      title: '存在与外环同向的洞',
      detail: `${mixed.length} 个面里的内环（洞）与外环绕向相同，外内分不清。`,
      affectedCount: mixed.length,
      samples: mixed.slice(0, 5).map((f) => String(f.id)),
      hint: '洞的绕向应与外环相反，否则面积会算错。',
    });
  }
  return out;
}

/**
 * 尖角（spike）的判据里，尖刺两条边之和相对环上「典型边长」的比例上限。
 *
 * 为什么光看角度不够 —— 实测公开样本 GADM 中国省级（37 个面、2 万多个顶点）：
 *   - 有 99 个环带着小于 12° 的角，其中绝大多数是**整个环就是一根针**的狭长小岛
 *     （4 个顶点、面积几百平米，边长占周长 60%~99%）；
 *   - 另有若干是海岸线上的**局部小尖刺**（边长只占周长的万分之几）。
 * 两种都是真实地理，不是数字化错误。按角度一刀切会把它们全报一遍 ——
 * 那等于让工具在公开的干净数据上天天误报。
 *
 * 所以加一条「边长」判据：只报**长环上的小尖刺**（尖刺的两条边比环上典型边长还短），
 * 不报「整个环就是一根针」的狭长地理要素。
 */
const SPIKE_EDGE_RATIO = 0.5;

/**
 * V-GEOM-008 尖角（spike）。
 *
 * 环上出现非常锐的拐角（默认小于 10°），而且这个拐角是**长环上的局部小尖刺**
 * （两条边加起来比环上典型边长还短）。
 *
 * 为什么只报「尖刺」不报「锐角」：真实数据里合法地存在很锐的角
 * （狭长岛屿、海岬、峡角），阈值以下的角度在正确数据里也很常见，
 * 所以给的是 warn 而不是 error，阈值也允许调用方调
 * （契约里的 angleThresholdDeg）。
 */
export function checkSharpAngles(features: readonly ScannedFeature[], thresholdDeg: number): Finding[] {
  const hits: ScannedFeature[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    let sharp = false;
    for (const g of polygonGroupsOf(f.geometry)) {
      for (const ring of [g.outer, ...g.holes]) {
        if (ring.length < 4) continue;
        if (hasSpike(ring, thresholdDeg)) {
          sharp = true;
          break;
        }
      }
      if (sharp) break;
    }
    if (sharp) hits.push(f);
  }
  if (hits.length === 0) return [];
  return [
    {
      ruleId: 'V-GEOM-008',
      severity: 'warn',
      title: '存在尖刺状的拐角',
      detail: `${hits.length} 个面上有夹角小于 ${thresholdDeg}° 的**局部尖刺**（边界冲出去又折回来）。`,
      affectedCount: hits.length,
      samples: hits.slice(0, 5).map((f) => String(f.id)),
      hint: '尖刺通常是数字化时拉过头造成的，会让接边、裁切与面叠加出错；如属合理形状可调高阈值。',
    },
  ];
}

/**
 * 环上有没有「局部尖刺」。
 *
 * 判据两条：
 *   1. 夹角小于阈值；
 *   2. 这个拐角的两条边加起来，比环上**典型边长**（边长的中位数）还短 ——
 *      说明它是长边上戳出来的一个小刺，而不是「整个环本来就细长」。
 */
function hasSpike(ring: readonly Position[], thresholdDeg: number): boolean {
  const n = ring.length;
  if (n < 4) return false;
  const angles = ringInteriorAngles(ring);
  const edgeLens: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    edgeLens.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const sorted = [...edgeLens].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  if (!(median > 0)) return false;
  for (let i = 0; i < n; i++) {
    const angle = angles[i];
    if (angle === undefined || angle === null || angle >= thresholdDeg) continue;
    const prev = ring[(i - 1 + n) % n]!;
    const cur = ring[i]!;
    const next = ring[(i + 1) % n]!;
    const e1 = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    const e2 = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
    if (e1 + e2 < SPIKE_EDGE_RATIO * median) return true;
  }
  return false;
}

/**
 * 环上每个顶点的夹角（度）。
 *
 * 退化的相邻边（两点重合）给 null —— 那不是"尖角"，是上一条规则（重复顶点）的事。
 * 环按隐式闭合处理，所以首点也算一个顶点。
 */
export function ringInteriorAngles(ring: readonly Position[]): (number | null)[] {
  const n = ring.length;
  const out: (number | null)[] = [];
  if (n < 3) return out;
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n]!;
    const cur = ring[i]!;
    const next = ring[(i + 1) % n]!;
    out.push(interiorAngle(prev, cur, next));
  }
  return out;
}

/** 三个点构成的夹角（度）；任一边退化时返回 null */
function interiorAngle(prev: Position, cur: Position, next: Position): number | null {
  const ax = prev[0] - cur[0];
  const ay = prev[1] - cur[1];
  const bx = next[0] - cur[0];
  const by = next[1] - cur[1];
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la <= 1e-12 || lb <= 1e-12) return null;
  const cos = (ax * bx + ay * by) / (la * lb);
  const clamped = Math.max(-1, Math.min(1, cos));
  return (Math.acos(clamped) * 180) / Math.PI;
}
