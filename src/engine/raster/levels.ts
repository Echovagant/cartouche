/**
 * 亮度 / 对比度调整。
 *
 * linear-stretch：按每波段的实际值域做线性拉伸（扫描件偏暗时用它）
 * gamma：伽马校正（gamma>1 压暗中间调，gamma<1 提亮中间调）
 *
 * 三种方法都在各自算完之后**再叠加 brightness / contrast**，
 * 所以界面上的亮度/对比度滑块在任何方法下都是活的。
 *
 * 按像素类型算：值域上限取该类型的最大值（8 位 255、16 位 65535），
 * 所以 16 位影像拉伸后铺满的是 0..65535，而不是被压回 0..255。
 */
import {
  MAX_SAMPLE,
  newBand,
  pixelTypeOf,
  readSample,
  writeSample,
  type PixelBand,
  type PixelType,
} from './pixels.ts';

export interface LevelsOptions {
  readonly method?: 'linear-stretch' | 'gamma' | 'manual';
  readonly brightness?: number;
  readonly contrast?: number;
  readonly gamma?: number;
}

export function adjustLevels(
  bands: readonly PixelBand[],
  options: LevelsOptions = {},
  pixelType?: PixelType,
): PixelBand[] {
  const method = options.method ?? 'linear-stretch';
  const gamma = options.gamma ?? 2.2;
  const brightness = options.brightness ?? 0;
  const contrast = options.contrast ?? 1;

  const type = pixelType ?? (bands[0] ? pixelTypeOf(bands[0]) : 'Byte');
  const maxValue = MAX_SAMPLE[type];
  // 对比度的中心点取值域中点。取整是为了让 8 位仍然是 128 ——
  // 8 位链路必须一个像元都不变，127.5 会让部分对比度结果差 1。
  const midValue = Math.round(maxValue / 2);
  // gamma 的查找表与具体波段无关，只建一次；16 位时是 65536 项（Uint16Array，128 KB）
  const gammaLut = method === 'gamma' ? buildGammaLut(type, maxValue, gamma) : undefined;

  return bands.map((band) => {
    const actual = pixelTypeOf(band);
    if (actual !== type) {
      throw new Error(`像素带类型不一致：期望 ${type}，实际 ${actual}。`);
    }
    const out = newBand(type, band.length);

    if (method === 'gamma') {
      const lut = gammaLut!;
      for (let i = 0; i < band.length; i++) {
        writeSample(out, i, readSample(lut, readSample(band, i)), type);
      }
      return applyManual(out, brightness, contrast, type, midValue, maxValue);
    }

    if (method === 'manual') {
      for (let i = 0; i < band.length; i++) {
        writeSample(out, i, readSample(band, i) + brightness * maxValue, type);
      }
      return applyManual(out, 0, contrast, type, midValue, maxValue);
    }

    // linear-stretch
    let min = maxValue;
    let max = 0;
    for (const v of band) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max === min) {
      for (let i = 0; i < band.length; i++) writeSample(out, i, readSample(band, i), type);
      return applyManual(out, brightness, contrast, type, midValue, maxValue);
    }
    const scale = maxValue / (max - min);
    for (let i = 0; i < band.length; i++) {
      writeSample(out, i, (readSample(band, i) - min) * scale, type);
    }
    // 拉伸之后**照样要吃 brightness** —— 否则"亮度"滑块在默认的 linear-stretch
    // 下是个死控件：滑块动了，像元一个都没变，预演还报"影响 0 个像元"。
    return applyManual(out, brightness, contrast, type, midValue, maxValue);
  });
}

/**
 * gamma 查找表：索引是样点值，值是校正后的样点值。
 *
 * 表长必须等于整个值域（8 位 256 项、16 位 65536 项），
 * 否则 16 位的高值段根本没有对应项，会被当成"查不到"而取错值。
 */
function buildGammaLut(type: PixelType, maxValue: number, gamma: number): PixelBand {
  const lut = newBand(type, maxValue + 1);
  for (let v = 0; v <= maxValue; v++) {
    writeSample(lut, v, maxValue * Math.pow(v / maxValue, gamma), type);
  }
  return lut;
}

/** 叠加亮度与对比度。中心点与亮度项都按目标类型的值域算。 */
function applyManual(
  band: PixelBand,
  brightness: number,
  contrast: number,
  type: PixelType,
  midValue: number,
  maxValue: number,
): PixelBand {
  if (brightness === 0 && contrast === 1) return band;
  for (let i = 0; i < band.length; i++) {
    const v = (readSample(band, i) - midValue) * contrast + midValue + brightness * maxValue;
    writeSample(band, i, v, type);
  }
  return band;
}
