/**
 * 边界内插修补（inpaint）。
 *
 * 说明：这是**边界内插**，不是纹理合成（Telea/Navier-Stokes）。
 * 做法：从区域边界开始，逐层用已填充邻居的均值向内推进。
 * 对扫描件上的小污点、折痕通常够用；大面积缺失会明显发糊——
 * 这种场景应改用 raster.replaceRegion 从干净底图取像素。
 *
 * 按像素类型算：16 位影像的拷贝与填补都按 0..65535 走，
 * 不会被 `Uint8Array.from` 逐元素截断成 255；
 * 32 位与浮点带同理（负高程、小数位都不会在拷贝时丢掉）。
 */
import { isInside, type PixelRegion } from './mask.ts';
import {
  copyBand,
  pixelTypeOf,
  writeSample,
  type PixelBand,
  type PixelType,
} from './pixels.ts';

export function inpaintRegion(
  bands: readonly PixelBand[],
  width: number,
  height: number,
  bandCount: number,
  region: PixelRegion,
  iterations = 8,
  pixelType?: PixelType,
): PixelBand[] {
  const type = pixelType ?? (bands[0] ? pixelTypeOf(bands[0]) : 'Byte');
  const out = bands.map((b) => {
    const actual = pixelTypeOf(b);
    if (actual !== type) {
      throw new Error(`像素带类型不一致：期望 ${type}，实际 ${actual}。`);
    }
    // 同类型逐元素拷贝：`Uint8Array.from(b)` 对 16 位带是**逐元素截断**，
    // 65535 会被写成 255 —— 值被改坏了却看不出来。
    // 32 位与浮点带同理（负高程会被写成天文数字），所以按带自己的类型拷。
    return copyBand(b, type);
  });
  const total = width * height;

  // 待填充像元：区域内
  const pending = new Uint8Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isInside(region, x, y)) pending[y * width + x] = 1;
    }
  }
  const pendingCount = pending.reduce((s, v) => s + v, 0);
  if (pendingCount === 0) return out;

  const filled = new Uint8Array(total); // 1 = 已有可信像素
  for (let i = 0; i < total; i++) filled[i] = pending[i] ? 0 : 1;

  for (let iter = 0; iter < iterations; iter++) {
    let changed = 0;
    const nextFilled = Uint8Array.from(filled);
    const nextPending = Uint8Array.from(pending);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (!pending[idx]) continue;

        // 收集 4 邻域中已填充的邻居
        const neigh: number[] = [];
        if (x > 0 && filled[idx - 1]) neigh.push(idx - 1);
        if (x < width - 1 && filled[idx + 1]) neigh.push(idx + 1);
        if (y > 0 && filled[idx - width]) neigh.push(idx - width);
        if (y < height - 1 && filled[idx + width]) neigh.push(idx + width);
        if (neigh.length === 0) continue;

        for (let b = 0; b < bandCount; b++) {
          const band = out[b];
          if (!band) continue;
          let sum = 0;
          for (const n of neigh) sum += band[n]!;
          // 均值按目标类型落盘：钳位与取整交给 writeSample
          writeSample(band, idx, sum / neigh.length, type);
        }
        nextFilled[idx] = 1;
        nextPending[idx] = 0;
        changed++;
      }
    }

    filled.set(nextFilled);
    pending.set(nextPending);
    if (changed === 0) break;
  }

  return out;
}
