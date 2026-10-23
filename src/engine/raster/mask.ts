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
 * 区域是否与影像（width×height）有交集。
 *
 * 像元坐标从 (0,0) 起算，所以区域必须与 [0,width)×[0,height) 有重叠。
 * 区域整个落在影像之外时，逐像元的循环一个都不会执行 ——
 * 结果就是「改了 0 个像元，却报成功」。
 */
export function regionHitsRaster(region: PixelRegion, width: number, height: number): boolean {
  return region.minX < width && region.maxX > 0 && region.minY < height && region.maxY > 0;
}

/** 区域的可读描述：minX=100..maxX=110，minY=100..maxY=110 */
export function describeRegion(region: PixelRegion): string {
  return `minX=${region.minX}..maxX=${region.maxX}，minY=${region.minY}..maxY=${region.maxY}`;
}

/**
 * 「区域没有落到影像上」的报错文案。
 *
 * 栅格层（raster/ops.ts）与调度层（ops/executor.ts）共用这一份 ——
 * 两处各写各的，同一件事就会给出两种说法，测出来的「一致」是假的。
 */
export function regionOffRasterMessage(
  region: PixelRegion,
  width: number,
  height: number,
): string {
  return (
    `区域没有落到影像上（影像 ${width}×${height}，区域 ${describeRegion(region)}）：` +
    `一个像元都落不进这张图，改了等于没改`
  );
}

/** 「一个像元都没改到」的报错文案 */
export function zeroImpactMessage(
  width: number,
  height: number,
  region?: PixelRegion,
): string {
  const where = region ? `，区域 ${describeRegion(region)}` : '';
  return (
    `这次改动一个像元都没改到（影像 ${width}×${height}${where}）：` +
    `没有任何像素发生变化，已中止，未做任何改动`
  );
}

/**
 * 掩膜在区域内是否覆盖到至少一个像元。
 *
 * 掩膜坐标**相对 region 左上角**（见 PixelMask 的说明），
 * 所以掩膜 (mx,my) 对应的是绝对像元 (region.minX+mx, region.minY+my)；
 * 落在 region 之外的部分不算覆盖。
 */
export function maskHitsRegion(mask: PixelMask, region: PixelRegion): boolean {
  for (let my = 0; my < mask.height; my++) {
    const y = region.minY + my;
    if (y < region.minY || y >= region.maxY) continue;
    for (let mx = 0; mx < mask.width; mx++) {
      const x = region.minX + mx;
      if (x < region.minX || x >= region.maxX) continue;
      if ((mask.alpha[my * mask.width + mx] ?? 0) > 0) return true;
    }
  }
  return false;
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
