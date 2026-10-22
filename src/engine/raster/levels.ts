/**
 * 亮度 / 对比度调整。
 *
 * linear-stretch：按每波段的实际值域做线性拉伸（扫描件偏暗时用它）
 * gamma：伽马校正（gamma>1 压暗中间调，gamma<1 提亮中间调）
 *
 * 三种方法都在各自算完之后**再叠加 brightness / contrast**，
 * 所以界面上的亮度/对比度滑块在任何方法下都是活的。
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
      return applyManual(out, brightness, contrast);
    }
    const scale = 255 / (max - min);
    for (let i = 0; i < band.length; i++) {
      out[i] = clamp255(Math.round((band[i]! - min) * scale));
    }
    // 拉伸之后**照样要吃 brightness** —— 否则"亮度"滑块在默认的 linear-stretch
    // 下是个死控件：滑块动了，像元一个都没变，预演还报"影响 0 个像元"。
    return applyManual(out, brightness, contrast);
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
