/**
 * 图面要素（图框 / 标题栏 / 比例尺 / 图例 / 指北针）的 canvas 2D 绘制。
 *
 * 为什么用 canvas 画，而不是交给 PDF 生成器写文字：
 *   - 引擎的 PDF 封装是"把一张 JPEG 贴进单页"，本来就不接受文字流；
 *     要在 PDF 里显示中文就得内嵌中文字体（子集化 + 写字体文件流 + 校验字节偏移），
 *     那是另一条复杂得多的路；
 *   - canvas 画出来的图面与用户在屏幕上看到的**完全一致**，
 *     "所见即所得"是出图这件事的基本要求；
 *   - 中文字形直接用系统字体（微软雅黑 / 苹方），不引入任何字体文件与许可。
 *
 * 坐标系说明：
 *   本模块只认"像素 + DPI"，不认屏幕还是纸张。
 *   屏幕预览按 96 DPI 画，导出 PDF 按引擎那边默认的 150 DPI 画，
 *   于是同一张图在两种介质上的**物理尺寸**接近一致。
 */

/** 图例里的一项 */
export interface SheetLegendItem {
  readonly name: string;
  /** 色块颜色 */
  readonly color: string;
}

export interface SheetOptions {
  /** 画布宽（像素） */
  readonly width: number;
  /** 画布高（像素） */
  readonly height: number;
  /** 输出设备 DPI：决定字号与图面要素的物理尺寸 */
  readonly dpi: number;
  /** 图名 */
  readonly title: string;
  /** 操作人 */
  readonly operator: string;
  /** 出图时间（已格式化好的字符串） */
  readonly producedAt: string;
  /** 每个像素对应的地面米数（与 width/height 同一像素单位） */
  readonly metersPerPixel: number;
  /**
   * 比例尺分母（1:N）。
   *
   * 不给就按 metersPerPixel × dpi 推算（屏幕场景成立）。
   * 导出 PDF 时必须显式给：引擎会把图缩放到 A4 页面的可用区域，
   * 缩放后的真实比例尺与"图 ÷ DPI"不是一回事。
   */
  readonly scaleDenominator?: number;
  readonly legend: readonly SheetLegendItem[];
}

/** 中文字体栈：优先系统里已装的正经中文字体，最后退回 sans-serif */
const FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", sans-serif';

/**
 * 深色线条与文字。
 * 暖调墨色（不是纯黑）——工程图签上墨线的标准观感，
 * 与界面侧的 --color-ink 同色，屏幕与导出的 PDF 是同一套语言。
 */
const INK = '#1c1a16';

function fontOf(size: number, weight: 'normal' | 'bold' = 'normal'): string {
  return `${weight} ${Math.max(6, size)}px ${FONT_STACK}`;
}

/**
 * 比例尺分母：每英寸地面米数换算成 1:N。
 * 1 英寸 = 0.0254 米。
 */
export function scaleDenominator(metersPerPixel: number, dpi: number): number {
  if (!(metersPerPixel > 0) || !(dpi > 0)) return 0;
  return (metersPerPixel * dpi) / 0.0254;
}

/**
 * 把长度取整成"好看的"档位（1 / 2 / 5 × 10ⁿ）。
 * 比例尺长度必须是人能读懂的整数值，否则没法拿去量地。
 */
export function niceDistance(meters: number): number {
  if (!(meters > 0)) return 1;
  const exp = Math.floor(Math.log10(meters));
  const base = Math.pow(10, exp);
  const norm = meters / base;
  const mult = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return mult * base;
}

/** 地面距离的显示文本 */
export function formatDistance(meters: number): string {
  if (meters >= 1000) {
    const km = meters / 1000;
    return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
  }
  if (meters >= 1) return `${Math.round(meters)} m`;
  return `${Math.round(meters * 100)} cm`;
}

/**
 * 引擎 PDF 封装的页面参数。
 *
 * 与 src/engine/export/pdf.ts 的默认值保持一致——引擎那边没有暴露参数，
 * 前端只能照着算。两边若有一处改了，导出的比例尺会偏，属于可见但非致命的缺陷。
 */
export const PDF_PAGE = {
  /** A4 横版（点） */
  widthPt: 841.89,
  heightPt: 595.28,
  /** 图片四周留白（点） */
  marginPt: 24,
  /** 图纸 DPI */
  dpi: 150,
} as const;

/**
 * 算出这张图贴到 PDF 页面上之后的**真实**比例尺分母。
 *
 * 为什么不能直接用"像素 ÷ DPI"：
 *   引擎把图按 150 DPI 换算成页面上的尺寸后，还要**等比缩放到 A4 的可用区域**。
 *   缩放系数小于 1，图在纸上的实际宽度比"像素 ÷ 150 DPI"算出来的要小，
 *   于是纸上的真实比例尺比图上标的更小。
 *   地图上比例尺标错比没有比例尺更糟，所以这里按引擎的实际摆放规则反算。
 */
export function pdfScaleDenominator(
  imageWidthPx: number,
  imageHeightPx: number,
  metersPerPixel: number,
): number {
  const drawWidth = (imageWidthPx / PDF_PAGE.dpi) * 72;
  const drawHeight = (imageHeightPx / PDF_PAGE.dpi) * 72;
  const availWidth = PDF_PAGE.widthPt - PDF_PAGE.marginPt * 2;
  const availHeight = PDF_PAGE.heightPt - PDF_PAGE.marginPt * 2;
  const scale = Math.min(availWidth / drawWidth, availHeight / drawHeight, 1);
  const paperWidthInch = (drawWidth * scale) / 72;
  const groundWidthMeter = imageWidthPx * metersPerPixel;
  if (!(paperWidthInch > 0) || !(groundWidthMeter > 0)) return 0;
  return groundWidthMeter / (paperWidthInch * 0.0254);
}

/** 比例尺文字：1:50 000（千分位用空格，符合制图惯例） */
export function formatScale(denominator: number): string {
  if (!Number.isFinite(denominator) || denominator <= 0) return '—';
  return `1:${Math.round(denominator).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;
}

/**
 * Web Mercator 下每像素对应的地面米数（以中心纬度计）。
 *
 * 156543.0339… 是 2π·6378137/256，即 512px 切片方案下 zoom 0 的分辨率。
 * 地图保持正北朝上、pitch 为 0 时，这个值就是该点的实际比例尺分母来源。
 */
export function metersPerPixelAt(zoom: number, latitude: number): number {
  const clamped = Math.max(-85.051129, Math.min(85.051129, latitude));
  return (
    (156543.03392804097 * Math.cos((clamped * Math.PI) / 180)) / Math.pow(2, zoom)
  );
}

interface Frame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 图框：外粗内细的双线，套住整幅图 */
function drawFrame(ctx: CanvasRenderingContext2D, width: number, height: number, k: number): Frame {
  const margin = Math.round(6 * k);
  const gap = Math.round(4 * k);
  ctx.save();
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1, 1.6 * k);
  ctx.strokeRect(margin, margin, width - margin * 2, height - margin * 2);
  ctx.lineWidth = Math.max(0.5, 0.6 * k);
  ctx.strokeRect(margin + gap, margin + gap, width - (margin + gap) * 2, height - (margin + gap) * 2);
  ctx.restore();
  return {
    x: margin + gap,
    y: margin + gap,
    w: width - (margin + gap) * 2,
    h: height - (margin + gap) * 2,
  };
}

/** 指北针：正北朝上的简化箭头（本模块假定地图未旋转） */
function drawNorthArrow(ctx: CanvasRenderingContext2D, frame: Frame, k: number): void {
  const size = 20 * k;
  const x = frame.x + frame.w - 20 * k;
  const y = frame.y + 26 * k;
  ctx.save();
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size / 2, y + size);
  ctx.lineTo(x, y + size * 0.7);
  ctx.lineTo(x + size / 2, y + size);
  ctx.closePath();
  ctx.fill();
  ctx.font = fontOf(11 * k, 'bold');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('N', x, y - 6 * k);
  ctx.restore();
}

/** 标题栏：图名 + 出图时间 + 操作人 */
function drawTitleBlock(ctx: CanvasRenderingContext2D, options: SheetOptions, frame: Frame, k: number): void {
  const blockW = Math.min(frame.w * 0.62, 320 * k);
  const blockH = Math.min(frame.h * 0.34, 70 * k);
  const pad = 8 * k;
  const x = frame.x + frame.w - blockW - pad;
  const y = frame.y + frame.h - blockH - pad;
  const titleH = blockH * 0.56;

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fillRect(x, y, blockW, blockH);
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1, 1.1 * k);
  ctx.strokeRect(x, y, blockW, blockH);
  ctx.beginPath();
  ctx.moveTo(x, y + titleH);
  ctx.lineTo(x + blockW, y + titleH);
  const midX = x + blockW / 2;
  ctx.moveTo(midX, y + titleH);
  ctx.lineTo(midX, y + blockH);
  ctx.stroke();

  ctx.fillStyle = INK;
  ctx.textBaseline = 'middle';

  // 图名
  ctx.font = fontOf(14 * k, 'bold');
  ctx.textAlign = 'center';
  ctx.fillText(options.title || '未命名图幅', x + blockW / 2, y + titleH / 2, blockW - 8 * k);

  // 出图时间 / 操作人
  const cellW = blockW / 2;
  const cellY = y + titleH + (blockH - titleH) / 2;
  ctx.font = fontOf(8.5 * k);
  ctx.textAlign = 'left';
  ctx.fillText('出图时间', x + 6 * k, cellY - 7 * k);
  ctx.font = fontOf(9.5 * k);
  ctx.fillText(options.producedAt || '—', x + 6 * k, cellY + 7 * k, cellW - 12 * k);

  ctx.font = fontOf(8.5 * k);
  ctx.textAlign = 'left';
  ctx.fillText('操作人', midX + 6 * k, cellY - 7 * k);
  ctx.font = fontOf(9.5 * k);
  ctx.fillText(options.operator || '—', midX + 6 * k, cellY + 7 * k, cellW - 12 * k);
  ctx.restore();
}

/** 比例尺：黑白相间的分段条 + 比例尺分母 + 实际长度 */
function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  options: SheetOptions,
  frame: Frame,
  k: number,
): number {
  const denominator = options.scaleDenominator ?? scaleDenominator(options.metersPerPixel, options.dpi);
  const targetPx = Math.min(frame.w * 0.34, 150 * k);
  const rawMeters = targetPx * options.metersPerPixel;
  const meters = niceDistance(rawMeters);
  const barPx = Math.max(24, Math.min(frame.w * 0.5, meters / Math.max(options.metersPerPixel, 1e-9)));
  const barH = 7 * k;
  const pad = 8 * k;
  const x = frame.x + pad;
  const y = frame.y + frame.h - barH - pad - 10 * k;

  ctx.save();
  ctx.fillStyle = INK;
  ctx.font = fontOf(9.5 * k);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(formatScale(denominator), x, y - 5 * k);

  const segments = 4;
  const segW = barPx / segments;
  for (let i = 0; i < segments; i++) {
    ctx.fillStyle = i % 2 === 0 ? INK : '#ffffff';
    ctx.fillRect(x + i * segW, y, segW, barH);
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(0.5, 0.6 * k);
    ctx.strokeRect(x + i * segW, y, segW, barH);
  }
  ctx.fillStyle = INK;
  ctx.font = fontOf(9 * k);
  ctx.fillText(formatDistance(meters), x + barPx + 6 * k, y + barH);
  ctx.restore();
  // 返回比例尺顶部位置，供图例往上摆
  return y - 14 * k;
}

/** 图例：图层名 + 色块 */
function drawLegend(
  ctx: CanvasRenderingContext2D,
  options: SheetOptions,
  frame: Frame,
  k: number,
  bottomLimit: number,
): void {
  const items = options.legend;
  if (items.length === 0) return;
  const rowH = 15 * k;
  const headH = 17 * k;
  const boxW = Math.min(frame.w * 0.5, 240 * k);
  const boxH = headH + items.length * rowH + 6 * k;
  const pad = 8 * k;
  const x = frame.x + pad;
  const y = bottomLimit - boxH - 4 * k;
  if (y < frame.y) return;

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fillRect(x, y, boxW, boxH);
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1, 1 * k);
  ctx.strokeRect(x, y, boxW, boxH);

  ctx.fillStyle = INK;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = fontOf(9.5 * k, 'bold');
  ctx.fillText('图例', x + 6 * k, y + headH / 2);

  ctx.font = fontOf(9 * k);
  items.forEach((item, i) => {
    const rowY = y + headH + i * rowH + rowH / 2;
    ctx.fillStyle = item.color;
    ctx.fillRect(x + 6 * k, rowY - 4 * k, 14 * k, 8 * k);
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(0.5, 0.5 * k);
    ctx.strokeRect(x + 6 * k, rowY - 4 * k, 14 * k, 8 * k);
    ctx.fillStyle = INK;
    ctx.fillText(item.name, x + 26 * k, rowY, boxW - 32 * k);
  });
  ctx.restore();
}

/**
 * 把整套图面要素画到 2D 上下文里。
 *
 * 调用方负责把地图影像先铺到底下（导出时就是 drawImage(mapCanvas)），
 * 本函数只画图面要素——所以它既能画在屏幕上的透明覆盖层，也能画进导出用的画布。
 */
export function drawSheet(ctx: CanvasRenderingContext2D, options: SheetOptions): void {
  const { width, height } = options;
  if (width <= 0 || height <= 0) return;
  const k = options.dpi / 96;

  ctx.save();
  ctx.textBaseline = 'alphabetic';
  const frame = drawFrame(ctx, width, height, k);
  const scaleTop = drawScaleBar(ctx, options, frame, k);
  drawLegend(ctx, options, frame, k, scaleTop);
  drawTitleBlock(ctx, options, frame, k);
  drawNorthArrow(ctx, frame, k);
  ctx.restore();
}
