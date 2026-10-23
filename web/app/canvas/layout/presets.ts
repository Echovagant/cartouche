/**
 * 内置出图模板。
 *
 * 为什么要有内置模板：大部分交差图纸是有固定规范的（比例尺、图廓偏移、
 * 标题栏该有哪些字段），每次重调一遍既费事又容易调歪。
 * 内置模板是**起点**——套上以后照样能改，改完另存为自己的模板。
 */
import { DEFAULT_LAYOUT, type SheetLayout } from './types.ts';

/** 一个内置模板 */
export interface BuiltinTemplate {
  /** 模板名（也是另存为时的默认名） */
  readonly name: string;
  /** 一句话说明它适合什么场合 */
  readonly description: string;
  readonly layout: SheetLayout;
}

/**
 * 图廓偏移 10 mm。
 *
 * 版式里的长度单位是「96 DPI 下的像素」，换算是 10 / 25.4 × 96 ≈ 37.8。
 */
const FRAME_GAP_10MM = 37.8;

/** 1:500 地形图（A3 横向）：格网 10 cm、标题栏带单位与坐标系 */
const TEMPLATE_1_500: SheetLayout = {
  page: { kind: 'A3', orientation: 'landscape' },
  frame: { outerGap: FRAME_GAP_10MM, innerGap: 4, outerWidth: 1.6, innerWidth: 0.6 },
  graticule: {
    enabled: true,
    kind: 'kilometer',
    interval: 10,
    showLabels: true,
  },
  legend: { items: [], position: 'left' },
  scaleBar: { unit: 'auto', style: 'alternating', position: 'left' },
  titleBlock: {
    position: 'bottom-right',
    fields: {
      title: '',
      unit: '测绘单位',
      crs: 'CGCS2000',
      producedAt: '',
      operator: '',
      reviewer: '',
    },
  },
};

/** 1:1000 地形图（A3 横向）：格网 2 cm（图上），图廓偏移同 10 mm */
const TEMPLATE_1_1000: SheetLayout = {
  ...TEMPLATE_1_500,
  graticule: {
    enabled: true,
    kind: 'kilometer',
    interval: 2,
    showLabels: true,
  },
  titleBlock: {
    position: 'bottom-right',
    fields: {
      title: '',
      unit: '测绘单位',
      crs: 'CGCS2000',
      producedAt: '',
      operator: '',
      reviewer: '',
    },
  },
};

/** A3 横向 · 经纬网版：适合按经纬度查找的图（1:2000 常用） */
const TEMPLATE_1_2000: SheetLayout = {
  ...TEMPLATE_1_500,
  graticule: {
    enabled: true,
    kind: 'geographic',
    interval: 0.01,
    showLabels: true,
  },
};

/** A4 横向 · 简版：无格网、无审核人，只有图名与出图信息 */
const TEMPLATE_A4_SIMPLE: SheetLayout = {
  ...DEFAULT_LAYOUT,
  page: { kind: 'A4', orientation: 'landscape' },
  titleBlock: {
    position: 'bottom-right',
    fields: { title: '', producedAt: '', operator: '' },
  },
};

/** 内置模板清单（面板里按这个顺序列） */
export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  {
    name: '1-500-地形图-A3横向',
    description: '格网 10 cm，图廓偏移 10 mm，标题栏含单位与坐标系',
    layout: TEMPLATE_1_500,
  },
  {
    name: '1-1000-地形图-A3横向',
    description: '格网 2 cm，图廓偏移 10 mm，标题栏含单位与坐标系',
    layout: TEMPLATE_1_1000,
  },
  {
    name: '1-2000-地形图-A3横向',
    description: '经纬网 0.01°，图廓偏移 10 mm，标题栏含单位与坐标系',
    layout: TEMPLATE_1_2000,
  },
  {
    name: 'A4-横-简版',
    description: '无格网、无审核人，只有图名与出图信息',
    layout: TEMPLATE_A4_SIMPLE,
  },
];

/** 按名字取内置模板；没有就返回 null */
export function findBuiltinTemplate(name: string): BuiltinTemplate | null {
  return BUILTIN_TEMPLATES.find((t) => t.name === name) ?? null;
}
