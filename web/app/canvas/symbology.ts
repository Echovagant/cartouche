/**
 * 符号化与标注的纯逻辑（不依赖 React / MapLibre 运行时）。
 *
 * 为什么单独一个文件：配色、分级断点、类别汇总、标注锚点这些都要能单测；
 * 塞进画布组件里就只能靠人眼看，改错一个色带没人拦得住。
 *
 * 最小切片的边界（明确不做）：
 *  - 渲染器只有三种：单色 / 唯一值 / 分级色彩；
 *  - 不做渐变填充、点符号图案、复杂线型、3D；
 *  - 标注只支持一个字段、固定字号/颜色/描边，不做压盖避让之外的排版。
 */
import type { SheetLegendItem } from './sheet';

export type SymbologyKind = 'single' | 'unique' | 'graduated';
export type GraduatedMethod = 'equal' | 'quantile';

export interface SingleSymbology {
  readonly kind: 'single';
  readonly color: string;
}

export interface UniqueSymbology {
  readonly kind: 'unique';
  readonly field: string;
  /** 键是 `categoryKey()` 的结果（带类型前缀，数字 1 与文字 "1" 不混） */
  readonly colors: Readonly<Record<string, string>>;
  /** 没有命中任何类别的要素用什么颜色 */
  readonly fallback: string;
}

export interface GraduatedSymbology {
  readonly kind: 'graduated';
  readonly field: string;
  readonly method: GraduatedMethod;
  /** 升序断点；颜色数 = 断点数 + 1 */
  readonly breaks: readonly number[];
  readonly colors: readonly string[];
}

export type Symbology = SingleSymbology | UniqueSymbology | GraduatedSymbology;

export interface LabelStyle {
  readonly field: string;
  /** 字号（屏幕 CSS 像素） */
  readonly size: number;
  readonly color: string;
  /** 描边色（通常是纸色或深色，用来保证可读性） */
  readonly halo: string;
}

export interface LayerStyle {
  readonly symbology?: Symbology;
  readonly labels?: LabelStyle;
}

/** 没配样式时的默认色（与画布原来的单色一致） */
export const DEFAULT_VECTOR_COLOR = '#2f6f5e';
export const DEFAULT_FALLBACK_COLOR = '#9aa5a0';

/** 四种色带，每种 7 档 —— 够 3/5/7 级与最多 7 类唯一值使用 */
export const COLOR_RAMPS: readonly { readonly id: string; readonly label: string; readonly colors: readonly string[] }[] = [
  {
    id: 'forest',
    label: '林地绿',
    colors: ['#e9f0e6', '#cfe0c8', '#a9c9a0', '#7fae74', '#55904a', '#2f6f3e', '#1b4d2b'],
  },
  {
    id: 'earth',
    label: '土黄',
    colors: ['#f4ecdd', '#e8d6b8', '#d8bb8d', '#c49e63', '#a97f45', '#8a6030', '#684520'],
  },
  {
    id: 'water',
    label: '水系蓝',
    colors: ['#e8f1f6', '#cfe2ee', '#a9cbe1', '#7fb0d0', '#5593bd', '#2f74a0', '#1b5580'],
  },
  {
    id: 'warm',
    label: '暖色',
    colors: ['#f8ece4', '#f2d4c2', '#e9b39a', '#dd8f70', '#c96a4c', '#a94c33', '#7f3321'],
  },
];

/** 默认色带 */
export const DEFAULT_RAMP = COLOR_RAMPS[0]!;

/** 配色方案的中文名 */
export function rampLabel(id: string): string {
  return COLOR_RAMPS.find((r) => r.id === id)?.label ?? id;
}

/**
 * 按类别数从色带里等比取色。
 *
 * 取色是**固定规则**：同一个色带、同一个类别数，永远得到同一组颜色 ——
 * 否则用户每次打开面板看到的颜色都可能不一样，没法交差。
 */
export function buildPalette(rampId: string, count: number): string[] {
  const ramp = COLOR_RAMPS.find((r) => r.id === rampId) ?? DEFAULT_RAMP;
  const n = Math.max(1, Math.floor(count));
  if (n === 1) return [ramp.colors[Math.floor(ramp.colors.length / 2)]!];
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const idx = Math.round((i * (ramp.colors.length - 1)) / (n - 1));
    out.push(ramp.colors[idx] ?? DEFAULT_VECTOR_COLOR);
  }
  return out;
}

/** 一个属性值在对照表里的键：类型前缀 + 值，数字 1 与文字 "1" 不会混。 */
export function categoryKey(value: unknown): string {
  if (value === null || value === undefined) return 'null:';
  if (typeof value === 'number') return `number:${Object.is(value, -0) ? '0' : String(value)}`;
  if (typeof value === 'boolean') return `boolean:${String(value)}`;
  return `string:${String(value)}`;
}

/** 键的展示文本（去掉类型前缀；空值说人话）。 */
export function categoryLabel(key: string): string {
  if (key === 'null:') return '（空值）';
  const at = key.indexOf(':');
  return at >= 0 ? key.slice(at + 1) : key;
}

/** 从 GeoJSON 里取要素数组；形状不对就当空集，不抛错。 */
export function featuresOf(
  data: unknown,
): Array<{ properties?: Record<string, unknown>; geometry?: unknown }> {
  if (typeof data !== 'object' || data === null) return [];
  const features = (data as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];
  return features.filter(
    (f): f is { properties?: Record<string, unknown>; geometry?: unknown } =>
      typeof f === 'object' && f !== null,
  );
}

/** 图层里出现过的字段名（按首次出现顺序，最多扫 200 条要素）。 */
export function collectFields(data: unknown): string[] {
  const seen: string[] = [];
  const have = new Set<string>();
  for (const f of featuresOf(data).slice(0, 200)) {
    const props = f.properties;
    if (!props || typeof props !== 'object') continue;
    for (const key of Object.keys(props)) {
      if (have.has(key)) continue;
      have.add(key);
      seen.push(key);
    }
  }
  return seen;
}

/** 一个字段是不是数值型（有至少一个能转成数字的非空值）。 */
export function isNumericField(data: unknown, field: string): boolean {
  for (const f of featuresOf(data)) {
    const n = numberOf(f.properties?.[field]);
    if (n !== null) return true;
  }
  return false;
}

/** 把属性值转成有限数字；转不了返回 null（空串也算没有值）。 */
function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 一个字段里的全部数值（用于算分级断点）。 */
export function numericValues(data: unknown, field: string): number[] {
  const out: number[] = [];
  for (const f of featuresOf(data)) {
    const n = numberOf(f.properties?.[field]);
    if (n !== null) out.push(n);
  }
  return out;
}

export interface CategoryCount {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

/** 唯一值的类别统计（按出现次数降序；次数相同按名字排）。 */
export function distinctCategories(data: unknown, field: string, limit = 50): CategoryCount[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const f of featuresOf(data)) {
    const value = f.properties?.[field];
    const key = categoryKey(value);
    const prev = counts.get(key);
    if (prev) prev.count += 1;
    else counts.set(key, { label: categoryLabel(key), count: 1 });
  }
  return [...counts.entries()]
    .map(([key, v]) => ({ key, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))
    .slice(0, limit);
}

/**
 * 算分级断点。
 *
 * - equal：最小到最大等分；
 * - quantile：按排序后的分位取，重复的断点会合并（类别数可能少于要求）。
 *
 * 永远返回**升序且不重复**的断点；没有数值或全相同时返回空数组，
 * 由调用方退化成单色，而不是编一个假的断点。
 */
export function computeBreaks(
  values: readonly number[],
  classCount: number,
  method: GraduatedMethod,
): number[] {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const count = Math.max(2, Math.floor(classCount));
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  if (min === max) return [];

  const raw: number[] = [];
  if (method === 'quantile') {
    for (let i = 1; i < count; i += 1) {
      const idx = Math.floor((i / count) * (sorted.length - 1));
      raw.push(sorted[idx]!);
    }
  } else {
    for (let i = 1; i < count; i += 1) raw.push(min + ((max - min) * i) / count);
  }
  const out: number[] = [];
  for (const b of raw) {
    if (out.length === 0 || b > out[out.length - 1]!) out.push(b);
  }
  return out;
}

/** 分级区间的展示文本（图例用）。 */
export function classRangeLabel(index: number, breaks: readonly number[], digits = 2): string {
  const fmt = (n: number): string => {
    if (Math.abs(n) >= 10000) return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
    return n.toLocaleString('zh-CN', { maximumFractionDigits: digits });
  };
  if (breaks.length === 0) return '全部';
  if (index === 0) return `< ${fmt(breaks[0]!)}`;
  if (index >= breaks.length) return `≥ ${fmt(breaks[breaks.length - 1]!)}`;
  return `${fmt(breaks[index - 1]!)} – ${fmt(breaks[index]!)}`;
}

/** 唯一值：按类别出现顺序分配色带颜色；类别太多时只取前 N 个，其余走 fallback。 */
export function makeUniqueSymbology(
  data: unknown,
  field: string,
  rampId = DEFAULT_RAMP.id,
  maxCategories = 12,
): UniqueSymbology {
  const categories = distinctCategories(data, field, maxCategories);
  const palette = buildPalette(rampId, Math.max(1, categories.length));
  const colors: Record<string, string> = {};
  categories.forEach((c, i) => {
    colors[c.key] = palette[i] ?? DEFAULT_VECTOR_COLOR;
  });
  return { kind: 'unique', field, colors, fallback: DEFAULT_FALLBACK_COLOR };
}

/** 分级色彩：算断点 + 按类别数取色；没有数值时退化成空断点 + 单色。 */
export function makeGraduatedSymbology(
  data: unknown,
  field: string,
  method: GraduatedMethod,
  classCount: number,
  rampId = DEFAULT_RAMP.id,
): GraduatedSymbology {
  const breaks = computeBreaks(numericValues(data, field), classCount, method);
  const colors = breaks.length === 0 ? [DEFAULT_VECTOR_COLOR] : buildPalette(rampId, breaks.length + 1);
  return { kind: 'graduated', field, method, breaks, colors };
}

/**
 * 生成 MapLibre 的 paint 颜色值（字符串或表达式）。
 *
 * 唯一值用 `typeof + ":" + to-string` 做键，与 {@link categoryKey} 完全一致；
 * 这样数字 1 和文字 "1" 不会在图上被涂成同一个颜色。
 */
export function symbologyColorExpression(symbology: Symbology | undefined): unknown {
  if (!symbology || symbology.kind === 'single') {
    return symbology?.color ?? DEFAULT_VECTOR_COLOR;
  }
  if (symbology.kind === 'unique') {
    const args: unknown[] = [
      'match',
      [
        'concat',
        ['typeof', ['get', symbology.field]],
        ':',
        // 缺值/空值时 to-string 给空串兜底，避免整条表达式求值失败
        ['to-string', ['get', symbology.field], ''],
      ],
    ];
    for (const [key, color] of Object.entries(symbology.colors)) args.push(key, color);
    args.push(symbology.fallback || DEFAULT_FALLBACK_COLOR);
    return args;
  }
  if (symbology.breaks.length === 0 || symbology.colors.length <= 1) {
    return symbology.colors[0] ?? DEFAULT_VECTOR_COLOR;
  }
  const args: unknown[] = [
    'step',
    // 非数字/缺值按 0 处理：宁可归到最小档，也不让整层因为一个空值画不出来
    ['to-number', ['get', symbology.field], 0],
    symbology.colors[0],
  ];
  symbology.breaks.forEach((b, i) => {
    args.push(b, symbology.colors[i + 1] ?? symbology.colors[symbology.colors.length - 1]);
  });
  return args;
}

/** 图例条目：单色一条；唯一值一类一条；分级一个区间一条。 */
export function legendItemsForLayer(layerName: string, symbology: Symbology | undefined): SheetLegendItem[] {
  const base = layerName.replace(/\.[^./\\]+$/, '');
  if (!symbology || symbology.kind === 'single') {
    return [{ name: base, color: symbology?.color ?? DEFAULT_VECTOR_COLOR }];
  }
  if (symbology.kind === 'unique') {
    return Object.entries(symbology.colors).map(([key, color]) => ({
      name: `${base} · ${categoryLabel(key)}`,
      color,
    }));
  }
  return symbology.colors.map((color, i) => ({
    name: `${base} · ${classRangeLabel(i, symbology.breaks)}`,
    color,
  }));
}

/** 几何的标注锚点（经纬度）；拿不到就返回 null。 */
export function labelAnchor(geometry: unknown): [number, number] | null {
  if (typeof geometry !== 'object' || geometry === null) return null;
  const g = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  const type = g.type;
  if (type === 'Point') return pointOf(g.coordinates);
  if (type === 'MultiPoint') return pointOf(g.coordinates, true);
  if (type === 'LineString') return lineMidpoint(g.coordinates);
  if (type === 'MultiLineString') return lineMidpoint(g.coordinates, true);
  if (type === 'Polygon') return ringCentroid(g.coordinates, true);
  if (type === 'MultiPolygon') return ringCentroid(g.coordinates, true, true);
  if (type === 'GeometryCollection' && Array.isArray(g.geometries)) {
    for (const child of g.geometries) {
      const hit = labelAnchor(child);
      if (hit) return hit;
    }
  }
  return null;
}

/** 取一个坐标点；nested=true 表示外面还有一层数组。 */
function pointOf(coords: unknown, nested = false): [number, number] | null {
  const first = Array.isArray(coords) ? coords[0] : null;
  const c = nested && Array.isArray(first) ? first : coords;
  if (!Array.isArray(c) || c.length < 2) return null;
  const x = c[0];
  const y = c[1];
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

/** 线的中点：取中间那个顶点（比首尾平均更贴线）。 */
function lineMidpoint(coords: unknown, nested = false): [number, number] | null {
  const lines = nested && Array.isArray(coords) ? coords : [coords];
  for (const line of lines) {
    if (!Array.isArray(line) || line.length === 0) continue;
    const mid = line[Math.floor(line.length / 2)];
    if (Array.isArray(mid) && typeof mid[0] === 'number' && typeof mid[1] === 'number') {
      return [mid[0], mid[1]];
    }
  }
  return null;
}

/** 面的中心：外环顶点的平均值（够用；不是严格的重心）。 */
function ringCentroid(coords: unknown, nested = false, multi = false): [number, number] | null {
  let ring: unknown = coords;
  if (multi && Array.isArray(coords)) ring = coords[0];
  if (nested && Array.isArray(ring)) ring = ring[0];
  if (!Array.isArray(ring)) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of ring) {
    if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number') continue;
    sx += p[0];
    sy += p[1];
    n += 1;
  }
  return n > 0 ? [sx / n, sy / n] : null;
}

/** 标注文本；空值/空串不标。 */
export function labelText(properties: Record<string, unknown> | undefined, field: string): string | null {
  const value = properties?.[field];
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}
