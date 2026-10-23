/**
 * 图面要素（图框 / 标题栏 / 比例尺 / 图例 / 指北针 / 格网）的 canvas 2D 绘制。
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
 *   现在先把版面**算出来**（computeSheetGeometry），再照着算好的位置画：
 *   底部横着分两栏——右栏是标题栏，左栏是图例 + 比例尺组，
 *   两栏之间留出固定间距，比例尺的数字与刻度条永远在同一组里。
 *
 * 参数化（SP-5a）：
 *   五个绘制器现在都吃**版式参数**（SheetLayout），缺省值保持改动前的视觉结果。
 *   这条是硬要求：默认版式必须与旧版逐像素一致，
 *   所以默认版式里的每个数字都对应本文件里的同名常量，连舍入方式都照抄。
 *
 * 坐标系说明：
 *   本模块只认"像素 + DPI"，不认屏幕还是纸张。
 *   屏幕预览按 96 DPI 画，导出 PDF 按引擎那边默认的 150 DPI 画，
 *   于是同一张图在两种介质上的**物理尺寸**接近一致。
 */

import {
  DEFAULT_LAYOUT,
  TITLE_FIELD_LABELS,
  TITLE_FIELD_ORDER,
  type SheetContent,
  type SheetLayout,
  type SheetLegendItem,
} from './layout/types.ts';

export type { SheetLegendItem, SheetLayout, SheetContent } from './layout/types.ts';

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
  /** 版式（不给就用默认版式 = 改动前的视觉） */
  readonly layout?: SheetLayout;
  /** 本次出图的内容（不给就按上面的字段推） */
  readonly content?: SheetContent;
}

/**
 * 当前生效的图面状态。
 *
 * 为什么放在模块里而不是 props 里：画布那一侧（MapCanvas）只认
 * `drawSheet(ctx, options)` 这一个入口，面板改了版式之后要立刻反映到画布上，
 * 两边就得有一个共同的落点。
 * viewport 给的是**提供器**而不是快照 —— 地图一直在动，快照会过期。
 */
export interface ActiveSheetState {
  readonly layout: SheetLayout;
  /** 画图那一刻的当前视野（经纬度包围盒 + 画布尺寸） */
  readonly viewport?: () => {
    readonly bbox: readonly number[];
    readonly width: number;
    readonly height: number;
  } | null;
}

let activeSheetState: ActiveSheetState | null = null;

/** 设定当前生效的图面状态（传 null 回到默认版式） */
export function setActiveSheetState(state: ActiveSheetState | null): void {
  activeSheetState = state;
}

/** 取当前生效的图面状态 */
export function getActiveSheetState(): ActiveSheetState | null {
  return activeSheetState;
}

/** 中文字体栈：优先系统里已装的正经中文字体，最后退回 sans-serif */
const FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", sans-serif';

/**
 * 深色线条与文字。
 * 暖调墨色（不是纯黑）——工程图签上墨线的标准观感，
 * 与界面侧的 --color-ink 同色，屏幕与导出的 PDF 是同一套语言。
 */
const INK = '#1c1a16';

/** 格网的线色：比墨色淡一档，压在地图上不至于盖住要素 */
const GRATICULE_INK = 'rgba(28,26,22,0.5)';

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

/**
 * 格网间隔的"好看档位"：10/20/50/100/200/500 米，1/2/5 千米。
 *
 * 与 niceDistance 的 1-2-5 通用档位不同，这里的下限是 10 米 ——
 * 比 10 米还小的格网在图上密到看不清，只是噪声。
 */
const GRID_STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000] as const;

/** 把地面米数规整到最近的"好看"档位（平局取小的） */
export function niceGridStep(meters: number): number {
  if (!(meters > 0)) return GRID_STEPS[0];
  let best: number = GRID_STEPS[0];
  let bestGap = Math.abs(meters - best);
  for (const step of GRID_STEPS) {
    const gap = Math.abs(meters - step);
    if (gap < bestGap) {
      best = step;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * 图上厘米 → 地面米数。
 *
 * 口径来自教程 034 集：格网间隔按**图面物理尺寸**给，
 * 工具按比例尺换算成地理量 —— 图上 10 cm、1:1800 → 10/100 × 1800 = 180 m。
 */
export function groundMetersForInterval(centimeters: number, scaleDenominatorValue: number): number {
  if (!(centimeters > 0) || !(scaleDenominatorValue > 0)) return 0;
  return (centimeters / 100) * scaleDenominatorValue;
}

/**
 * 经度步长 → 纬度步长。
 *
 * 同一个度数间隔，经向的实际长度随纬度按 cos 收缩，纬向不变。
 * 要图上近似正方，纬向步长就得乘上 cos(纬度) —— 再补一个经纬度的
 * 长度差（111.32 km / 110.57 km ≈ 1.0068），正方得才准。
 */
export function latitudeStepFor(longitudeStep: number, latitude: number): number {
  if (!(longitudeStep > 0)) return 0;
  const rad = (Math.max(-85, Math.min(85, latitude)) * Math.PI) / 180;
  return longitudeStep * Math.cos(rad) * 1.0068;
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

/** 图面要素的版面（算出来的位置，不是可保存的版式） */
export interface SheetGeometry {
  /** 图框内框 */
  readonly frame: SheetRect;
  /** 标题栏 */
  readonly title: SheetRect;
  /** 标题栏里的字段行数 */
  readonly titleRows: number;
  /** 标题栏里标题区的高度 */
  readonly titleHeaderH: number;
  /** 标题栏里一行字段的高度 */
  readonly titleRowH: number;
  /** 图例 */
  readonly legend: SheetRect;
  /** 图例里实际画得下的条目数（画不下时宁可少画一条，也不压住比例尺） */
  readonly legendItems: number;
  /** 图例是否画得下（画幅实在太小就整块不画） */
  readonly legendVisible: boolean;
  /** 图例是否横排（位置 = bottom 时） */
  readonly legendHorizontal: boolean;
  /** 比例尺组 */
  readonly scale: SheetScaleLayout;
  /** 指北针的落点（箭头尖） */
  readonly arrow: { readonly x: number; readonly y: number; readonly size: number };
  /** 底栏的两栏 */
  readonly columns: { readonly left: SheetRect; readonly right: SheetRect };
}

/** 标题栏里要显示的字段个数（不含图名） */
function titleCellCount(layout: SheetLayout): number {
  return TITLE_FIELD_ORDER.filter((key) => key in layout.titleBlock.fields).length;
}

/** 图框：外线离画布边的距离、内线与外线的间距（都按 k 缩放） */
const FRAME_MARGIN = 6;
const FRAME_GAP = 4;

function frameMetrics(
  frame: SheetLayout['frame'],
  k: number,
): { margin: number; gap: number } {
  return {
    margin: Math.round(frame.outerGap * k),
    gap: Math.round(frame.innerGap * k),
  };
}

/** 图框内框：双线之间那一圈 */
function frameRect(width: number, height: number, frame: SheetLayout['frame'], k: number): SheetRect {
  const { margin, gap } = frameMetrics(frame, k);
  return {
    x: margin + gap,
    y: margin + gap,
    w: Math.max(0, width - (margin + gap) * 2),
    h: Math.max(0, height - (margin + gap) * 2),
  };
}

/** 估算文本宽度：中文按一个字宽，其余按半个字宽 */
function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    units += /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch) ? 1 : 0.55;
  }
  return units * fontSize;
}

/**
 * 算出图面要素的版面。
 *
 * 底部横着分两栏，这是"不压叠"的关键：
 *   - 一栏：标题栏（按 titleBlock.position 落在左下或右下）；
 *   - 另一栏：图例 + 比例尺组（比例尺组在最底）。
 *
 * 比例尺的数字画在刻度条**上方**、与刻度条同属 scale.group，
 * 图例则摆在 group 上方，两者之间留固定间距——数字不会被裁。
 */
export function computeSheetGeometry(
  options: SheetOptions,
  layout: SheetLayout,
  content: SheetContent,
  k: number,
): SheetGeometry {
  const { width, height } = options;
  const frame = frameRect(width, height, layout.frame, k);

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

  /* ── 标题栏：落在指定的那一角 ──
     宽度上限取画幅的 44%：再宽，另一栏就没有容身之地了。
     高度随字段行数长：字段多的时候每行都要放得下"标签 + 值"，
     否则几行字会叠在一起（改版式最常见的事故）。 */
  const titleW = Math.min(frame.w * 0.44, 320 * k);
  const titleBottom = frame.y + frame.h - pad;
  const titleRows = Math.max(1, Math.ceil(titleCellCount(layout) / 2));
  /** 旧版单行时的高度；字段多时按行数往外长 */
  const titleBaseH = Math.min(frame.h * 0.32, 70 * k);
  const titleHeaderH = titleBaseH * 0.56;
  const titleRowH = titleBaseH * 0.44;
  const titleH = Math.min(titleHeaderH + titleRows * titleRowH, frame.h * 0.72);
  /** 标题栏不许顶到指北针 */
  const titleTop = Math.max(titleBottom - titleH, arrow.y + arrow.size + 8 * k);
  const titleOnLeft = layout.titleBlock.position === 'bottom-left';
  const titleX = titleOnLeft ? frame.x + pad : frame.x + frame.w - titleW - pad;
  const title: SheetRect = {
    x: titleX,
    y: titleTop,
    w: titleW,
    h: Math.max(0, titleBottom - titleTop),
  };

  /* ── 底栏的两栏 ──
     标题栏占一栏（宽度 titleW），另一栏留给图例与比例尺。
     栏宽随标题栏的位置镜像，所以标题栏挪到左边时另一栏自然变宽。 */
  const bandLeft = frame.x + pad;
  const bandRight = frame.x + frame.w - pad;
  const columnTop = frame.y + pad;
  const columnHeight = Math.max(0, frame.h - pad * 2);
  const columns = titleOnLeft
    ? {
        left: { x: bandLeft, y: columnTop, w: titleW, h: columnHeight },
        right: {
          x: titleX + titleW + blockGap,
          y: columnTop,
          w: Math.max(0, bandRight - (titleX + titleW + blockGap)),
          h: columnHeight,
        },
      }
    : {
        left: {
          x: bandLeft,
          y: columnTop,
          w: Math.max(0, titleX - blockGap - bandLeft),
          h: columnHeight,
        },
        right: { x: titleX, y: columnTop, w: titleW, h: columnHeight },
      };

  /** 某一栏归谁用：位置说的是"落在哪一栏" */
  const columnFor = (position: SheetLayout['legend']['position']): SheetRect => {
    if (position === 'right') return columns.right;
    if (position === 'bottom') return titleOnLeft ? columns.right : columns.left;
    return columns.left;
  };
  const legendColumn = columnFor(layout.legend.position);
  const scaleColumn = columnFor(layout.scaleBar.position);

  /* ── 比例尺组：数字在上、刻度条在下 ── */
  const barH = 7 * k;
  const numberSize = 9.5 * k;
  /** 末端长度标注（「2 km」）的宽度预算 */
  const distanceBudget = 34 * k;
  /** 数字基线到刻度条顶边的距离 */
  const numberGap = 4 * k;
  /** 标题栏若在同一栏，比例尺组要排在它上面 */
  const scaleColumnHasTitle = scaleColumn === (titleOnLeft ? columns.left : columns.right);
  const scaleBottom = scaleColumnHasTitle
    ? titleTop - blockGap
    : scaleColumn.y + scaleColumn.h - 6 * k;
  const barTop = scaleBottom - barH;
  const numberBaseline = barTop - numberGap;
  const groupTop = numberBaseline - numberSize;

  // 刻度条长度：先按所在栏的宽度定上限，再取「好看的」档位
  const targetPx = Math.max(12 * k, Math.min(scaleColumn.w - 6 * k - distanceBudget, 150 * k));
  const rawMeters = targetPx * content.metersPerPixel;
  const meters = niceDistance(rawMeters);
  const barWidth = Math.max(
    12 * k,
    Math.min(targetPx, meters / Math.max(content.metersPerPixel, 1e-9)),
  );
  /** 位置 = bottom 时刻度条在这一栏里居中 */
  const barX =
    layout.scaleBar.position === 'bottom'
      ? scaleColumn.x + Math.max(0, (scaleColumn.w - barWidth) / 2)
      : scaleColumn.x;

  const scale: SheetScaleLayout = {
    group: { x: scaleColumn.x, y: groupTop, w: scaleColumn.w, h: scaleBottom - groupTop },
    bar: { x: barX, y: barTop, w: barWidth, h: barH },
    meters,
    numberBaseline,
    distanceX: barX + barWidth + 6 * k,
  };

  /* ── 图例 ── */
  const rowH = 15 * k;
  const headH = 17 * k;
  const items = layout.legend.items.filter((item) => item.visible !== false);
  const itemCount = items.length;
  const legendHorizontal = layout.legend.position === 'bottom';
  const legendColumnHasTitle = legendColumn === (titleOnLeft ? columns.left : columns.right);
  /** 图例所在栏的可用底边 */
  const legendBottom =
    legendColumn === scaleColumn
      ? groupTop - 8 * k
      : legendColumnHasTitle
        ? titleTop - blockGap
        : legendColumn.y + legendColumn.h;
  let legendW = Math.min(legendColumn.w, 240 * k);

  let legendH = headH + itemCount * rowH + 6 * k;
  let drawn = itemCount;
  let visible = true;
  if (legendHorizontal) {
    // 横排：所有条目并排一行，放不下就少画几条
    const swatch = 14 * k;
    const gap = 4 * k;
    const itemGap = 10 * k;
    const textSize = 9 * k;
    let used = 12 * k;
    drawn = 0;
    for (const item of items) {
      const w = swatch + gap + estimateTextWidth(item.name, textSize) + itemGap;
      if (used + w > legendColumn.w) break;
      used += w;
      drawn += 1;
    }
    // 横排的框宽按实际排开的宽度走，不吃竖排那个 240 的上限
    legendW = Math.min(legendColumn.w, used);
    legendH = headH + rowH + 6 * k;
  } else {
    /** 左栏能给图例的最大高度（从图框顶到图例底边） */
    const maxLegendH = legendBottom - (frame.y + pad);
    let rows = rowH;
    if (headH + itemCount * rows + 6 * k > maxLegendH) {
      // 放不下：先压行高（下限 10k），还是不行就舍掉放不下的条目
      rows = Math.max(10 * k, Math.min(rows, (maxLegendH - headH - 6 * k) / Math.max(itemCount, 1)));
      if (headH + itemCount * rows + 6 * k > maxLegendH) {
        drawn = Math.max(0, Math.floor((maxLegendH - headH - 6 * k) / rows));
      }
      if (drawn <= 0 && itemCount > 0) {
        // 连标题都放不下：整块不画，好过画一个压住比例尺的半截框
        visible = false;
        drawn = 0;
      }
    }
    legendH = headH + drawn * rows + 6 * k;
  }
  // 位置：优先贴着可用底边；下面不够就顶到左上角
  const legendTop = Math.max(frame.y + pad, legendBottom - legendH);
  const legend: SheetRect = { x: legendColumn.x, y: legendTop, w: legendW, h: legendH };

  return {
    frame,
    title,
    titleRows,
    titleHeaderH,
    titleRowH,
    legend,
    legendItems: drawn,
    legendVisible: visible,
    legendHorizontal,
    scale,
    arrow,
    columns,
  };
}

/* ── 格网 ───────────────────────────────────────────────── */

/** 格网的档位上限：一条方向上最多画这么多条线 */
export const MAX_GRATICULE_LINES = 20;

/** 经度步长的候选档位（度） */
const GEO_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1] as const;

/** Web Mercator 的 y 坐标（无量纲，纬度越高值越小） */
function mercatorY(latitude: number): number {
  const clamped = Math.max(-85.051129, Math.min(85.051129, latitude));
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
}

/** Web Mercator 的 y 反算纬度 */
function latitudeFromMercatorY(y: number): number {
  return (Math.atan(Math.sinh(y)) * 180) / Math.PI;
}

/** 一条格网线 */
export interface GraticuleLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** 一个格网标注 */
export interface GraticuleLabel {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly align: 'left' | 'center' | 'right';
  readonly baseline: 'top' | 'middle';
}

/** 格网的算好的几何 */
export interface GraticuleGeometry {
  readonly lines: readonly GraticuleLine[];
  readonly labels: readonly GraticuleLabel[];
}

/** 经纬度标注的小数位：步长越小要越多位，否则两条线的标注会一样 */
function decimalsFor(step: number): number {
  return Math.min(6, Math.max(4, Math.ceil(-Math.log10(step))));
}

/**
 * 算格网的几何：线在哪、标注写什么。
 *
 * 公里网按**图幅中心纬度**处的米/像素换算成等距方格。
 * Web Mercator 上同一个"地面米"在高纬度对应的像素更少，
 * 所以公里网在图幅很大时边缘会有偏差 —— 这是本地坐标近似，
 * 换真的公里网需要投影坐标系，超出本轮范围。
 */
export function computeGraticule(
  layout: SheetLayout,
  content: SheetContent,
  canvas: { readonly width: number; readonly height: number },
  rect: SheetRect,
): GraticuleGeometry {
  const g = layout.graticule;
  const empty: GraticuleGeometry = { lines: [], labels: [] };
  if (!g.enabled) return empty;

  const { extent } = content;
  if (
    !Number.isFinite(extent.minX) ||
    !Number.isFinite(extent.minY) ||
    !Number.isFinite(extent.maxX) ||
    !Number.isFinite(extent.maxY) ||
    !(extent.maxX > extent.minX) ||
    !(extent.maxY > extent.minY)
  ) {
    return empty;
  }

  const lines: GraticuleLine[] = [];
  const labels: GraticuleLabel[] = [];
  const labelInset = 4;

  if (g.kind === 'kilometer') {
    const denominator =
      content.scaleDenominator ?? scaleDenominator(content.metersPerPixel, 96);
    const rawMeters = groundMetersForInterval(g.interval, denominator);
    let stepMeters = niceGridStep(rawMeters);
    if (!(stepMeters > 0)) return empty;
    const stepPx = stepMeters / Math.max(content.metersPerPixel, 1e-9);
    if (!(stepPx > 0)) return empty;

    // 线太多就把步长放大（按"好看档位"重取），免得图上糊成一片
    const countX = Math.floor(rect.w / stepPx) + 1;
    const countY = Math.floor(rect.h / stepPx) + 1;
    if (countX > MAX_GRATICULE_LINES || countY > MAX_GRATICULE_LINES) {
      const factor = Math.max(countX, countY) / MAX_GRATICULE_LINES;
      stepMeters = niceGridStep(stepMeters * factor);
      const grown = stepMeters / Math.max(content.metersPerPixel, 1e-9);
      if (!(grown > 0)) return empty;
      return computeKilometerGrid(g, content, rect, grown, stepMeters, labelInset);
    }
    return computeKilometerGrid(g, content, rect, stepPx, stepMeters, labelInset);
  }

  /* ── 经纬网 ── */
  const lonStep = g.interval > 0 ? g.interval : 0.01;
  const centerLat = (extent.minY + extent.maxY) / 2;
  const latStep = latitudeStepFor(lonStep, centerLat);
  if (!(lonStep > 0) || !(latStep > 0)) return empty;

  // 线太多就把步长放大到下一个"好看"的档位，免得图上糊成一片
  const countX = Math.floor((extent.maxX - extent.minX) / lonStep) + 1;
  const countY = Math.floor((extent.maxY - extent.minY) / latStep) + 1;
  if (countX > MAX_GRATICULE_LINES || countY > MAX_GRATICULE_LINES) {
    let grown = lonStep;
    for (const step of GEO_STEPS) {
      if (step <= lonStep) continue;
      const grownLat = latitudeStepFor(step, centerLat);
      const nX = Math.floor((extent.maxX - extent.minX) / step) + 1;
      const nY = Math.floor((extent.maxY - extent.minY) / grownLat) + 1;
      if (nX <= MAX_GRATICULE_LINES && nY <= MAX_GRATICULE_LINES) {
        grown = step;
        break;
      }
      grown = step;
    }
    return computeGeographicGrid(g, content, canvas, rect, grown, centerLat);
  }

  return computeGeographicGrid(g, content, canvas, rect, lonStep, centerLat);
}

/** 经纬网的具体排布（步长定好之后再算线与标注） */
function computeGeographicGrid(
  g: SheetLayout['graticule'],
  content: SheetContent,
  canvas: { readonly width: number; readonly height: number },
  rect: SheetRect,
  lonStep: number,
  centerLat: number,
): GraticuleGeometry {
  const { extent } = content;
  const lines: GraticuleLine[] = [];
  const labels: GraticuleLabel[] = [];
  const labelInset = 4;
  const latStep = latitudeStepFor(lonStep, centerLat);
  const lonDecimals = decimalsFor(lonStep);
  const latDecimals = decimalsFor(latStep);

  const lonStart = Math.ceil(extent.minX / lonStep) * lonStep;
  for (let lon = lonStart; lon <= extent.maxX + 1e-9; lon += lonStep) {
    const x = ((lon - extent.minX) / (extent.maxX - extent.minX)) * canvas.width;
    if (x < rect.x - 0.5 || x > rect.x + rect.w + 0.5) continue;
    lines.push({ x1: x, y1: rect.y, x2: x, y2: rect.y + rect.h });
    labels.push({
      text: `E ${lon.toFixed(lonDecimals)}`,
      x,
      y: rect.y + labelInset,
      align: 'center',
      baseline: 'top',
    });
  }

  const myNorth = mercatorY(extent.maxY);
  const mySouth = mercatorY(extent.minY);
  const latStart = Math.ceil(extent.minY / latStep) * latStep;
  for (let lat = latStart; lat <= extent.maxY + 1e-9; lat += latStep) {
    const my = mercatorY(lat);
    const frac = (my - myNorth) / (mySouth - myNorth);
    const y = frac * canvas.height;
    if (y < rect.y - 0.5 || y > rect.y + rect.h + 0.5) continue;
    lines.push({ x1: rect.x, y1: y, x2: rect.x + rect.w, y2: y });
    labels.push({
      text: `N ${lat.toFixed(latDecimals)}`,
      x: rect.x + labelInset,
      y,
      align: 'left',
      baseline: 'middle',
    });
  }

  return { lines, labels };
}

/** 公里网的具体排布（单独拎出来：步长调整后要整体重算） */
function computeKilometerGrid(
  g: SheetLayout['graticule'],
  content: SheetContent,
  rect: SheetRect,
  stepPx: number,
  stepMeters: number,
  labelInset: number,
): GraticuleGeometry {
  const lines: GraticuleLine[] = [];
  const labels: GraticuleLabel[] = [];
  /**
   * 标注的单位跟着步长走：步长不到 1 km 就写米。
   * 写成 km 的话，50 m 的步长会变成「0.1 km」——数值直接翻倍，图上是错的。
   */
  const useMeters = stepMeters < 1000;
  const unit = useMeters ? 1 : 1000;
  const stepValue = stepMeters / unit;
  const decimals = Number.isInteger(stepValue) ? 0 : 1;

  const countX = Math.floor(rect.w / stepPx) + 1;
  const countY = Math.floor(rect.h / stepPx) + 1;
  for (let i = 0; i <= countX; i += 1) {
    const x = rect.x + i * stepPx;
    if (x > rect.x + rect.w + 0.5) break;
    lines.push({ x1: x, y1: rect.y, x2: x, y2: rect.y + rect.h });
    labels.push({
      text: `${(i * stepValue).toFixed(decimals)}${useMeters ? ' m' : ' km'}`,
      x,
      y: rect.y + labelInset,
      align: 'center',
      baseline: 'top',
    });
  }
  for (let j = 0; j <= countY; j += 1) {
    const y = rect.y + j * stepPx;
    if (y > rect.y + rect.h + 0.5) break;
    lines.push({ x1: rect.x, y1: y, x2: rect.x + rect.w, y2: y });
    labels.push({
      text: `${(j * stepValue).toFixed(decimals)}${useMeters ? ' m' : ' km'}`,
      x: rect.x + labelInset,
      y,
      align: 'left',
      baseline: 'middle',
    });
  }
  return { lines, labels };
}

/**
 * 建议一个格网间隔。
 *
 * 目标是图上大约 10 cm 一条线 —— 出图规范里的常用值，
 * 再按比例尺换算成地理量，最后规整到"好看"的档位。
 */
export function suggestGraticuleInterval(
  layout: SheetLayout,
  content: SheetContent,
  targetCentimeters = 10,
): number {
  const denominator = content.scaleDenominator ?? scaleDenominator(content.metersPerPixel, 96);
  if (!(denominator > 0)) return layout.graticule.interval;
  const groundMeters = groundMetersForInterval(targetCentimeters, denominator);
  if (layout.graticule.kind === 'kilometer') {
    const step = niceGridStep(groundMeters);
    const cm = (step / denominator) * 100;
    // 图上厘米取整到 0.5 cm 一档，用户填起来不别扭
    return Math.max(0.5, Math.round(cm * 2) / 2);
  }
  const centerLat = (content.extent.minY + content.extent.maxY) / 2;
  const metersPerDegree = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const degrees = groundMeters / Math.max(metersPerDegree, 1e-6);
  let best: number = GEO_STEPS[0];
  for (const step of GEO_STEPS) {
    if (step <= degrees * 1.0001) best = step;
  }
  return best;
}

/* ── 绘制 ───────────────────────────────────────────────── */

/** 图框：外粗内细的双线，套住整幅图 */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: SheetLayout['frame'],
  k: number,
): void {
  const { margin, gap } = frameMetrics(frame, k);
  ctx.save();
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1, frame.outerWidth * k);
  ctx.strokeRect(margin, margin, width - margin * 2, height - margin * 2);
  ctx.lineWidth = Math.max(0.5, frame.innerWidth * k);
  ctx.strokeRect(margin + gap, margin + gap, width - (margin + gap) * 2, height - (margin + gap) * 2);
  ctx.restore();
}

/** 格网：线 + 标注 */
function drawGraticule(
  ctx: CanvasRenderingContext2D,
  layout: SheetLayout,
  content: SheetContent,
  canvas: { readonly width: number; readonly height: number },
  rect: SheetRect,
  k: number,
): void {
  const g = layout.graticule;
  if (!g.enabled) return;
  const geometry = computeGraticule(layout, content, canvas, rect);
  if (geometry.lines.length === 0 && geometry.labels.length === 0) return;

  ctx.save();
  ctx.strokeStyle = g.lineColor ?? GRATICULE_INK;
  ctx.lineWidth = Math.max(0.5, 0.6 * k);
  ctx.beginPath();
  for (const line of geometry.lines) {
    ctx.moveTo(line.x1, line.y1);
    ctx.lineTo(line.x2, line.y2);
  }
  ctx.stroke();

  if (g.showLabels) {
    ctx.fillStyle = g.labelColor ?? INK;
    ctx.font = fontOf(8 * k);
    for (const label of geometry.labels) {
      ctx.textAlign = label.align;
      ctx.textBaseline = label.baseline;
      ctx.fillText(label.text, label.x, label.y);
    }
  }
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

/** 标题栏里要显示的单元格（键出现过就显示，空值回落到本次出图的内容） */
function titleCells(
  layout: SheetLayout,
  content: SheetContent,
): { readonly label: string; readonly value: string }[] {
  const fields = layout.titleBlock.fields;
  const cells: { label: string; value: string }[] = [];
  for (const key of TITLE_FIELD_ORDER) {
    if (!(key in fields)) continue;
    const fixed = fields[key];
    let value = fixed ?? '';
    if (!value) {
      if (key === 'producedAt') value = content.producedAt ?? '';
      if (key === 'operator') value = content.operator ?? '';
    }
    cells.push({ label: TITLE_FIELD_LABELS[key], value: value || '—' });
  }
  return cells;
}

/** 标题栏：图名 + 可配置的字段格 */
function drawTitleBlock(
  ctx: CanvasRenderingContext2D,
  layout: SheetLayout,
  content: SheetContent,
  rect: SheetRect,
  rows: number,
  headerH: number,
  k: number,
): void {
  const { x, y } = rect;
  const blockW = rect.w;
  const blockH = rect.h;
  const fields = layout.titleBlock.fields;
  const hasTitle = 'title' in fields;
  /** 标题区的高度：旧版是整块的 56% */
  const titleH = hasTitle ? Math.min(headerH, blockH) : 0;
  const cells = titleCells(layout, content);
  const cellH = Math.max(0, (blockH - titleH) / Math.max(1, rows));

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fillRect(x, y, blockW, blockH);
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1, 1.1 * k);
  ctx.strokeRect(x, y, blockW, blockH);
  ctx.beginPath();
  if (hasTitle) {
    ctx.moveTo(x, y + titleH);
    ctx.lineTo(x + blockW, y + titleH);
  }
  // 列分隔线：两列时就是中间那道竖线
  const midX = x + blockW / 2;
  ctx.moveTo(midX, y + titleH);
  ctx.lineTo(midX, y + blockH);
  // 行分隔线
  for (let r = 1; r < rows; r += 1) {
    const lineY = y + titleH + cellH * r;
    ctx.moveTo(x, lineY);
    ctx.lineTo(x + blockW, lineY);
  }
  ctx.stroke();

  ctx.fillStyle = INK;
  ctx.textBaseline = 'middle';

  if (hasTitle) {
    // 图名
    ctx.font = fontOf(14 * k, 'bold');
    ctx.textAlign = 'center';
    ctx.fillText(fields.title || content.title || '未命名图幅', x + blockW / 2, y + titleH / 2, blockW - 8 * k);
  }

  const cellW = blockW / 2;
  cells.forEach((cell, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const cellX = x + col * cellW;
    const cellY = y + titleH + cellH * row + cellH / 2;
    const labelOffset = Math.min(7 * k, cellH * 0.25);
    ctx.font = fontOf(8.5 * k);
    ctx.textAlign = 'left';
    ctx.fillText(cell.label, cellX + 6 * k, cellY - labelOffset);
    ctx.font = fontOf(9.5 * k);
    ctx.fillText(cell.value, cellX + 6 * k, cellY + labelOffset, cellW - 12 * k);
  });
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
  layout: SheetLayout,
  content: SheetContent,
  dpi: number,
  scale: SheetScaleLayout,
  k: number,
): void {
  const denominator = content.scaleDenominator ?? scaleDenominator(content.metersPerPixel, dpi);
  const { bar, meters, numberBaseline, distanceX } = scale;

  ctx.save();
  ctx.fillStyle = INK;
  ctx.font = fontOf(9.5 * k);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(formatScale(denominator), bar.x, numberBaseline);

  if (layout.scaleBar.style === 'alternating') {
    const segments = 4;
    const segW = bar.w / segments;
    for (let i = 0; i < segments; i++) {
      ctx.fillStyle = i % 2 === 0 ? INK : '#ffffff';
      ctx.fillRect(bar.x + i * segW, bar.y, segW, bar.h);
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(0.5, 0.6 * k);
      ctx.strokeRect(bar.x + i * segW, bar.y, segW, bar.h);
    }
  } else if (layout.scaleBar.style === 'bar') {
    ctx.fillStyle = INK;
    ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(0.5, 0.6 * k);
    ctx.strokeRect(bar.x, bar.y, bar.w, bar.h);
    // 刻度线
    ctx.beginPath();
    for (let i = 1; i < 4; i += 1) {
      const x = bar.x + (bar.w / 4) * i;
      ctx.moveTo(x, bar.y);
      ctx.lineTo(x, bar.y + bar.h);
    }
    ctx.stroke();
  } else {
    // line：一条细线加两端的端点刻度
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(1, 1.2 * k);
    ctx.beginPath();
    ctx.moveTo(bar.x, bar.y + bar.h / 2);
    ctx.lineTo(bar.x + bar.w, bar.y + bar.h / 2);
    ctx.moveTo(bar.x, bar.y);
    ctx.lineTo(bar.x, bar.y + bar.h);
    ctx.moveTo(bar.x + bar.w, bar.y);
    ctx.lineTo(bar.x + bar.w, bar.y + bar.h);
    ctx.stroke();
  }

  ctx.fillStyle = INK;
  ctx.font = fontOf(9 * k);
  ctx.fillText(scaleDistanceLabel(meters, layout.scaleBar.unit), distanceX, bar.y + bar.h);
  ctx.restore();
}

/** 比例尺末端的长度标注：单位可配（auto = 米以上自动换算成千米，与旧版一致） */
function scaleDistanceLabel(meters: number, unit: SheetLayout['scaleBar']['unit']): string {
  if (unit === 'm') return `${Math.round(meters)} m`;
  if (unit === 'km') {
    const km = meters / 1000;
    return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
  }
  return formatDistance(meters);
}

/** 图例：图层名 + 色块 */
function drawLegend(
  ctx: CanvasRenderingContext2D,
  layout: SheetLayout,
  legendItems: readonly SheetLegendItem[],
  rect: SheetRect,
  items: number,
  horizontal: boolean,
  k: number,
): void {
  const list = legendItems.slice(0, items);
  if (list.length === 0) return;
  const rowH = 15 * k;
  const headH = 17 * k;
  const { x, y } = rect;
  const boxW = rect.w;
  const boxH = horizontal ? headH + rowH + 6 * k : headH + list.length * rowH + 6 * k;

  ctx.save();
  ctx.fillStyle = layout.legend.background ?? 'rgba(255,255,255,0.88)';
  ctx.fillRect(x, y, boxW, boxH);
  ctx.strokeStyle = layout.legend.border ?? INK;
  ctx.lineWidth = Math.max(1, 1 * k);
  ctx.strokeRect(x, y, boxW, boxH);

  ctx.fillStyle = INK;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = fontOf(9.5 * k, 'bold');
  ctx.fillText('图例', x + 6 * k, y + headH / 2);

  ctx.font = fontOf(9 * k);
  if (horizontal) {
    // 横排：条目并排，间距固定
    const swatchW = 14 * k;
    const gap = 4 * k;
    const itemGap = 10 * k;
    const rowY = y + headH + rowH / 2;
    let cursor = x + 6 * k;
    for (const item of list) {
      ctx.fillStyle = item.color;
      ctx.fillRect(cursor, rowY - 4 * k, swatchW, 8 * k);
      ctx.strokeStyle = item.outline ?? INK;
      ctx.lineWidth = Math.max(0.5, 0.5 * k);
      ctx.strokeRect(cursor, rowY - 4 * k, swatchW, 8 * k);
      ctx.fillStyle = INK;
      const textX = cursor + swatchW + gap;
      ctx.fillText(item.name, textX, rowY, boxW - (textX - x) - 6 * k);
      cursor = textX + estimateTextWidth(item.name, 9 * k) + itemGap;
    }
  } else {
    list.forEach((item, i) => {
      const rowY = y + headH + i * rowH + rowH / 2;
      ctx.fillStyle = item.color;
      ctx.fillRect(x + 6 * k, rowY - 4 * k, 14 * k, 8 * k);
      ctx.strokeStyle = item.outline ?? INK;
      ctx.lineWidth = Math.max(0.5, 0.5 * k);
      ctx.strokeRect(x + 6 * k, rowY - 4 * k, 14 * k, 8 * k);
      ctx.fillStyle = INK;
      ctx.fillText(item.name, x + 26 * k, rowY, boxW - 32 * k);
    });
  }
  ctx.restore();
}

/** 由旧参数拼出本次出图的内容 */
function contentFromOptions(
  options: SheetOptions,
  active: ActiveSheetState | null,
): SheetContent {
  const viewport = active?.viewport?.() ?? null;
  const bbox = viewport?.bbox ?? null;
  const extent =
    options.content?.extent ??
    (bbox && bbox.length >= 4
      ? { minX: bbox[0]!, minY: bbox[1]!, maxX: bbox[2]!, maxY: bbox[3]! }
      : { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  return {
    metersPerPixel: options.content?.metersPerPixel ?? options.metersPerPixel,
    ...(options.content?.scaleDenominator !== undefined
      ? { scaleDenominator: options.content.scaleDenominator }
      : options.scaleDenominator !== undefined
        ? { scaleDenominator: options.scaleDenominator }
        : {}),
    extent,
    ...(options.content?.crs ? { crs: options.content.crs } : {}),
    ...(options.title ? { title: options.title } : {}),
    ...(options.operator ? { operator: options.operator } : {}),
    ...(options.producedAt ? { producedAt: options.producedAt } : {}),
  };
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

  const active = getActiveSheetState();
  const layout = options.layout ?? active?.layout ?? DEFAULT_LAYOUT;
  const content = contentFromOptions(options, active);
  /**
   * 图例条目：版式里有就用版式的（用户可控），没有就沿用按图层自动生成的。
   * 这条兜底是向后兼容的关键 —— 默认版式不带条目，
   * 图例照旧由图层自动生成，跟改动前一样。
   */
  const effectiveLayout: SheetLayout =
    layout.legend.items.length > 0
      ? layout
      : { ...layout, legend: { ...layout.legend, items: options.legend } };

  ctx.save();
  ctx.textBaseline = 'alphabetic';
  const geometry = computeSheetGeometry(options, effectiveLayout, content, k);
  drawGraticule(ctx, effectiveLayout, content, { width, height }, geometry.frame, k);
  drawFrame(ctx, width, height, effectiveLayout.frame, k);
  // 顺序：图例 → 比例尺 → 标题栏 → 指北针。
  // 万一画幅小到放不下，后画的盖住先画的，
  // 但比例尺的数字与刻度条是同一组，永远不会被图例切掉半截。
  if (geometry.legendVisible) {
    drawLegend(
      ctx,
      effectiveLayout,
      effectiveLayout.legend.items,
      geometry.legend,
      geometry.legendItems,
      geometry.legendHorizontal,
      k,
    );
  }
  drawScaleBar(ctx, effectiveLayout, content, options.dpi, geometry.scale, k);
  drawTitleBlock(
    ctx,
    effectiveLayout,
    content,
    geometry.title,
    geometry.titleRows,
    geometry.titleHeaderH,
    k,
  );
  drawNorthArrow(ctx, geometry.arrow, k);
  ctx.restore();
}
