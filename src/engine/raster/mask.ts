/**
 * 区域掩膜。
 *
 * 区域用**像元坐标**表示（左上角为原点，与 GDAL 的行序一致）。
 * 羽化在**区域外侧**生长：区域内 alpha=1，向外线性衰减到 0。
 * 这样"替换区域 + 边缘融合"才不会有硬边。
 */

export interface PixelRegion {
  /** 起始列（含） */
  readonly minX: number;
  /** 起始行（含） */
  readonly minY: number;
  /** 结束列（不含） */
  readonly maxX: number;
  /** 结束行（不含） */
  readonly maxY: number;
}

/** 地理范围（目标坐标系单位） */
export interface GeoBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * 自由形状掩膜：每像元一个不透明度。
 *
 * 矩形（PixelRegion）表达不了"画笔划过的那些点"——
 * 那条笔画可能是个 L 形、个圈，套进矩形就变成了大面积误涂。
 * 所以画笔走这条路：把笔迹栅格化成逐像元的不透明度，
 * 再叠加在矩形之上（两者是**与**的关系）。
 *
 * **坐标是相对 region 的**：掩膜的宽高 = region 包围盒的宽高，
 * 字节 (0, 0) 对应的是 region 左上角那个像元，不是栅格的 (0, 0)。
 * 画笔按笔迹的外接矩形出掩膜（掩膜大了就没法上传），所以必须这样对齐。
 */
export interface PixelMask {
  readonly width: number;
  readonly height: number;
  /** 长度 = width × height，取值 0~1 */
  readonly alpha: Float32Array;
}

/**
 * 把逐像元字节（0~255）转成掩膜。
 *
 * 字节来自前端画笔的栅格化结果（base64 解码而来）。
 * 这里只做**数值映射**，不做任何解释 —— 字节的含义由前端约定：
 * 0 = 完全不着色，255 = 完全着色。
 */
export function buildPixelMask(width: number, height: number, bytes: Uint8Array): PixelMask {
  const alpha = new Float32Array(width * height);
  const n = Math.min(alpha.length, bytes.length);
  for (let i = 0; i < n; i++) {
    alpha[i] = (bytes[i] ?? 0) / 255;
  }
  return { width, height, alpha };
}

/** 取某像元的掩膜不透明度；越界或没有掩膜时返回 1（= 不限制） */
export function maskAlphaAt(mask: PixelMask | undefined, x: number, y: number): number {
  if (!mask) return 1;
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return 0;
  return mask.alpha[y * mask.width + x] ?? 0;
}

/**
 * 按**栅格绝对坐标**取掩膜不透明度。
 *
 * 掩膜是相对 region 的（见 PixelRegion 的说明），
 * 所以查表前必须先减去区域原点 —— 否则 region.minX/minY ≠ 0 时，
 * 笔迹会落到错位的像元上（要么一笔什么都没画上，要么画到隔壁）。
 */
export function maskAlphaAtRegion(
  mask: PixelMask | undefined,
  region: PixelRegion,
  x: number,
  y: number,
): number {
  if (!mask) return 1;
  return maskAlphaAt(mask, x - region.minX, y - region.minY);
}

/** 像元是否落在区域内 */
export function isInside(region: PixelRegion, x: number, y: number): boolean {
  return x >= region.minX && x < region.maxX && y >= region.minY && y < region.maxY;
}

/**
 * 构造 alpha 掩膜。
 * @param featherPx 羽化宽度（像素）；0 表示硬边
 */
export function buildAlphaMask(
  width: number,
  height: number,
  region: PixelRegion,
  featherPx: number,
): Float32Array {
  const mask = new Float32Array(width * height);
  const feather = Math.max(0, featherPx);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (isInside(region, x, y)) {
        mask[idx] = 1;
        continue;
      }
      if (feather <= 0) continue;
      // 到区域边界的距离（像元数，区域外为正）
      const dx = x < region.minX ? region.minX - x : x >= region.maxX ? x - region.maxX + 1 : 0;
      const dy = y < region.minY ? region.minY - y : y >= region.maxY ? y - region.maxY + 1 : 0;
      const dist = Math.max(dx, dy);
      const alpha = 1 - dist / feather;
      if (alpha > 0) mask[idx] = alpha;
    }
  }
  return mask;
}

/** 地理范围 → 像元区域 */
export function geoToPixelRegion(
  bounds: GeoBounds,
  geotransform: readonly number[],
): PixelRegion {
  const originX = geotransform[0] ?? 0;
  const pixelW = geotransform[1] ?? 1;
  const originY = geotransform[3] ?? 0;
  const pixelH = geotransform[5] ?? -1;
  const col = (x: number) => Math.floor((x - originX) / pixelW);
  const row = (y: number) => Math.floor((y - originY) / pixelH);
  return {
    minX: col(bounds.minX),
    minY: row(bounds.maxY),
    maxX: col(bounds.maxX),
    maxY: row(bounds.minY),
  };
}
