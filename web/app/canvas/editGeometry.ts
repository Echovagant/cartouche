/**
 * 栅格编辑的几何换算（纯函数，不碰 React）。
 *
 * 为什么单独抽一个文件：
 *   坐标换算是这套工具里最容易出错的一环——
 *   屏幕点 → 经纬度 → 目标栅格的**原生像元坐标**，三步里任何一步偏一点，
 *   画出来的东西就落在别的位置，而且错得很"像对的"（用户看不出来，还以为是自己手抖）。
 *   收成一个没有副作用的文件，改公式时只改这一处，别的代码只管调用。
 */

/** 原生像元坐标（可为小数） */
export interface PixelPoint {
  readonly col: number;
  readonly row: number;
}

/**
 * 这个栅格能不能按 4326 换算。
 *
 * 结论直接取引擎的判定（`crs.is4326`），前端不再自己猜：
 *   - 猜字符串会漏判（GDAL 有时只给 WKT 不给 EPSG 代码）；
 *   - 漏判的代价是把经纬度当成米去换算，画出来的东西落在天边，
 *     而且看起来"像画过一笔"，用户根本发现不了。
 *
 * 引擎的判据（src/engine/gdal/probe.ts）：
 *   1. EPSG 就是 4326 → 是
 *   2. WKT 里认得出 WGS 84 → 是
 *   3. 完全没有 CRS → 看 geotransform：像元步长是度量级且原点在经纬度范围内
 *      才算经纬度（与引擎出图时"无投影按 4326"的约定一致）
 */
export function isWgs84Grid(grid: {
  readonly crs?: { readonly is4326?: boolean } | null;
}): boolean {
  return grid.crs?.is4326 === true;
}

/**
 * 经纬度 → 原生像元（仿射反算）。
 *
 * ⚠️ 这条公式现在只是**参照实现**：真正的换算由引擎做
 * （`POST /api/raster/pixels`），因为浏览器里没有投影能力，
 * 非 4326 的栅格必须由引擎把经纬度投影到原生坐标系再反算。
 *
 * 保留它有两个用处：
 *   1. 引擎那份（`src/engine/raster/pixel-query.ts` 的 `pixelFromNative`）
 *      与它**逐字一致** —— 4326 的栅格两边必须给出同一个像元坐标；
 *   2. 单测拿它当"旧算法"的对照物（见 test/raster-pixel-query.test.mjs）。
 *
 * geotransform = [originX, pixelWidth, rotX, originY, rotY, pixelHeight]，GDAL 的行列序：
 *   x = originX + col*pixelWidth + row*rotX
 *   y = originY + col*rotY   + row*pixelHeight
 * 反解用行列式。北-up 的栅格（rotX = rotY = 0）退化成
 *   col = (x - originX) / pixelWidth
 *   row = (y - originY) / pixelHeight
 * 行号向下增长（pixelHeight 通常是负的），与"左上原点"的约定一致。
 */
export function pixelFromLngLat(
  grid: { readonly geotransform: readonly number[] },
  lng: number,
  lat: number,
): PixelPoint | null {
  const [ox, pw, rx, oy, ry, ph] = grid.geotransform;
  if (
    ox === undefined ||
    pw === undefined ||
    rx === undefined ||
    oy === undefined ||
    ry === undefined ||
    ph === undefined
  ) {
    return null;
  }
  const det = pw * ph - rx * ry;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) return null;
  const dx = lng - ox;
  const dy = lat - oy;
  const col = (ph * dx - rx * dy) / det;
  const row = (-ry * dx + pw * dy) / det;
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  return { col, row };
}

/**
 * 视窗四角的经纬度（左下、右下、右上、左上）。
 *
 * 顺序与屏幕位置一一对应：
 *   左下 (0, 高度) → 右下 (宽度, 高度) → 右上 (宽度, 0) → 左上 (0, 0)
 *
 * 这四个角是**笔宽换算**的输入：把视窗的两条边送进引擎换算成原生像元，
 * 再用"原生像元跨度 ÷ 屏幕像素跨度"得出一个屏幕像素值多少原生像元。
 * 这样算出来的比例与坐标系无关（4326 的栅格也走同一条路）。
 */
export function viewportCorners(
  bbox: readonly [number, number, number, number],
): readonly (readonly [number, number])[] {
  const [minX, minY, maxX, maxY] = bbox;
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

/**
 * 原生像元 / 屏幕像素 的比例（笔宽换算用）。
 *
 * 用视窗两对角线的跨度算：横向跨度 ÷ 屏幕宽度、纵向跨度 ÷ 屏幕高度，
 * 取小的那个（保守：宁可笔细一点，也不要糊一大片）。
 *
 * 局部线性：投影的比例尺在一个视窗范围内变化极小，误差可以忽略。
 * 4326 的栅格里这个值与"像元尺寸（度）÷ 每像素度数"完全相等。
 */
export function nativeScaleFromCorners(
  corners: readonly PixelPoint[],
  viewport: { readonly width: number; readonly height: number },
): number | null {
  if (corners.length < 4) return null;
  const bl = corners[0];
  const br = corners[1];
  const tl = corners[3];
  if (!bl || !br || !tl) return null;
  const spanCol = Math.abs(br.col - bl.col);
  const spanRow = Math.abs(tl.row - bl.row);
  const sx = spanCol / Math.max(1, viewport.width);
  const sy = spanRow / Math.max(1, viewport.height);
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null;
  if (sx <= 0 || sy <= 0) return null;
  return Math.min(sx, sy);
}

/**
 * 一组像元点 → 归一化矩形，并夹到栅格范围内。
 *
 * 归一化是必须的：框可以往右下拖，也可以往左上拖；
 * 而且行方向上 pixelHeight 是负的，不归一就会得到上下颠倒的框。
 * 夹到 [0, width] × [0, height]：框到栅格外面去的地方根本没有像元，
 * 留着只会让"影响像元数"算不准。
 *
 * padPx：笔迹要额外留出笔宽，否则笔尖画到的地方会落在框外。
 */
export function regionFromPoints(
  grid: { readonly width: number; readonly height: number },
  points: readonly PixelPoint[],
  padPx = 0,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (points.length === 0) return null;
  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const p of points) {
    if (p.col < minCol) minCol = p.col;
    if (p.col > maxCol) maxCol = p.col;
    if (p.row < minRow) minRow = p.row;
    if (p.row > maxRow) maxRow = p.row;
  }
  minCol -= padPx;
  maxCol += padPx;
  minRow -= padPx;
  maxRow += padPx;

  let minX = Math.floor(minCol);
  let maxX = Math.ceil(maxCol);
  let minY = Math.floor(minRow);
  let maxY = Math.ceil(maxRow);
  minX = Math.max(0, Math.min(minX, grid.width));
  maxX = Math.max(0, Math.min(maxX, grid.width));
  minY = Math.max(0, Math.min(minY, grid.height));
  maxY = Math.max(0, Math.min(maxY, grid.height));
  if (maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * 把笔迹栅格化成 0/255 的遮罩字节。
 *
 * 逐段算"点到线段的距离"而不是逐点盖章：盖章在快速拖动时会断成虚线
 * （采样点之间有空隙），线段距离法天然连续。
 */
export function rasterizeStroke(
  points: readonly PixelPoint[],
  region: { minX: number; minY: number; maxX: number; maxY: number },
  radiusPx: number,
): Uint8Array {
  const width = region.maxX - region.minX;
  const height = region.maxY - region.minY;
  const mask = new Uint8Array(Math.max(0, width * height));
  if (points.length === 0 || width <= 0 || height <= 0) return mask;

  const r = Math.max(0.5, radiusPx);
  const r2 = r * r;

  // 单点笔迹按"零长度线段"处理，落点也会盖出一个圆
  const segments: readonly (readonly [PixelPoint, PixelPoint])[] =
    points.length === 1
      ? [[points[0] as PixelPoint, points[0] as PixelPoint]]
      : points.slice(1).map((p, i) => {
          const a = points[i] as PixelPoint;
          return [a, p] as const;
        });

  for (const [a, b] of segments) {
    const x0 = Math.max(region.minX, Math.floor(Math.min(a.col, b.col) - r));
    const x1 = Math.min(region.maxX - 1, Math.ceil(Math.max(a.col, b.col) + r));
    const y0 = Math.max(region.minY, Math.floor(Math.min(a.row, b.row) - r));
    const y1 = Math.min(region.maxY - 1, Math.ceil(Math.max(a.row, b.row) + r));
    const dx = b.col - a.col;
    const dy = b.row - a.row;
    const len2 = dx * dx + dy * dy;
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        let t = 0;
        if (len2 > 0) {
          t = (cx - a.col) * dx + (cy - a.row) * dy;
          t = Math.max(0, Math.min(1, t / len2));
        }
        const qx = a.col + t * dx - cx;
        const qy = a.row + t * dy - cy;
        if (qx * qx + qy * qy <= r2) {
          mask[(py - region.minY) * width + (px - region.minX)] = 255;
        }
      }
    }
  }
  return mask;
}

/**
 * 字节数组 → base64。
 *
 * 分块拼：一次性 `String.fromCharCode(...bytes)` 上万个数会把调用栈撑爆。
 */
export function encodeBase64(bytes: Uint8Array): string {
  const chunk = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
