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
 * 版面规则（2026-10 修）：
 *   以前各块是"画到哪儿算到哪儿"的——图例贴着左下角、标题栏贴着右下角，
 *   两者宽度各自按画幅比例算，谁也不看谁。图幅一窄，图例就压到标题栏底下，
 *   比例尺的数字也会被图例盖掉半截。
 *   现在先把版面**算出来**（computeSheetLayout），再照着算好的位置画：
 *   底部横着分两栏——右栏是标题栏，左栏是图例 + 比例尺组，
 *   两栏之间留出固定间距，比例尺的数字与刻度条永远在同一组里。
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

/** 一个矩形（像素） */
export interface SheetRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 比例尺组的版面：数字、刻度条、末端标注是**一组**，谁也不许单独跑掉 */
export interface SheetScaleLayout {
  /** 整组的外框（数字在最上，刻度条在下） */
  readonly group: SheetRect;
  /** 刻度条本体 */
  readonly bar: SheetRect;
  /** 刻度条代表的长度（米） */
  readonly meters: number;
  /** 比例尺分母文字的基线 y */
  readonly numberBaseline: number;
  /** 末端长度标注的 x */
  readonly distanceX: number;
}

/** 图面要素的版面 */
export interface SheetLayout {
  /** 图框内框 */
  readonly frame: SheetRect;
  /** 标题栏 */
  readonly title: SheetRect;
  /** 图例 */
  readonly legend: SheetRect;
  /** 图例里实际画得下的条目数（画不下时宁可少画一条，也不压住比例尺） */
  readonly legendItems: number;
  /** 图例是否画得下（画幅实在太小就整块不画） */
  readonly legendVisible: boolean;
  /** 比例尺组 */
  readonly scale: SheetScaleLayout;
  /** 指北针的落点（箭头尖） */
  readonly arrow: { readonly x: number; readonly y: number; readonly size: number };
}

/** 图框：外线离画布边的距离、内线与外线的间距（都按 k 缩放） */
const FRAME_MARGIN = 6;
const FRAME_GAP = 4;

function frameMetrics(k: number): { margin: number; gap: number } {
  return { margin: Math.round(FRAME_MARGIN * k), gap: Math.round(FRAME_GAP * k) };
}

/** 图框内框：双线之间那一圈 */
function frameRect(width: number, height: number, k: number): SheetRect {
  const { margin, gap } = frameMetrics(k);
  return {
    x: margin + gap,
    y: margin + gap,
    w: Math.max(0, width - (margin + gap) * 2),
    h: Math.max(0, height - (margin + gap) * 2),
  };
}

/**
 * 算出图面要素的版面。
 *
 * 底部横着分两栏，这是"不压叠"的关键：
 *   - 右栏：标题栏（右下角）；
 *   - 左栏：图例 + 比例尺组（都在左下角，比例尺组在最底）；
 *   - 两栏之间留 blockGap 的间距，图例的宽度再大也不会伸到标题栏底下。
 *
 * 比例尺的数字画在刻度条**上方**、与刻度条同属 scale.group，
 * 图例则摆在 group 上方，两者之间留固定间距——数字不会被裁。
 */
export function computeSheetLayout(options: SheetOptions, k: number): SheetLayout {
  const frame = frameRect(options.width, options.height, k);

  /** 图面要素与图框之间的留白 */
  const pad = 8 * k;
  /** 左右两栏之间的最小间距 */
  const blockGap = 10 * k;

  /* ── 指北针：右上角 ── */
  const arrowSize = 20 * k;
  const arrow = {
    x: frame.x + frame.w - 22 * k,
    y: frame.y + 26 * k,
    size: arrowSize,
  };

  /* ── 标题栏：右下角 ──
     宽度上限取画幅的 44%：再宽，左栏就没有容身之地了。 */
  const titleW = Math.min(frame.w * 0.44, 320 * k);
  const titleBottom = frame.y + frame.h - pad;
  const titleH = Math.min(frame.h * 0.32, 70 * k);
  /** 标题栏不许顶到指北针 */
  const titleTop = Math.max(titleBottom - titleH, arrow.y + arrow.size + 8 * k);
  const title: SheetRect = {
    x: frame.x + frame.w - titleW - pad,
    y: titleTop,
    w: titleW,
    h: Math.max(0, titleBottom - titleTop),
  };

  /* ── 左栏：图例与比例尺共用 ── */
  const colX = frame.x + pad;
  const colW = Math.max(0, title.x - blockGap - colX);

  /* ── 比例尺组：数字在上、刻度条在下 ── */
  const barH = 7 * k;
  const numberSize = 9.5 * k;
  /** 末端长度标注（「2 km」）的宽度预算 */
  const distanceBudget = 34 * k;
  /** 数字基线到刻度条顶边的距离 */
  const numberGap = 4 * k;
  const scaleBottom = frame.y + frame.h - pad - 6 * k;
  const barTop = scaleBottom - barH;
  const numberBaseline = barTop - numberGap;
  const groupTop = numberBaseline - numberSize;

  // 刻度条长度：先按左栏宽度定上限，再取「好看的」档位
  const targetPx = Math.max(12 * k, Math.min(colW - 6 * k - distanceBudget, 150 * k));
  const rawMeters = targetPx * options.metersPerPixel;
  const meters = niceDistance(rawMeters);
  const barWidth = Math.max(
    12 * k,
    Math.min(targetPx, meters / Math.max(options.metersPerPixel, 1e-9)),
  );

  const scale: SheetScaleLayout = {
    group: { x: colX, y: groupTop, w: colW, h: scaleBottom - groupTop },
    bar: { x: colX, y: barTop, w: barWidth, h: barH },
    meters,
    numberBaseline,
    distanceX: colX + barWidth + 6 * k,
  };

  /* ── 图例：左栏里、比例尺组之上 ── */
  const rowH = 15 * k;
  const headH = 17 * k;
  const itemCount = options.legend.length;
  const legendW = Math.min(colW, 240 * k);
  /** 左栏能给图例的最大高度（从图框顶到比例尺组上方） */
  const maxLegendH = groupTop - 8 * k - (frame.y + pad);

  let rows = rowH;
  let items = itemCount;
  let visible = true;
  if (headH + items * rows + 6 * k > maxLegendH) {
    // 放不下：先压行高（下限 10k），还是不行就舍掉放不下的条目
    rows = Math.max(10 * k, Math.min(rows, (maxLegendH - headH - 6 * k) / Math.max(items, 1)));
    if (headH + items * rows + 6 * k > maxLegendH) {
      items = Math.max(0, Math.floor((maxLegendH - headH - 6 * k) / rows));
    }
    if (items <= 0 && itemCount > 0) {
      // 连标题都放不下：整块不画，好过画一个压住比例尺的半截框
      visible = false;
      items = 0;
    }
  }
  const legendH = headH + items * rows + 6 * k;
  // 位置：优先贴在比例尺组上方；下面不够就顶到左上角
  const legendTop = Math.max(frame.y + pad, groupTop - 8 * k - legendH);
  const legend: SheetRect = { x: colX, y: legendTop, w: legendW, h: legendH };

  return {
    frame,
    title,
    legend,
    legendItems: items,
    legendVisible: visible,
    scale,
    arrow,
  };
}

/** 图框：外粗内细的双线，套住整幅图 */
function drawFrame(ctx: CanvasRenderingContext2D, width: number, height: number, k: number): void {
  const { margin, gap } = frameMetrics(k);
  ctx.save();
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1, 1.6 * k);
  ctx.strokeRect(margin, margin, width - margin * 2, height - margin * 2);
  ctx.lineWidth = Math.max(0.5, 0.6 * k);
  ctx.strokeRect(margin + gap, margin + gap, width - (margin + gap) * 2, height - (margin + gap) * 2);
  ctx.restore();
}

/** 指北针：正北朝上的简化箭头（本模块假定地图未旋转） */
function drawNorthArrow(
  ctx: CanvasRenderingContext2D,
  arrow: { readonly x: number; readonly y: number; readonly size: number },
  k: number,
): void {
  const { x, y, size } = arrow;
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
function drawTitleBlock(
  ctx: CanvasRenderingContext2D,
  options: SheetOptions,
  rect: SheetRect,
  k: number,
): void {
  const pad = 8 * k;
  const { x, y } = rect;
  const blockW = rect.w;
  const blockH = rect.h;
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

/**
 * 比例尺：黑白相间的分段条 + 比例尺分母 + 实际长度。
 *
 * 三样东西（数字、刻度条、末端标注）都落在 scale.group 这一组里，
 * 图例摆在组的上方，彼此不重叠——数字不会被裁掉半截。
 */
function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  options: SheetOptions,
  scale: SheetScaleLayout,
  k: number,
): void {
  const denominator = options.scaleDenominator ?? scaleDenominator(options.metersPerPixel, options.dpi);
  const { bar, meters, numberBaseline, distanceX } = scale;

  ctx.save();
  ctx.fillStyle = INK;
  ctx.font = fontOf(9.5 * k);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(formatScale(denominator), bar.x, numberBaseline);

  const segments = 4;
  const segW = bar.w / segments;
  for (let i = 0; i < segments; i++) {
    ctx.fillStyle = i % 2 === 0 ? INK : '#ffffff';
    ctx.fillRect(bar.x + i * segW, bar.y, segW, bar.h);
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(0.5, 0.6 * k);
    ctx.strokeRect(bar.x + i * segW, bar.y, segW, bar.h);
  }
  ctx.fillStyle = INK;
  ctx.font = fontOf(9 * k);
  ctx.fillText(formatDistance(meters), distanceX, bar.y + bar.h);
  ctx.restore();
}

/** 图例：图层名 + 色块 */
function drawLegend(
  ctx: CanvasRenderingContext2D,
  options: SheetOptions,
  rect: SheetRect,
  items: number,
  k: number,
): void {
  const list = options.legend.slice(0, items);
  if (list.length === 0) return;
  const rowH = 15 * k;
  const headH = 17 * k;
  const { x, y } = rect;
  const boxW = rect.w;
  const boxH = headH + list.length * rowH + 6 * k;

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
  list.forEach((item, i) => {
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
  const layout = computeSheetLayout(options, k);
  drawFrame(ctx, width, height, k);
  // 顺序：图例 → 比例尺 → 标题栏 → 指北针。
  // 万一画幅小到放不下，后画的盖住先画的，
  // 但比例尺的数字与刻度条是同一组，永远不会被图例切掉半截。
  if (layout.legendVisible) {
    drawLegend(ctx, options, layout.legend, layout.legendItems, k);
  }
  drawScaleBar(ctx, options, layout.scale, k);
  drawTitleBlock(ctx, options, layout.title, k);
  drawNorthArrow(ctx, layout.arrow, k);
  ctx.restore();
}
