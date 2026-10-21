/**
 * 亮度 / 对比度调整。
 *
 * linear-stretch：按每波段的实际值域做线性拉伸（扫描件偏暗时用它）
 * gamma：伽马校正（gamma>1 压暗中间调，gamma<1 提亮中间调）
 */
export interface LevelsOptions {
  readonly method?: 'linear-stretch' | 'gamma' | 'manual';
  readonly brightness?: number;
  readonly contrast?: number;
  readonly gamma?: number;
}

export function adjustLevels(
  bands: readonly Uint8Array[],
  options: LevelsOptions = {},
): Uint8Array[] {
  const method = options.method ?? 'linear-stretch';
  const gamma = options.gamma ?? 2.2;
  const brightness = options.brightness ?? 0;
  const contrast = options.contrast ?? 1;

  return bands.map((band) => {
    const out = new Uint8Array(band.length);

    if (method === 'gamma') {
      const lut = new Uint8Array(256);
      for (let v = 0; v < 256; v++) {
        lut[v] = clamp255(Math.round(255 * Math.pow(v / 255, gamma)));
      }
      for (let i = 0; i < band.length; i++) out[i] = lut[band[i]!]!;
      return applyManual(out, brightness, contrast);
    }

    if (method === 'manual') {
      for (let i = 0; i < band.length; i++) {
        out[i] = clamp255(Math.round(band[i]! + brightness * 255));
      }
      return applyManual(out, 0, contrast);
    }

    // linear-stretch
    let min = 255;
    let max = 0;
    for (const v of band) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max === min) {
      for (let i = 0; i < band.length; i++) out[i] = band[i]!;
      return applyManual(out, 0, contrast);
    }
    const scale = 255 / (max - min);
    for (let i = 0; i < band.length; i++) {
      out[i] = clamp255(Math.round((band[i]! - min) * scale));
    }
    return applyManual(out, 0, contrast);
  });
}

function applyManual(band: Uint8Array, brightness: number, contrast: number): Uint8Array {
  if (brightness === 0 && contrast === 1) return band;
  for (let i = 0; i < band.length; i++) {
    const v = (band[i]! - 128) * contrast + 128 + brightness * 255;
    band[i] = clamp255(Math.round(v));
  }
  return band;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
