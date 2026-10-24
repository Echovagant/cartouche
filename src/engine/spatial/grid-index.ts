/**
 * 空间连接的加速器：均匀网格索引（Uniform Grid Index）。
 *
 * ── 为什么是均匀网格 ──
 *   空间连接的本质是「拿目标要素去问源要素：我跟你有没有关系」。
 *   要素一多，逐对问就是 n×m 次，真实数据（海岸线 4 千条、十万级点线）
 *   直接跑不完。
 *
 *   均匀网格的思路很朴素：把平面切成等大的格子，**把源要素按包围盒放进
 *   覆盖到的格子里**；问的时候只问目标要素覆盖到的那些格子。
 *   一个格子里的源要素越少，问得越快 —— 而格子多大是可以在建索引时按
 *   要素数与数据密度算出来的，不必写死。
 *
 *   为什么不用 R 树之类的结构索引：那是引依赖（还要带原生编译），
 *   而网格用两个定长数组就能装下，内存与速度都可预期。
 *
 * ── 两级索引，各管一件事 ──
 *
 *   1. **要素级网格**（`buildFeatureGrid`）
 *      按要素的包围盒建格。它回答「哪些源要素可能跟这个目标要素有关系」，
 *      对点 / 线 / 面一视同仁，是 O(n×m) → O(候选) 的那一刀。
 *
 *   2. **线段级网格**（`buildSegmentGrid`）
 *      按源要素的**每一条线段**建格。只有线类源要素才建。
 *      它回答「这条线和那条线，具体是哪两条线段挨在一起」。
 *
 *   为什么光有要素级网格还不够：要素级网格能砍掉「离得远」的那部分，
 *   但**紧挨着的两个要素**仍然要靠几何层逐段判定。
 *   实测（Natural Earth 海岸线 4,133 条自连接）：包围盒过滤后仍剩 12,685 对
 *   需要精确判定，而这 12,685 对的顶点数乘积加起来是 **67.6 亿次线段测试** ——
 *   逐对判定本身才是真正的大头，要秒级必须连线段一起索引。
 *
 * ── 判定口径没有被改动 ──
 *   索引只负责**缩小候选**，命中与否仍然由几何层说了算。
 *   线段级网格把「两条线是否相交」化成「有没有一对线段相交」，
 *   这与几何层对线-线的判定完全等价 —— 几何层内部就是逐段比
 *   （`intersectsNormalized` 的线-线分支做的正是这件事），
 *   所以结果逐行不变。
 */

import { EPS, segmentsIntersect } from '../geometry/primitives.ts';
import type { BBox, NormalizedGeometry } from '../geometry/index.ts';

/* ───────────────── 规模参数 ───────────────── */

/**
 * 要素级：每个格子平均装几条源要素。
 *
 * 为什么是 2：格子太小 → 格子数暴涨、查表开销大；格子太大 → 每个格子
 * 里塞太多要素，等于没筛。2 是「大部分格子都有几条、但不多」的折中。
 */
const FEATURES_PER_CELL = 2;

/**
 * 线段级：每个格子平均装几条线段。
 *
 * 为什么比要素级更密：线段级要的是「精准到段」，格子里的线段越多，
 * 一次查询要试的对数就越多。代价是格子数变多、建索引更慢。
 */
const SEGMENTS_PER_CELL = 4;

/**
 * 要素少到一定程度就别建索引了。
 *
 * 为什么：建索引本身要 O(要素数)，而要素少时逐对问也就那么点功夫，
 * 建索引反而是亏的（还得再分配一遍格子表）。
 */
const MIN_INDEXED_SOURCES = 32;

/** 线段少到这个数以下，线段级索引的额外开销不划算。 */
const MIN_INDEXED_SEGMENTS = 256;

/**
 * 一次查询最多扫多少个格子，超了就退回全扫。
 *
 * 为什么要有这个上限：目标要素可能是个横跨整个数据范围的巨大面，
 * 它覆盖的格子数是「数据范围面积 ÷ 格子面积」，能到几百万。
 * 逐格查虽然比逐要素问便宜，但几百万次查表也不划算，
 * 这时直接全扫更稳。2^18 个格子 ≈ 一次性查 26 万次表，毫秒级。
 */
const MAX_QUERY_CELLS = 1 << 18;

/**
 * 一条线段最多能占多少个格子；超了就进「长线段」名单。
 *
 * 为什么：一条横跨全球的线段会占满整行整列的格子，把它塞进网格等于
 * 把它复制几千份，内存和查询都会炸。长线段数量少，单独一张名单处理。
 */
const MAX_CELLS_PER_SEGMENT = 512;

/** 长线段名单的上限：超过这个数就整个线段级索引都不用（退回整几何判定）。 */
const MAX_LONG_SEGMENTS = 2048;

/**
 * 网格里最多放多少条记录（= 源要素数 × 每要素平均占格数）。
 *
 * 为什么：这是内存上限。4 字节 × 2,400 万 ≈ 96 MB，超了就整个索引都不用
 * （退回逐对判定），宁可慢也不能把机器撑爆。
 */
const MAX_TOTAL_ENTRIES = 24_000_000;

/** 格子数上限（格子表本身也要占内存）。 */
const MAX_CELLS = 4_000_000;

/* ───────────────── 格子布局 ───────────────── */

/** 网格的格子布局：原点、格子边长、行列数。 */
interface CellLayout {
  readonly originX: number;
  readonly originY: number;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly cols: number;
  readonly rows: number;
}

/** 一个盒子覆盖到的格子范围（闭区间；`cx1 < cx0` 表示空）。 */
interface CellRange {
  readonly cx0: number;
  readonly cx1: number;
  readonly cy0: number;
  readonly cy1: number;
}

const EMPTY_RANGE: CellRange = { cx0: 0, cx1: -1, cy0: 0, cy1: -1 };
const EMPTY_LIST: readonly number[] = [];

/**
 * 按「想要多少个格子」推算格子边长。
 *
 * 为什么这样推：格子边长 = sqrt(数据范围面积 / 目标格子数)。
 * 数据越稀疏（要素挤在一角）同样的格子数就越细；要素越均匀就刚好。
 * 格子边长按总面积算、行列数按实际跨度算，于是格子在两个方向上大小一致，
 * 不会在经纬度数据上变成「横向密、纵向疏」的细条。
 *
 * @param extent 数据的整体范围
 * @param targetCells 期望的格子数
 */
function layoutFor(extent: BBox, targetCells: number): CellLayout {
  const width = extent.maxX - extent.minX;
  const height = extent.maxY - extent.minY;
  // 退化的一维（所有要素同一条 x / 同一条 y）不参与尺度计算：
  // 那一维的跨度是 0，拿它算面积会把格子边长压成 0。
  const spanX = width > 0 ? width : height;
  const spanY = height > 0 ? height : width;
  const area = spanX * spanY;
  const cell = area > 0 ? Math.sqrt(area / Math.max(1, targetCells)) : 0;
  // 退化维度的格子边长取 1：那一维本来就没有跨度，边长多少都一样。
  const sizeX = width > 0 ? cell : 1;
  const sizeY = height > 0 ? cell : 1;
  let cols = width > 0 ? Math.max(1, Math.ceil(width / sizeX)) : 1;
  let rows = height > 0 ? Math.max(1, Math.ceil(height / sizeY)) : 1;
  // 格子总数有上限：格子太密会把内存吃光，这时把格子放大。
  while (cols * rows > MAX_CELLS) {
    cols = Math.ceil(cols / 2);
    rows = Math.ceil(rows / 2);
  }
  return { originX: extent.minX, originY: extent.minY, sizeX, sizeY, cols, rows };
}

/**
 * 盒子覆盖到的格子范围。
 *
 * **为什么压线时才多算一格**：几何层的口径是闭集 —— 压在边界上算相交。
 * 若两个盒子只差一个「压线」的量（正好或极近落在格子边界上），它们可能
 * 落在相邻的两个格子里而互相看不见。所以压线时多算一格。
 *
 * 但**不能恒定多算一格**：恒定多算会让每个只占一格的小盒子占掉 4 格，
 * 网格大一倍、查询慢一倍 —— 而压线是极罕见的情形（坐标正好落在格子
 * 边界上的概率约等于 0）。所以只在「离边界不超过容差」时才多算。
 *
 * @param tol 压线的容差（坐标单位）
 */
function cellRangeOf(layout: CellLayout, box: BBox, tol: number): CellRange {
  const cx0 = Math.floor((box.minX - layout.originX) / layout.sizeX);
  const cx1 = Math.floor((box.maxX - layout.originX) / layout.sizeX);
  const cy0 = Math.floor((box.minY - layout.originY) / layout.sizeY);
  const cy1 = Math.floor((box.maxY - layout.originY) / layout.sizeY);
  // 该格子的下沿 / 上沿
  const lowerX = layout.originX + cx0 * layout.sizeX;
  const upperX = layout.originX + (cx1 + 1) * layout.sizeX;
  const lowerY = layout.originY + cy0 * layout.sizeY;
  const upperY = layout.originY + (cy1 + 1) * layout.sizeY;
  const rawCx0 = cx0 - (box.minX - lowerX <= tol ? 1 : 0);
  const rawCx1 = cx1 + (upperX - box.maxX <= tol ? 1 : 0);
  const rawCy0 = cy0 - (box.minY - lowerY <= tol ? 1 : 0);
  const rawCy1 = cy1 + (upperY - box.maxY <= tol ? 1 : 0);
  // 夹到网格范围内。完全在网格外面的盒子会得到空范围 —— 这是对的：
  // 源要素全在网格覆盖的范围里，网格外的目标不可能碰到任何一个。
  return {
    cx0: Math.max(0, rawCx0),
    cx1: Math.min(layout.cols - 1, rawCx1),
    cy0: Math.max(0, rawCy0),
    cy1: Math.min(layout.rows - 1, rawCy1),
  };
}

/** 范围里的格子数（空范围算 0）。 */
function cellCountOf(range: CellRange): number {
  if (range.cx1 < range.cx0 || range.cy1 < range.cy0) return 0;
  return (range.cx1 - range.cx0 + 1) * (range.cy1 - range.cy0 + 1);
}

/** 范围内所有数据的整体范围。 */
function extentOf(boxes: readonly (BBox | undefined)[]): BBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    if (!box) continue;
    if (box.minX < minX) minX = box.minX;
    if (box.minY < minY) minY = box.minY;
    if (box.maxX > maxX) maxX = box.maxX;
    if (box.maxY > maxY) maxY = box.maxY;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, minY, maxX, maxY };
}

/* ───────────────── 格子表（扁平数组） ───────────────── */

/**
 * 格子 → 元素列表。
 *
 * 为什么用两个定长数组而不是 Map<number, number[]>：
 * Map 的每个键都是一次哈希 + 一个对象，几十万格时开销与内存都不划算。
 * 「先数每格几个 → 前缀和 → 按格子顺序填进去」是计数排序的经典做法，
 * 查表是纯数组下标，最快也最省。
 */
interface CellTable {
  /** 第 c 格的元素在 items 里的起点；长度 = 格子数 + 1 */
  readonly start: Int32Array;
  /** 所有格子的元素，按格子顺序排好 */
  readonly items: Int32Array;
}

/** 建格子表。`rangeOf` 要对同一个下标给出两次相同的结果。 */
function fillCells(
  cols: number,
  rows: number,
  count: number,
  rangeOf: (i: number) => CellRange,
): CellTable {
  const cellCount = cols * rows;
  const start = new Int32Array(cellCount + 1);
  for (let i = 0; i < count; i++) {
    const r = rangeOf(i);
    for (let cy = r.cy0; cy <= r.cy1; cy++) {
      const base = cy * cols;
      for (let cx = r.cx0; cx <= r.cx1; cx++) {
        start[base + cx + 1] = (start[base + cx + 1] ?? 0) + 1;
      }
    }
  }
  for (let c = 0; c < cellCount; c++) {
    start[c + 1] = (start[c + 1] ?? 0) + (start[c] ?? 0);
  }
  const items = new Int32Array(start[cellCount] ?? 0);
  const cursor = start.slice(0, cellCount);
  for (let i = 0; i < count; i++) {
    const r = rangeOf(i);
    for (let cy = r.cy0; cy <= r.cy1; cy++) {
      const base = cy * cols;
      for (let cx = r.cx0; cx <= r.cx1; cx++) {
        const at = cursor[base + cx] ?? 0;
        items[at] = i;
        cursor[base + cx] = at + 1;
      }
    }
  }
  return { start, items };
}

/* ───────────────── 要素级网格 ───────────────── */

/**
 * 要素级网格：按包围盒把源要素放进格子。
 *
 * 用法：`query(box)` 给出与这个盒子可能相关的源要素下标。
 * 退化时（要素太少、范围退化、目标盒子太大）返回全量 —— 宁可慢，
 * 不能漏。
 */
export interface FeatureGrid {
  /** 源要素总数 */
  readonly size: number;
  /** 与给定盒子可能相关的源要素下标（无重复，顺序不保证） */
  query(box: BBox): readonly number[];
}

/** 建要素级网格。 */
export function buildFeatureGrid(boxes: readonly (BBox | undefined)[]): FeatureGrid {
  const size = boxes.length;
  const fallback: number[] = [];
  for (let i = 0; i < size; i++) fallback.push(i);

  // 要素太少：逐对问本来就不慢，建索引是亏的。
  if (size < MIN_INDEXED_SOURCES) {
    return { size, query: () => fallback };
  }
  const extent = extentOf(boxes);
  if (!extent) return { size, query: () => fallback };

  const layout = layoutFor(extent, Math.ceil(size / FEATURES_PER_CELL));
  // 压线容差与几何层一致：`bboxOverlaps` / `bboxContains` 用的就是固定的 EPS。
  const tol = EPS;
  const ranges = new Array<CellRange>(size);
  let entries = 0;
  for (let i = 0; i < size; i++) {
    const box = boxes[i];
    const r = box ? cellRangeOf(layout, box, tol) : EMPTY_RANGE;
    ranges[i] = r;
    entries += cellCountOf(r);
  }
  // 记录数超上限就退回全扫：索引是为了加速，不是为了把内存吃光。
  if (entries > MAX_TOTAL_ENTRIES) {
    return { size, query: () => fallback };
  }

  const table = fillCells(layout.cols, layout.rows, size, (i) => ranges[i] ?? EMPTY_RANGE);
  // 去重用的戳：同一个源要素可能覆盖多个格子，会被查到多次。
  const seen = new Int32Array(size);
  let stamp = 0;

  return {
    size,
    query(box: BBox): readonly number[] {
      const range = cellRangeOf(layout, box, tol);
      const cells = cellCountOf(range);
      if (cells === 0) return EMPTY_LIST;
      // 目标盒子太大 → 格子数失控 → 退回全扫。
      if (cells > MAX_QUERY_CELLS) return fallback;
      stamp += 1;
      const current = stamp;
      const out: number[] = [];
      const { start, items } = table;
      for (let cy = range.cy0; cy <= range.cy1; cy++) {
        const base = cy * layout.cols;
        for (let cx = range.cx0; cx <= range.cx1; cx++) {
          const cell = base + cx;
          const from = start[cell] ?? 0;
          const to = start[cell + 1] ?? 0;
          for (let k = from; k < to; k++) {
            const j = items[k] ?? 0;
            if (seen[j] === current) continue;
            seen[j] = current;
            out.push(j);
          }
        }
      }
      return out;
    },
  };
}

/* ───────────────── 线段级网格 ───────────────── */

/**
 * 线段级网格：把源要素的每一条线段放进格子。
 *
 * 只有**线类**源要素会进这个索引 —— 面的判定是「面与面」或「线与面」，
 * 靠的是面内部而不是边线，线段索引对它们没有意义（也不安全）。
 */
export interface SegmentGrid {
  /** 索引是否可用；不可用时连接层应退回整几何判定 */
  readonly enabled: boolean;
  /**
   * 与目标要素相交的源要素下标。
   *
   * 判定口径与几何层的线-线相交完全一致：存在一对线段相交即命中。
   * 返回 null 表示「这个目标没法用线段级判定」，调用方应退回整几何判定。
   */
  query(target: NormalizedGeometry): ReadonlySet<number> | null;
}

/**
 * 建线段级网格。
 *
 * @param sources 源要素的归一化几何
 */
export function buildSegmentGrid(sources: readonly NormalizedGeometry[]): SegmentGrid {
  const disabled: SegmentGrid = { enabled: false, query: () => null };

  /* ── 先把每个线类源要素的线段摊平 ──
     段号在要素内部连续编号；长线段（占格太多）单独进一张名单。 */
  const segLine: number[] = [];
  const segPoint: number[] = [];
  const ownerOf: number[] = [];
  let totalSegments = 0;
  for (let j = 0; j < sources.length; j++) {
    const g = sources[j];
    if (!g || g.kind !== 'line') continue;
    for (let li = 0; li < g.lines.length; li++) {
      const line = g.lines[li];
      if (!line) continue;
      for (let p = 0; p + 1 < line.length; p++) {
        segLine.push(li);
        segPoint.push(p);
        ownerOf.push(j);
        totalSegments += 1;
      }
    }
  }
  if (totalSegments < MIN_INDEXED_SEGMENTS) return disabled;

  /* ── 线类源要素的整体范围与坐标量级 ──
     量级决定压线容差：几何层判定线段相交时的容差是按坐标量级缩放的
     （`orientation` 用 EPS × 线段长度），坐标越大容差越大。 */
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxAbs = 1;
  const segmentBoxes: BBox[] = new Array(totalSegments);
  for (let i = 0; i < totalSegments; i++) {
    const j = ownerOf[i] ?? 0;
    const g = sources[j];
    const line = g?.lines[segLine[i] ?? 0];
    const a = line?.[segPoint[i] ?? 0];
    const b = line?.[(segPoint[i] ?? 0) + 1];
    if (!a || !b) continue;
    const box: BBox = {
      minX: Math.min(a[0], b[0]),
      minY: Math.min(a[1], b[1]),
      maxX: Math.max(a[0], b[0]),
      maxY: Math.max(a[1], b[1]),
    };
    segmentBoxes[i] = box;
    if (box.minX < minX) minX = box.minX;
    if (box.minY < minY) minY = box.minY;
    if (box.maxX > maxX) maxX = box.maxX;
    if (box.maxY > maxY) maxY = box.maxY;
    const m = Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]));
    if (m > maxAbs) maxAbs = m;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return disabled;

  const layout = layoutFor(
    { minX, minY, maxX, maxY },
    Math.ceil(totalSegments / SEGMENTS_PER_CELL),
  );
  const tol = EPS * maxAbs;

  /* ── 每条线段占哪些格子 ── */
  const ranges: CellRange[] = new Array(totalSegments);
  const longSegments: number[] = [];
  let entries = 0;
  for (let i = 0; i < totalSegments; i++) {
    const box = segmentBoxes[i];
    if (!box) {
      ranges[i] = EMPTY_RANGE;
      continue;
    }
    const r = cellRangeOf(layout, box, tol);
    ranges[i] = r;
    if (cellCountOf(r) > MAX_CELLS_PER_SEGMENT) {
      // 长线段：占格太多，塞进网格等于复制几千份。单独一张名单。
      longSegments.push(i);
      ranges[i] = EMPTY_RANGE;
    } else {
      entries += cellCountOf(r);
    }
  }
  if (longSegments.length > MAX_LONG_SEGMENTS) return disabled;
  if (entries > MAX_TOTAL_ENTRIES) return disabled;

  const table = fillCells(layout.cols, layout.rows, totalSegments, (i) => ranges[i] ?? EMPTY_RANGE);
  const owner = Int32Array.from(ownerOf);
  const lineOf = Int32Array.from(segLine);
  const pointOf = Int32Array.from(segPoint);
  const longs = Int32Array.from(longSegments);
  // 去重戳：同一对（目标线段, 源线段）可能在多个格子里被碰到。
  const seen = new Int32Array(totalSegments);
  // 已命中的源要素：命中过就不用再试了。
  //
  // 为什么用戳而不是每次清零的标志位数组：清零是 O(源要素数)，
  // 乘上目标要素数就又变回 O(n×m) 了 —— 十万级线要素时清零本身就要几十秒。
  const hitStamp = new Int32Array(sources.length);
  let stamp = 0;
  let queryStamp = 0;

  return {
    enabled: true,
    query(target: NormalizedGeometry): ReadonlySet<number> | null {
      if (target.kind !== 'line') return null;
      const hits = new Set<number>();
      queryStamp += 1;
      const currentQuery = queryStamp;
      // ── 摊平目标要素的线段 ──
      const targetLine: number[] = [];
      const targetPoint: number[] = [];
      for (let li = 0; li < target.lines.length; li++) {
        const line = target.lines[li];
        if (!line) continue;
        for (let p = 0; p + 1 < line.length; p++) {
          targetLine.push(li);
          targetPoint.push(p);
        }
      }
      if (targetLine.length === 0) return null;

      for (let m = 0; m < targetLine.length; m++) {
        const li = targetLine[m] ?? 0;
        const p = targetPoint[m] ?? 0;
        const tLine = target.lines[li];
        const ta = tLine?.[p];
        const tb = tLine?.[p + 1];
        if (!ta || !tb) continue;
        const box: BBox = {
          minX: Math.min(ta[0], tb[0]),
          minY: Math.min(ta[1], tb[1]),
          maxX: Math.max(ta[0], tb[0]),
          maxY: Math.max(ta[1], tb[1]),
        };
        const range = cellRangeOf(layout, box, tol);
        const cells = cellCountOf(range);
        if (cells === 0) continue;
        if (cells > MAX_QUERY_CELLS) continue;
        stamp += 1;
        const current = stamp;

        for (let cy = range.cy0; cy <= range.cy1; cy++) {
          const base = cy * layout.cols;
          for (let cx = range.cx0; cx <= range.cx1; cx++) {
            const cell = base + cx;
            const from = table.start[cell] ?? 0;
            const to = table.start[cell + 1] ?? 0;
            for (let k = from; k < to; k++) {
              const gi = table.items[k] ?? 0;
              if (seen[gi] === current) continue;
              seen[gi] = current;
              const j = owner[gi] ?? 0;
              if (hitStamp[j] === currentQuery) continue;
              const sLine = sources[j]?.lines[lineOf[gi] ?? 0];
              const sa = sLine?.[pointOf[gi] ?? 0];
              const sb = sLine?.[(pointOf[gi] ?? 0) + 1];
              if (!sa || !sb) continue;
              // 与几何层用的是同一个线段相交判定，口径一致。
              if (segmentsIntersect(ta, tb, sa, sb)) {
                hitStamp[j] = currentQuery;
                hits.add(j);
              }
            }
          }
        }

        // 长线段不进网格，只能逐条对：数量很少，代价可以忽略。
        for (const gi of longs) {
          if (seen[gi] === current) continue;
          seen[gi] = current;
          const j = owner[gi] ?? 0;
          if (hitStamp[j] === currentQuery) continue;
          const sLine = sources[j]?.lines[lineOf[gi] ?? 0];
          const sa = sLine?.[pointOf[gi] ?? 0];
          const sb = sLine?.[(pointOf[gi] ?? 0) + 1];
          if (!sa || !sb) continue;
          if (segmentsIntersect(ta, tb, sa, sb)) {
            hitStamp[j] = currentQuery;
            hits.add(j);
          }
        }
      }
      return hits;
    },
  };
}
