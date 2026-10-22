/**
 * CIM → MapLibre 渲染描述转换器。
 *
 * 用途：会话转移把 ArcGIS Pro 的 `.lyrx` / `.mapx`（CIM JSON）带进来之后，
 * 用户期望"迁过来的图看起来一样"。本模块把 CIM 的三类渲染器翻译成
 * MapLibre style 的图层片段：
 *
 *   · CIMSimpleRenderer      （简单渲染器）      → 单图层固定样式
 *   · CIMUniqueValueRenderer （唯一值渲染器）    → ["match", …] 表达式
 *   · CIMClassBreaksRenderer （分类断点渲染器）  → ["step", …] 表达式
 *
 * ## 边界（重要）
 *
 * 只做**这三类**渲染器。**不做完整符号化体系**——不做渐变色带、不做图层混合模式、
 * 不做点符号图案（.png 贴图）、不做复杂线型、3D 符号。
 * 判据（与 docs/06 §3.2 一致）：出图目标是"能交差"，不是"比 ArcGIS 好看"。
 *
 * 遇到不认识的渲染器**不报错、不静默丢弃**：返回一条 warning + 归入 unsupported，
 * 上层据此提示"这个符号没能完整还原"。
 *
 * ## 纯函数
 *
 * 输入一个 CIM JSON，输出 MapLibre 图层片段与警告列表，不碰文件、不碰网络。
 */

/** MapLibre 图层类型（本期只出这三种） */
export type MapLibreLayerType = 'circle' | 'line' | 'fill';

export interface MapLibrePaint {
  [property: string]: unknown;
}

export interface MapLibreLayer {
  id: string;
  type: MapLibreLayerType;
  source: string;
  'source-layer'?: string;
  filter?: unknown[];
  paint: MapLibrePaint;
  layout?: Record<string, unknown>;
}

export interface CimToStyleOptions {
  /** MapLibre 数据源名（style.json 里的 source id） */
  readonly source: string;
  /** 若数据来自矢量瓦片，指定 source-layer */
  readonly sourceLayer?: string;
  /** 图层 id 前缀，默认用 CIM 图层名 */
  readonly idPrefix?: string;
}

export interface CimToStyleResult {
  readonly layers: MapLibreLayer[];
  /** 可恢复但不完全等价的情况（缺色、字段缺失、降级到默认符号等） */
  readonly warnings: string[];
  /** 完全无法转换的渲染器类型 */
  readonly unsupported: string[];
}

/* ────────────────────────── CIM 读取工具 ────────────────────────── */

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** CIM 里图层集合可能是 `layers`，也可能是单层对象 */
function cimLayers(cim: Json): Json[] {
  const direct = asArray(cim.layers);
  if (direct.length > 0) return direct.map(asRecord).filter((r): r is Json => r !== null);
  const map = asRecord(cim.map);
  if (map) {
    const nested = asArray(map.layers);
    if (nested.length > 0) return nested.map(asRecord).filter((r): r is Json => r !== null);
  }
  const one = asRecord(cim);
  return one && (one.renderer || one.geometryType) ? [one] : [];
}

/* ────────────────────────── 颜色 ────────────────────────── */

/** CIMRGBColor.values = [r, g, b, a]，a 是 0~100 的不透明度 */
export function cimRgbToRgba(color: unknown): string | undefined {
  const rec = asRecord(color);
  if (!rec) return undefined;
  const values = asArray(rec.values);
  if (values.length < 3) return undefined;
  const nums = values.map((v) => Number(v));
  const [r, g, b] = nums;
  if (r === undefined || g === undefined || b === undefined) return undefined;
  if (![r, g, b].every((v) => Number.isFinite(v))) return undefined;
  // CIM 里 a 省略时视为 100（不透明）
  const alphaPercent = values.length >= 4 ? Number(values[3]) : 100;
  const alpha = Number.isFinite(alphaPercent) ? Math.min(1, Math.max(0, alphaPercent / 100)) : 1;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

/** CIMHSVColor.values = [h(0~360), s(0~100), v(0~100), a(0~100)] */
export function cimHsvToRgba(color: unknown): string | undefined {
  const rec = asRecord(color);
  if (!rec) return undefined;
  const values = asArray(rec.values);
  if (values.length < 3) return undefined;
  const h = Number(values[0]) / 360;
  const s = Math.min(1, Math.max(0, Number(values[1]) / 100));
  const v = Math.min(1, Math.max(0, Number(values[2]) / 100));
  if (![h, s, v].every((n) => Number.isFinite(n))) return undefined;

  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0: [r, g, b] = [v, t, p]; break;
    case 1: [r, g, b] = [q, v, p]; break;
    case 2: [r, g, b] = [p, v, t]; break;
    case 3: [r, g, b] = [p, q, v]; break;
    case 4: [r, g, b] = [t, p, v]; break;
    default: [r, g, b] = [v, p, q]; break;
  }
  const alphaPercent = values.length >= 4 ? Number(values[3]) : 100;
  const alpha = Number.isFinite(alphaPercent) ? Math.min(1, Math.max(0, alphaPercent / 100)) : 1;
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

/** 任何 CIM 颜色 → CSS rgba 字符串 */
export function cimColorToCss(color: unknown): string | undefined {
  const rec = asRecord(color);
  if (!rec) return undefined;
  const type = String(rec.type ?? '');
  if (type === 'CIMHSVColor') return cimHsvToRgba(rec);
  if (type === 'CIMRGBColor') return cimRgbToRgba(rec);
  // **只在完全没有 type 字段时**才按取值范围猜 RGB。
  // 已经声明了别的颜色类型（如 CIMCIELabColor）就不能硬套 RGB —— 那会得到错误颜色。
  if (rec.type !== undefined && rec.type !== null && rec.type !== '') return undefined;
  const values = asArray(rec.values);
  if (values.length >= 3 && values.length <= 4) {
    const nums = values.map(Number);
    if (nums.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) return cimRgbToRgba(rec);
  }
  return undefined;
}

/* ────────────────────────── 符号解析 ────────────────────────── */

/**
 * 符号可能是 `CIMSymbolReference`（指向文档里的符号表）。
 * 这里按 id / symbolName 回查；查不到就返回 null。
 */
function resolveSymbol(symbol: unknown, cim: Json): Json | null {
  const rec = asRecord(symbol);
  if (!rec) return null;
  const type = String(rec.type ?? '');
  if (type !== 'CIMSymbolReference') return rec;

  const wantedId = rec.symbolID !== undefined ? String(rec.symbolID) : undefined;
  const wantedName = rec.symbolName !== undefined ? String(rec.symbolName) : undefined;
  if (!wantedId && !wantedName) return null;

  for (const candidate of asArray(cim.symbols)) {
    const sym = asRecord(candidate);
    if (!sym) continue;
    const id = sym.symbolID !== undefined ? String(sym.symbolID) : undefined;
    const name = sym.symbolName !== undefined ? String(sym.symbolName) : undefined;
    if ((wantedId && id === wantedId) || (wantedName && name === wantedName)) return sym;
  }
  return null;
}

/** 几何类型 → MapLibre 图层类型 */
export function pickLayerType(geometryType: unknown, symbolType?: string): MapLibreLayerType {
  const g = String(geometryType ?? '').toLowerCase();
  if (g.includes('point')) return 'circle';
  if (g.includes('line') || g.includes('polyline')) return 'line';
  if (g.includes('polygon')) return 'fill';
  // 退而求其次：从符号类型反推
  const s = String(symbolType ?? '');
  if (s.includes('Marker')) return 'circle';
  if (s.includes('Line')) return 'line';
  if (s.includes('Fill')) return 'fill';
  return 'fill';
}

/** 符号类型 → MapLibre 图层类型（几何未知时用） */
function layerTypeFromSymbol(symbol: Json | null): MapLibreLayerType | undefined {
  if (!symbol) return undefined;
  const t = String(symbol.type ?? '');
  if (t.includes('Marker')) return 'circle';
  if (t.includes('Line')) return 'line';
  if (t.includes('Fill')) return 'fill';
  return undefined;
}

/** 线型 → MapLibre line-dasharray */
function dashArrayFor(style: unknown): number[] | undefined {
  const s = String(style ?? 'Solid');
  switch (s) {
    case 'Dash': return [4, 2];
    case 'Dot': return [1, 2];
    case 'DashDot': return [4, 2, 1, 2];
    default: return undefined;
  }
}

/* ────────────────────────── 三类渲染器 ────────────────────────── */

/** 简单渲染器 → 固定样式 */
function simpleRendererPaint(symbol: Json | null, type: MapLibreLayerType): MapLibrePaint {
  const paint: MapLibrePaint = {};
  const color = symbol ? cimColorToCss(symbol.color) : undefined;
  const outline = symbol ? cimColorToCss(symbol.outlineColor) : undefined;

  if (type === 'circle') {
    const size = Number(symbol?.size);
    paint['circle-color'] = color ?? 'rgba(0, 0, 0, 0)';
    paint['circle-radius'] = Number.isFinite(size) && size > 0 ? size : 5;
    paint['circle-stroke-color'] = outline ?? 'rgba(0, 0, 0, 0)';
    const ow = Number(symbol?.outlineWidth);
    paint['circle-stroke-width'] = Number.isFinite(ow) && ow > 0 ? ow : 0;
  } else if (type === 'line') {
    paint['line-color'] = color ?? 'rgba(0, 0, 0, 0.5)';
    const w = Number(symbol?.width);
    paint['line-width'] = Number.isFinite(w) && w > 0 ? w : 1;
    const dash = dashArrayFor(symbol?.style);
    if (dash) paint['line-dasharray'] = dash;
  } else {
    paint['fill-color'] = color ?? 'rgba(0, 0, 0, 0)';
    paint['fill-outline-color'] = outline ?? 'rgba(0, 0, 0, 0)';
    const ow = Number(symbol?.outlineWidth);
    paint['fill-outline-width'] = Number.isFinite(ow) && ow > 0 ? ow : 0;
  }
  return paint;
}

/** 唯一值渲染器 → ["match", …] */
function uniqueValuePaint(
  renderer: Json,
  type: MapLibreLayerType,
  cim: Json,
  warnings: string[],
): MapLibrePaint {
  const fields = asArray(renderer.fields).map((f) => String(f));
  const field = fields[0];
  if (!field) {
    warnings.push('唯一值渲染器缺少 fields，无法生成分类样式');
    return simpleRendererPaint(resolveSymbol(renderer.defaultSymbol, cim), type);
  }

  const colorProp = type === 'fill' ? 'fill-color' : 'line-color';
  const branches: unknown[] = [];
  let count = 0;

  for (const group of asArray(renderer.groups)) {
    const g = asRecord(group);
    if (!g) continue;
    for (const cls of asArray(g.classes)) {
      const c = asRecord(cls);
      if (!c) continue;
      const symbol = resolveSymbol(c.symbol, cim);
      const color = symbol ? cimColorToCss(symbol.color) : undefined;
      if (!color) {
        warnings.push(`唯一值分类「${String(c.label ?? '未命名')}」缺少可解析的颜色`);
        continue;
      }
      for (const uv of asArray(c.values)) {
        const v = asRecord(uv);
        if (!v) continue;
        const fieldValues = asArray(v.fieldValues).map((x) => String(x));
        for (const fv of fieldValues) {
          branches.push(fv, color);
          count++;
        }
      }
    }
  }

  const fallback = (() => {
    const s = resolveSymbol(renderer.defaultSymbol, cim);
    return (s ? cimColorToCss(s.color) : undefined) ?? 'rgba(128, 128, 128, 0.5)';
  })();

  if (count === 0) {
    warnings.push(`唯一值渲染器（字段 ${field}）没有可用分类，退回默认符号`);
    return simpleRendererPaint(resolveSymbol(renderer.defaultSymbol, cim), type);
  }

  // CIM 的唯一值字段值都是字符串；用 to-string 兜住数值型字段
  const paint: MapLibrePaint = {
    [colorProp]: ['match', ['to-string', ['get', field]], ...branches, fallback],
  };

  if (type === 'circle') {
    const s0 = resolveSymbol(renderer.defaultSymbol, cim);
    const size = Number(s0?.size);
    paint['circle-radius'] = Number.isFinite(size) && size > 0 ? size : 5;
    paint['circle-stroke-width'] = 0;
  } else if (type === 'line') {
    const s0 = resolveSymbol(renderer.defaultSymbol, cim);
    const w = Number(s0?.width);
    paint['line-width'] = Number.isFinite(w) && w > 0 ? w : 1;
  } else {
    paint['fill-outline-width'] = 0;
  }
  return paint;
}

/** 分类断点渲染器 → ["step", …] */
function classBreaksPaint(
  renderer: Json,
  type: MapLibreLayerType,
  cim: Json,
  warnings: string[],
): MapLibrePaint {
  const field = renderer.field !== undefined ? String(renderer.field) : '';
  if (!field) {
    warnings.push('分类断点渲染器缺少 field，无法生成分级样式');
    return simpleRendererPaint(resolveSymbol(renderer.defaultSymbol, cim), type);
  }

  const breaks = asArray(renderer.breaks)
    .map(asRecord)
    .filter((r): r is Json => r !== null)
    .map((b) => ({
      upper: Number(b.upperBound),
      label: String(b.label ?? ''),
      color: (() => {
        const s = resolveSymbol(b.symbol, cim);
        return s ? cimColorToCss(s.color) : undefined;
      })(),
    }))
    .filter((b) => Number.isFinite(b.upper))
    .sort((a, b) => a.upper - b.upper);

  if (breaks.length === 0) {
    warnings.push(`分类断点渲染器（字段 ${field}）没有可用断点，退回默认符号`);
    return simpleRendererPaint(resolveSymbol(renderer.defaultSymbol, cim), type);
  }

  const missing = breaks.filter((b) => !b.color);
  for (const b of missing) {
    warnings.push(`分类断点「${b.label}」缺少可解析的颜色`);
  }

  const usable = breaks.filter((b) => b.color);
  if (usable.length === 0) {
    return simpleRendererPaint(resolveSymbol(renderer.defaultSymbol, cim), type);
  }

  const colorProp = type === 'fill' ? 'fill-color' : 'line-color';
  // MapLibre step 语义：["step", x, base, stop1, out1, stop2, out2]
  //   x < stop1 → base；stop1 ≤ x < stop2 → out1；x ≥ stop2 → out2
  // CIM 断点语义：upperBound=100 的那一档覆盖 ≤100 的值。
  // 因此 stop 必须取**上一档的 upperBound**，颜色取**当前档**——
  // 写反了会整体错一档（≤100 落在上一档的区间里）。
  const expr: unknown[] = ['step', ['get', field], usable[0]!.color];
  for (let i = 1; i < usable.length; i++) {
    expr.push(usable[i - 1]!.upper, usable[i]!.color);
  }

  const paint: MapLibrePaint = { [colorProp]: expr };
  if (type === 'circle') {
    const s0 = resolveSymbol(renderer.defaultSymbol, cim);
    const size = Number(s0?.size);
    paint['circle-radius'] = Number.isFinite(size) && size > 0 ? size : 5;
    paint['circle-stroke-width'] = 0;
  } else if (type === 'line') {
    const s0 = resolveSymbol(renderer.defaultSymbol, cim);
    const w = Number(s0?.width);
    paint['line-width'] = Number.isFinite(w) && w > 0 ? w : 1;
  } else {
    paint['fill-outline-width'] = 0;
  }
  return paint;
}

/* ────────────────────────── 入口 ────────────────────────── */

/** 把图层名转成可用的 MapLibre layer id */
export function toLayerId(name: string, index: number): string {
  const cleaned = name
    .trim()
    .replace(/[^\w\u4e00-\u9fff-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : `layer_${index}`;
}

/**
 * 把一个 CIM 文档（`.lyrx` / `.mapx` / CIMMapDocument）转成 MapLibre 图层片段。
 *
 * @param cim        CIM JSON（未知结构不会抛异常，只产出 warning）
 * @param options    数据源名等
 */
export function cimToMapLibreLayers(cim: unknown, options: CimToStyleOptions): CimToStyleResult {
  const layers: MapLibreLayer[] = [];
  const warnings: string[] = [];
  const unsupported: string[] = [];

  const root = asRecord(cim);
  if (!root) {
    return { layers, warnings: ['CIM 文档不是对象，无法解析'], unsupported };
  }

  const sourceLayers = cimLayers(root);
  if (sourceLayers.length === 0) {
    warnings.push('CIM 文档里没有找到图层');
    return { layers, warnings, unsupported };
  }

  sourceLayers.forEach((layer, index) => {
    const name = String(layer.name ?? `图层 ${index + 1}`);
    const renderer = asRecord(layer.renderer);
    if (!renderer) {
      warnings.push(`图层「${name}」没有渲染器，已跳过`);
      return;
    }
    const rendererType = String(renderer.type ?? '');

    const rawSymbol = renderer.symbol;
    const symbol = resolveSymbol(rawSymbol, root);
    const symbolType = symbol ? String(symbol.type ?? '') : undefined;
    const type = pickLayerType(layer.geometryType, symbolType ?? rendererTypeFromRenderer(rendererType));

    let paint: MapLibrePaint;
    switch (rendererType) {
      case 'CIMSimpleRenderer':
        paint = simpleRendererPaint(symbol, type);
        break;
      case 'CIMUniqueValueRenderer':
        paint = uniqueValuePaint(renderer, type, root, warnings);
        break;
      case 'CIMClassBreaksRenderer':
        paint = classBreaksPaint(renderer, type, root, warnings);
        break;
      default:
        unsupported.push(rendererType || '(未声明类型)');
        warnings.push(`图层「${name}」的渲染器类型 ${rendererType || '(未声明)'} 暂不支持，已跳过`);
        return;
    }

    const id = `${options.idPrefix ? `${options.idPrefix}-` : ''}${toLayerId(name, index)}`;
    const outLayer: MapLibreLayer = {
      id,
      type,
      source: options.source,
      paint,
    };
    if (options.sourceLayer) outLayer['source-layer'] = options.sourceLayer;
    layers.push(outLayer);
  });

  return { layers, warnings, unsupported };
}

function rendererTypeFromRenderer(rendererType: string): string | undefined {
  if (rendererType.includes('UniqueValue')) return 'CIMSimpleMarkerSymbol';
  if (rendererType.includes('ClassBreaks')) return 'CIMSimpleFillSymbol';
  return undefined;
}

/**
 * 给出人类可读的渲染器说明（供兼容性自检报告引用）。
 */
export function describeRenderer(cim: unknown): string {
  const root = asRecord(cim);
  if (!root) return '未知（CIM 解析失败）';
  const kinds: string[] = [];
  for (const layer of cimLayers(root)) {
    const r = asRecord(layer.renderer);
    if (!r) continue;
    const t = String(r.type ?? '未知');
    // 唯一值渲染器的分类字段在 fields 数组里，其余在 field 字段上
    const field = r.field !== undefined
      ? String(r.field)
      : asArray(r.fields).length > 0
        ? asArray(r.fields).map((f) => String(f)).join('/')
        : '';
    kinds.push(`${t}${field ? `（字段 ${field}）` : ''}`);
  }
  return kinds.length > 0 ? kinds.join('、') : '未找到渲染器';
}
