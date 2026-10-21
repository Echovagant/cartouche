/**
 * 边界内插修补（inpaint）。
 *
 * 说明：这是**边界内插**，不是纹理合成（Telea/Navier-Stokes）。
 * 做法：从区域边界开始，逐层用已填充邻居的均值向内推进。
 * 对扫描件上的小污点、折痕通常够用；大面积缺失会明显发糊——
 * 这种场景应改用 raster.replaceRegion 从干净底图取像素。
 */
import { isInside, type PixelRegion } from './mask.ts';

export function inpaintRegion(
  bands: readonly Uint8Array[],
  width: number,
  height: number,
  bandCount: number,
  region: PixelRegion,
  iterations = 8,
): Uint8Array[] {
  const out = bands.map((b) => Uint8Array.from(b));
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
          band[idx] = Math.round(sum / neigh.length);
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
