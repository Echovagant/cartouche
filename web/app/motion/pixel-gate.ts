/**
 * 像元闸门那一行的口径。
 *
 * 为什么单独一个文件：这是个**纯函数**，而 ConfirmCardBody 是 .tsx（含 JSX，
 * node 的类型剥离不支持），纯逻辑放在 .ts 里才能被单测直接测到。
 *
 * 官网与画布必须**逐字一致**——官网写「165 / 1,200 像元（13.8%）」，
 * 画布算出来也必须是同一串字，不然官网就在说谎了。
 */

/**
 * ⚠️ 三个数都可能是 null：非像元型 op（改属性、加字段那种）根本没有像元口径，
 * 引擎给的就是 null。这里必须认这个情况 ——
 * 显示「0 / 0 像元」是给用户一个假数字，
 * 而直接在 null 上调 toLocaleString 会把整页带崩（2026-10-24 实测踩到过：
 * AI 页的单条计划走确认卡，矢量 op 的 null 像元直接把页面打崩成错误页）。
 */
export function formatPixelGate(
  affectedPixels: number | null,
  totalPixels: number | null,
  ratio: number,
): string {
  if (affectedPixels === null || totalPixels === null) {
    return '不按像元计（这类操作改的不是像元）';
  }
  return `${affectedPixels.toLocaleString('zh-CN')} / ${totalPixels.toLocaleString('zh-CN')} 像元（${(ratio * 100).toFixed(1)}%）`;
}
