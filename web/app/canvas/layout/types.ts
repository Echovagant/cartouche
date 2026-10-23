/**
 * 出图版式的类型契约。
 *
 * 为什么把「版式」和「本次出图的内容」拆成两个类型：
 *   版式是**可保存、可复用**的东西（图幅、图廓、格网、图例、比例尺、标题栏），
 *   内容是**这一次**的（图名、操作人、出图时间、比例尺分母、图幅范围）。
 *   混在一起就存不了模板 —— 每次重调一遍，正是这个工具最烦的地方。
 *
 * 单位约定（**看错单位会画错图，所以写死在这里**）：
 *   - frame.*        「96 DPI 下的像素」。图面要素的字号、线宽都是这个尺度，
 *                     换算成毫米是 ×0.2646（96 DPI 下 1 px = 0.2646 mm）。
 *                     用「96 DPI 像素」而不是毫米，是为了让默认版式的算式
 *                     与旧版逐位相同（默认版式必须与改动前一模一样）。
 *   - graticule.interval
 *                   公里网 = **图上厘米**（教程 034 集的口径：图上 10 cm、1:1800 → 180 m）；
 *                   经纬网 = **经度步长（度）**，纬向步长按当前纬度自动算。
 *   - content.metersPerPixel  地面米 / 像素（与画布同一像素单位）。
 */

/** 图例里的一项 */
export interface SheetLegendItem {
  readonly name: string;
  /** 色块颜色 */
  readonly color: string;
  /** 是否画出来（缺省为 true） */
  readonly visible?: boolean;
  /** 色块描边色（缺省用墨色） */
  readonly outline?: string;
}

/** 纸张规格 */
export interface SheetPage {
  readonly kind: 'A4' | 'A3';
  readonly orientation: 'landscape' | 'portrait';
}

/** 图廓（外粗内细双线）的样式 */
export interface SheetFrame {
  /** 外线离画幅边的距离 */
  readonly outerGap: number;
  /** 内外线之间的间距 */
  readonly innerGap: number;
  /** 外线线宽 */
  readonly outerWidth: number;
  /** 内线线宽 */
  readonly innerWidth: number;
}

/** 格网（经纬网 / 公里网） */
export interface SheetGraticule {
  readonly enabled: boolean;
  readonly kind: 'geographic' | 'kilometer';
  /** 公里网：图上厘米；经纬网：经度步长（度） */
  readonly interval: number;
  readonly showLabels: boolean;
  /** 线色（缺省用墨色） */
  readonly lineColor?: string;
  /** 标注色（缺省用墨色） */
  readonly labelColor?: string;
}

/** 图面要素在底栏里的落位 */
export type SheetBlockPosition = 'left' | 'right' | 'bottom';

/** 图例 */
export interface SheetLegend {
  /**
   * 条目列表。
   *
   * 空列表 = 沿用「按图层自动生成」的旧行为（向后兼容的兜底）；
   * 一旦有条目，就以这里为准 —— 用户要能增删、排序、改色。
   */
  readonly items: readonly SheetLegendItem[];
  readonly position: SheetBlockPosition;
  /** 背景色（缺省：半透明白，与旧版一致） */
  readonly background?: string;
  /** 边框色（缺省：墨色） */
  readonly border?: string;
}

/** 比例尺 */
export interface SheetScaleBar {
  /**
   * 长度单位。
   *
   * `auto` = 米以上自动换算成千米（**旧版就是这个行为**，
   * 所以默认版式必须是 auto，否则默认出图会与改动前不一样）。
   */
  readonly unit: 'm' | 'km' | 'auto';
  /** 样式：bar = 实心条带刻度；alternating = 黑白相间分段（旧版）；line = 细线加端点刻度 */
  readonly style: 'bar' | 'alternating' | 'line';
  readonly position: SheetBlockPosition;
}

/** 标题栏里可以出现的字段 */
export interface SheetTitleFields {
  /** 图名（留空 = 用本次出图的图名） */
  readonly title?: string;
  /** 单位 / 测绘单位（留空 = 不显示） */
  readonly unit?: string;
  /** 坐标系（留空 = 不显示） */
  readonly crs?: string;
  /** 出图日期（留空 = 用本次出图的出图时间） */
  readonly producedAt?: string;
  /** 制图人（留空 = 用本次出图的操作人） */
  readonly operator?: string;
  /** 审核人（留空 = 不显示） */
  readonly reviewer?: string;
}

/**
 * 标题栏。
 *
 * `fields` 里**出现过的键就是要显示的字段**（没出现的键不显示）；
 * 值留空时，内容里有对应值就用内容里的（所以「图名/出图时间/操作人」
 * 这三个字段默认跟随本次出图，不必写死在模板里）。
 */
export interface SheetTitleBlock {
  readonly position: 'bottom-right' | 'bottom-left';
  readonly fields: SheetTitleFields;
}

/** 可保存、可复用的出图模板（纯参数，无本次数据） */
export interface SheetLayout {
  readonly page: SheetPage;
  readonly frame: SheetFrame;
  readonly graticule: SheetGraticule;
  readonly legend: SheetLegend;
  readonly scaleBar: SheetScaleBar;
  readonly titleBlock: SheetTitleBlock;
}

/** 地理范围（EPSG:4326，经纬度） */
export interface SheetExtent {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** 本次出图的内容（不进模板） */
export interface SheetContent {
  /** 每个像素对应的地面米数（与画布同一像素单位） */
  readonly metersPerPixel: number;
  /** 比例尺分母（1:N）。不给就按 metersPerPixel × dpi 推算 */
  readonly scaleDenominator?: number;
  /** 图幅的地理范围 */
  readonly extent: SheetExtent;
  /** 坐标系标识 */
  readonly crs?: string;
  /** 图名 */
  readonly title?: string;
  /** 操作人 / 制图人 */
  readonly operator?: string;
  /** 出图时间 */
  readonly producedAt?: string;
}

/**
 * 默认版式：**必须与改动前的视觉完全一致**。
 *
 * 这里的每一个数值都对应旧版 sheet.ts 里的同名常量，
 * 连舍入方式都照抄 —— 默认版式一旦差 1 像素，出图就跟以前不是一张图了。
 */
export const DEFAULT_LAYOUT: SheetLayout = {
  page: { kind: 'A4', orientation: 'landscape' },
  frame: { outerGap: 6, innerGap: 4, outerWidth: 1.6, innerWidth: 0.6 },
  graticule: {
    enabled: false,
    kind: 'geographic',
    interval: 0.01,
    showLabels: true,
  },
  legend: {
    items: [],
    position: 'left',
  },
  scaleBar: {
    unit: 'auto',
    style: 'alternating',
    position: 'left',
  },
  titleBlock: {
    position: 'bottom-right',
    fields: { title: '', producedAt: '', operator: '' },
  },
};

/** 纸张的物理尺寸（毫米） */
export function pageSizeMm(page: SheetPage): { readonly width: number; readonly height: number } {
  const long = page.kind === 'A3' ? 420 : 297;
  const short = page.kind === 'A3' ? 297 : 210;
  return page.orientation === 'landscape'
    ? { width: long, height: short }
    : { width: short, height: long };
}

/** 纸张在给定 DPI 下的像素尺寸 */
export function pageSizePx(
  page: SheetPage,
  dpi: number,
): { readonly width: number; readonly height: number } {
  const mm = pageSizeMm(page);
  const px = (v: number): number => Math.round((v / 25.4) * dpi);
  return { width: px(mm.width), height: px(mm.height) };
}

/** 版式的字段顺序：标题栏单元格按这个顺序排 */
export const TITLE_FIELD_ORDER = [
  'unit',
  'crs',
  'producedAt',
  'operator',
  'reviewer',
] as const;

/**
 * 标题栏字段的中文名。
 *
 * `operator` 这一格用「操作人」而不是「制图人」：
 * 旧版画的就是「操作人」，默认版式必须与旧版一字不差。
 */
export const TITLE_FIELD_LABELS: Record<(typeof TITLE_FIELD_ORDER)[number], string> = {
  unit: '单位',
  crs: '坐标系',
  producedAt: '出图时间',
  operator: '操作人',
  reviewer: '审核人',
};

/** 版式读不出来时的错误：必须说清是哪一处、为什么 */
export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutError';
  }
}

/* ── 校验 ─────────────────────────────────────────────────── */

function fail(path: string, why: string): never {
  throw new LayoutError(`出图模板的 ${path} 不对：${why}`);
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, '应该是一个对象');
  }
  return value as Record<string, unknown>;
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, '应该是一个数字');
  }
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, '应该是 true 或 false');
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, '应该是一个字符串');
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const s = str(value, path);
  if (!(allowed as readonly string[]).includes(s)) {
    fail(path, `只能是 ${allowed.join(' / ')} 之一，实际是「${s}」`);
  }
  return s as T;
}

function optionalStr(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return str(value, path);
}

function optionalNum(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return num(value, path);
}

function normalizeLegendItem(raw: unknown, path: string): SheetLegendItem {
  const o = obj(raw, path);
  const name = str(o['name'], `${path}.name`);
  if (!name.trim()) fail(`${path}.name`, '不能为空');
  const color = str(o['color'], `${path}.color`);
  const visible = o['visible'] === undefined ? true : bool(o['visible'], `${path}.visible`);
  const outline = optionalStr(o['outline'], `${path}.outline`);
  return { name, color, visible, ...(outline ? { outline } : {}) };
}

/**
 * 把任意来源（JSON 文件、表单、内置模板）校验成一份合法的版式。
 *
 * 为什么要这么严：模板是**要复用的东西**，读坏了却悄悄用默认值顶上，
 * 用户会拿着一个跟他以为的不一样的模板出图 —— 那比直接报错糟得多。
 */
export function normalizeLayout(raw: unknown): SheetLayout {
  const o = obj(raw, '整体');

  const pageRaw = obj(o['page'], 'page');
  const page: SheetPage = {
    kind: oneOf(pageRaw['kind'], 'page.kind', ['A4', 'A3'] as const),
    orientation: oneOf(pageRaw['orientation'], 'page.orientation', [
      'landscape',
      'portrait',
    ] as const),
  };

  const frameRaw = obj(o['frame'], 'frame');
  const frame: SheetFrame = {
    outerGap: num(frameRaw['outerGap'], 'frame.outerGap'),
    innerGap: num(frameRaw['innerGap'], 'frame.innerGap'),
    outerWidth: num(frameRaw['outerWidth'], 'frame.outerWidth'),
    innerWidth: num(frameRaw['innerWidth'], 'frame.innerWidth'),
  };
  for (const key of ['outerGap', 'innerGap', 'outerWidth', 'innerWidth'] as const) {
    if (frame[key] < 0) fail(`frame.${key}`, '不能是负数');
  }

  const graticuleRaw = obj(o['graticule'], 'graticule');
  const graticule: SheetGraticule = {
    enabled: bool(graticuleRaw['enabled'], 'graticule.enabled'),
    kind: oneOf(graticuleRaw['kind'], 'graticule.kind', ['geographic', 'kilometer'] as const),
    interval: num(graticuleRaw['interval'], 'graticule.interval'),
    showLabels: bool(graticuleRaw['showLabels'], 'graticule.showLabels'),
    ...(optionalStr(graticuleRaw['lineColor'], 'graticule.lineColor') !== undefined
      ? { lineColor: optionalStr(graticuleRaw['lineColor'], 'graticule.lineColor') }
      : {}),
    ...(optionalStr(graticuleRaw['labelColor'], 'graticule.labelColor') !== undefined
      ? { labelColor: optionalStr(graticuleRaw['labelColor'], 'graticule.labelColor') }
      : {}),
  };
  if (!(graticule.interval > 0)) fail('graticule.interval', '必须大于 0');

  const legendRaw = obj(o['legend'], 'legend');
  const legendItemsRaw = legendRaw['items'];
  if (!Array.isArray(legendItemsRaw)) fail('legend.items', '应该是一个数组');
  const legend: SheetLegend = {
    items: legendItemsRaw.map((item, i) => normalizeLegendItem(item, `legend.items[${i}]`)),
    position: oneOf(legendRaw['position'], 'legend.position', [
      'left',
      'right',
      'bottom',
    ] as const),
    ...(optionalStr(legendRaw['background'], 'legend.background') !== undefined
      ? { background: optionalStr(legendRaw['background'], 'legend.background') }
      : {}),
    ...(optionalStr(legendRaw['border'], 'legend.border') !== undefined
      ? { border: optionalStr(legendRaw['border'], 'legend.border') }
      : {}),
  };

  const scaleRaw = obj(o['scaleBar'], 'scaleBar');
  const scaleBar: SheetScaleBar = {
    unit: oneOf(scaleRaw['unit'], 'scaleBar.unit', ['m', 'km', 'auto'] as const),
    style: oneOf(scaleRaw['style'], 'scaleBar.style', [
      'bar',
      'alternating',
      'line',
    ] as const),
    position: oneOf(scaleRaw['position'], 'scaleBar.position', [
      'left',
      'right',
      'bottom',
    ] as const),
  };

  const titleRaw = obj(o['titleBlock'], 'titleBlock');
  const fieldsRaw = obj(titleRaw['fields'] ?? {}, 'titleBlock.fields');
  const fields: SheetTitleFields = {
    ...(optionalStr(fieldsRaw['title'], 'titleBlock.fields.title') !== undefined
      ? { title: optionalStr(fieldsRaw['title'], 'titleBlock.fields.title') }
      : {}),
    ...(optionalStr(fieldsRaw['unit'], 'titleBlock.fields.unit') !== undefined
      ? { unit: optionalStr(fieldsRaw['unit'], 'titleBlock.fields.unit') }
      : {}),
    ...(optionalStr(fieldsRaw['crs'], 'titleBlock.fields.crs') !== undefined
      ? { crs: optionalStr(fieldsRaw['crs'], 'titleBlock.fields.crs') }
      : {}),
    ...(optionalStr(fieldsRaw['producedAt'], 'titleBlock.fields.producedAt') !== undefined
      ? { producedAt: optionalStr(fieldsRaw['producedAt'], 'titleBlock.fields.producedAt') }
      : {}),
    ...(optionalStr(fieldsRaw['operator'], 'titleBlock.fields.operator') !== undefined
      ? { operator: optionalStr(fieldsRaw['operator'], 'titleBlock.fields.operator') }
      : {}),
    ...(optionalStr(fieldsRaw['reviewer'], 'titleBlock.fields.reviewer') !== undefined
      ? { reviewer: optionalStr(fieldsRaw['reviewer'], 'titleBlock.fields.reviewer') }
      : {}),
  };
  const titleBlock: SheetTitleBlock = {
    position: oneOf(titleRaw['position'], 'titleBlock.position', [
      'bottom-right',
      'bottom-left',
    ] as const),
    fields,
  };

  return { page, frame, graticule, legend, scaleBar, titleBlock };
}

/** 版式 → JSON（人可读、可 diff） */
export function serializeLayout(layout: SheetLayout): string {
  return `${JSON.stringify(layout, null, 2)}\n`;
}

/** JSON → 版式；坏了就说清楚坏在哪 */
export function parseLayout(text: string, source = '出图模板'): SheetLayout {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new LayoutError(`${source} 不是合法的 JSON：${(err as Error).message}`);
  }
  try {
    return normalizeLayout(raw);
  } catch (err) {
    throw new LayoutError(`${source} 的内容不对：${(err as Error).message}`);
  }
}

/**
 * 逐字段地改一份版式。
 *
 * 面板上的每一次编辑都走这里 —— 改一个字段就重写整份，
 * 免得"面板状态"和"模板文件"两套东西对不上。
 */
export function mergeLayout(base: SheetLayout, patch: DeepPartial<SheetLayout>): SheetLayout {
  return normalizeLayout(mergeUnknown(base, patch));
}

/** 深合并（数组整体替换，不做逐项合并 —— 图例条目是整体管理的） */
function mergeUnknown(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (patch === null) return patch;
  if (Array.isArray(patch)) return patch;
  if (typeof patch !== 'object') return patch;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = mergeUnknown((base as Record<string, unknown>)[key], value);
  }
  return out;
}

/** 深部分类型（面板改单字段时用） */
export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly U[]
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;
