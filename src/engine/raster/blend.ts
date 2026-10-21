/**
 * 区域混合：把覆盖图按 alpha 混合到底图上。
 */
export function blendBands(
  base: readonly Uint8Array[],
  overlay: readonly Uint8Array[],
  alpha: Float32Array,
  bandCount: number,
): Uint8Array[] {
  const out: Uint8Array[] = [];
  const length = alpha.length;

  for (let b = 0; b < bandCount; b++) {
    const baseBand = base[b];
    const overlayBand = overlay[b];
    if (!baseBand || !overlayBand) {
      out.push(new Uint8Array(baseBand ? baseBand : new Uint8Array(length)));
      continue;
    }
    const dst = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const a = alpha[i]!;
      if (a === 0) {
        dst[i] = baseBand[i]!;
      } else if (a === 1) {
        dst[i] = overlayBand[i]!;
      } else {
        const v = baseBand[i]! * (1 - a) + overlayBand[i]! * a;
        dst[i] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
    out.push(dst);
  }
  return out;
}
