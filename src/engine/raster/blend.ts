/**
 * 区域混合：把覆盖图按 alpha 混合到底图上。
 *
 * 按像素类型算：目标带的类型由 `pixelType` 决定（不给就从底图第一条带反推），
 * 取值范围随之变化 —— 16 位影像按 0..65535 混，不会被压成 255。
 */
import {
  newBand,
  pixelTypeOf,
  readSample,
  writeSample,
  type PixelBand,
  type PixelType,
} from './pixels.ts';

export function blendBands(
  base: readonly PixelBand[],
  overlay: readonly PixelBand[],
  alpha: Float32Array,
  bandCount: number,
  pixelType?: PixelType,
): PixelBand[] {
  const type = pixelType ?? (base[0] ? pixelTypeOf(base[0]) : 'Byte');
  const out: PixelBand[] = [];
  const length = alpha.length;

  for (let b = 0; b < bandCount; b++) {
    const baseBand = base[b];
    const overlayBand = overlay[b];
    if (!baseBand || !overlayBand) {
      // 缺一条带就退化成"只留底图"：底图在就整条拷过来，没有就补零。
      if (baseBand) {
        assertBandType(baseBand, type, '底图');
        out.push(copyBand(baseBand, type));
      } else {
        out.push(newBand(type, length));
      }
      continue;
    }
    assertBandType(baseBand, type, '底图');
    assertBandType(overlayBand, type, '覆盖图');

    const dst = newBand(type, length);
    for (let i = 0; i < length; i++) {
      const a = alpha[i] ?? 0;
      if (a === 0) {
        writeSample(dst, i, readSample(baseBand, i), type);
      } else if (a === 1) {
        writeSample(dst, i, readSample(overlayBand, i), type);
      } else {
        const v = readSample(baseBand, i) * (1 - a) + readSample(overlayBand, i) * a;
        writeSample(dst, i, v, type);
      }
    }
    out.push(dst);
  }
  return out;
}

/**
 * 带类型与目标类型不一致时明确报错。
 *
 * 混的是两个不同口径的值域（比如 8 位覆盖图贴到 16 位底图上），
 * 结果既不是"贴进去"也不是"原样保留"，只是算出来一个没有意义的数 ——
 * 与其给一个看着成功的错结果，不如当场拒绝并说清是哪两种类型。
 */
function assertBandType(band: PixelBand, type: PixelType, role: string): void {
  const actual = pixelTypeOf(band);
  if (actual !== type) {
    throw new Error(`像素带类型不一致：期望 ${type}，实际 ${actual}（${role}）。`);
  }
}

/** 同类型逐元素拷贝。`Uint8Array.from` 对 16 位带是逐元素截断，这里必须按带自己的类型拷。 */
function copyBand(band: PixelBand, type: PixelType): PixelBand {
  return type === 'UInt16'
    ? Uint16Array.from(band as Uint16Array)
    : Uint8Array.from(band as Uint8Array);
}
