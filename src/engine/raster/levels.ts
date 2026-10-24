/**
 * 亮度 / 对比度调整。
 *
 * linear-stretch：按每波段的实际值域做线性拉伸（扫描件偏暗时用它）
 * gamma：伽马校正（gamma>1 压暗中间调，gamma<1 提亮中间调）
 *
 * 三种方法都在各自算完之后**再叠加 brightness / contrast**，
 * 所以界面上的亮度/对比度滑块在任何方法下都是活的。
 *
 * 按像素类型算：8 位按 0..255、16 位按 0..65535 拉伸后铺满的是该类型的值域，
 * 而不是被压回 0..255。
 *
 * 32 位与浮点（SRTM 的 Int32、Web Mercator 的 Float32 …）走**另一套口径**：
 * 它们没有"满量程"这个概念 —— 0..4294967295 与 -3.4e38..3.4e38 都不是任何真实数据的值域，
 * 拿它当拉伸目标只会把 3000 米的高程变成 6.4e9。所以这类类型一律按**数据的实际值域**算：
 *  - gamma 与亮度/对比度：按该波段自己的 [最小值, 最大值] 归一化，数值始终留在数据范围里；
 *  - linear-stretch：**明确拒绝**（往哪儿拉都是破坏数据，只能把"什么都不做"说清楚）。
 */
import {
  MAX_SAMPLE,
  MIN_SAMPLE,
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

/** 一个值域（闭区间）。 */
interface ValueRange {
  readonly min: number;
  readonly max: number;
}

/**
 * 波段的实际值域。
 *
 * 注意初值不能用 0：负高程的波段（Int16 / Int32 / Float32）整体为负时，
 * 从 0 起算会把最大值算成 0。
 */
function dataRangeOf(band: PixelBand): ValueRange {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of band) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
  return { min, max };
}

/**
 * 这个类型是不是"按满量程拉伸"的那一类。
 *
 * 8 位与 16 位无符号：满量程（0..255 / 0..65535）就是这类影像的真实值域，
 * 拉伸铺满是这一行的既有口径。
 * 其余（Int16 / UInt32 / Int32 / Float32 / Float64）：满量程不是真实数据的值域，
 * 按数据的实际值域算。
 */
function usesFullTypeRange(type: PixelType): boolean {
  return type === 'Byte' || type === 'UInt16';
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
  const fullRange = usesFullTypeRange(type);

  // linear-stretch 只对"满量程就是真实值域"的类型成立。
  // 对 32 位与浮点它没有可拉伸的目标 —— 与其给一个把高程改成天文数字的结果，
  // 不如把"这个方法不适用"说清楚，并指出能用的方法。
  if (method === 'linear-stretch' && !fullRange) {
    throw new Error(
      `线性拉伸不适用于 ${type} 影像：这类类型没有固定值域` +
        `（${MIN_SAMPLE[type]}..${MAX_SAMPLE[type]} 不是真实数据的值域），` +
        '把值域拉过去只会改坏数据的数值范围（3000 米的高程会变成几十亿）。' +
        "请改用 gamma 校正（method: 'gamma'）或亮度/对比度（method: 'manual'），" +
        '它们按数据的实际值域计算。',
    );
  }

  // gamma 查找表与具体波段无关，只建一次；
  // 16 位时是 65536 项（Uint16Array，128 KB）。
  // 只有"满量程索引"的类型才建表 —— 32 位与浮点按数据值域逐样点算，
  // 建不出（也建不起）那么大的表。
  const gammaLut =
    method === 'gamma' && fullRange
      ? buildGammaLut(type, MIN_SAMPLE[type], MAX_SAMPLE[type] - MIN_SAMPLE[type], gamma)
      : undefined;

  return bands.map((band) => {
    const actual = pixelTypeOf(band);
    if (actual !== type) {
      throw new Error(`像素带类型不一致：期望 ${type}，实际 ${actual}。`);
    }
    const out = newBand(type, band.length);

    // 工作值域：满量程类型用类型值域，其余用这条波段自己的实际值域。
    const work: ValueRange = fullRange
      ? { min: MIN_SAMPLE[type], max: MAX_SAMPLE[type] }
      : dataRangeOf(band);
    const span = work.max - work.min;
    // 对比度的中心点取值域中点。取整是为了让 8 位仍然是 128 ——
    // 8 位链路必须一个像元都不变，127.5 会让部分对比度结果差 1。
    const midValue = work.min + Math.round(span / 2);

    if (method === 'gamma') {
      if (gammaLut) {
        const lut = gammaLut;
        for (let i = 0; i < band.length; i++) {
          const v = readSample(band, i);
          writeSample(out, i, readSample(lut, v - work.min), type);
        }
      } else {
        // 数据值域型：逐样点按归一化位置求幂。
        // 值域退化成一点（整幅同值）时不做任何换算 —— 除以 0 只会得到 NaN。
        for (let i = 0; i < band.length; i++) {
          const v = readSample(band, i);
          if (span === 0) {
            writeSample(out, i, v, type);
            continue;
          }
          const t = (v - work.min) / span;
          writeSample(out, i, work.min + span * Math.pow(t, gamma), type);
        }
      }
      return applyManual(out, brightness, contrast, type, midValue, span);
    }

    if (method === 'manual') {
      for (let i = 0; i < band.length; i++) {
        writeSample(out, i, readSample(band, i) + brightness * span, type);
      }
      return applyManual(out, 0, contrast, type, midValue, span);
    }

    // linear-stretch（只对满量程类型走到这里）
    const data = dataRangeOf(band);
    if (data.max === data.min) {
      for (let i = 0; i < band.length; i++) writeSample(out, i, readSample(band, i), type);
      return applyManual(out, brightness, contrast, type, midValue, span);
    }
    const scale = span / (data.max - data.min);
    for (let i = 0; i < band.length; i++) {
      writeSample(out, i, work.min + (readSample(band, i) - data.min) * scale, type);
    }
    // 拉伸之后**照样要吃 brightness** —— 否则"亮度"滑块在默认的 linear-stretch
    // 下是个死控件：滑块动了，像元一个都没变，预演还报"影响 0 个像元"。
    return applyManual(out, brightness, contrast, type, midValue, span);
  });
}

/**
 * gamma 查找表：索引是样点在值域里的位置，值是校正后的样点值。
 *
 * 表长必须等于整个值域（8 位 256 项、16 位 65536 项），
 * 否则 16 位的高值段根本没有对应项，会被当成"查不到"而取错值。
 */
function buildGammaLut(type: PixelType, min: number, span: number, gamma: number): PixelBand {
  const lut = newBand(type, span + 1);
  for (let i = 0; i <= span; i++) {
    writeSample(lut, i, min + span * Math.pow(i / span, gamma), type);
  }
  return lut;
}

/** 叠加亮度与对比度。中心点与亮度项都按目标类型的工作值域算。 */
function applyManual(
  band: PixelBand,
  brightness: number,
  contrast: number,
  type: PixelType,
  midValue: number,
  span: number,
): PixelBand {
  if (brightness === 0 && contrast === 1) return band;
  for (let i = 0; i < band.length; i++) {
    const v = (readSample(band, i) - midValue) * contrast + midValue + brightness * span;
    writeSample(band, i, v, type);
  }
  return band;
}
