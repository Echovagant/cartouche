/**
 * 项目清单（`.cartouche/project.json`）的格式、解析与校验。
 *
 * 设计取舍（2026-10-21 定稿）：
 *   - **纯 JSON、人可读**：用户能自己打开看，出错能自己救；不用数据库（"图件不出本机"）
 *   - **源数据用相对路径引用**：整个项目文件夹可直接压缩发出去 —— "交差"= 压缩一个文件夹
 *   - **带 version**：以后加字段不破旧项目
 */
import { isAbsolute } from 'node:path';

/** 清单格式版本号：加字段时递增，旧项目仍按旧版解析。 */
export const PROJECT_MANIFEST_VERSION = 2;

/** 图层类型：栅格或矢量。 */
export type ProjectLayerKind = 'raster' | 'vector';

/** 符号化渲染器（最小切片：单色 / 唯一值 / 分级色彩）。 */
export type LayerSymbology =
  | { readonly kind: 'single'; readonly color: string }
  | {
      readonly kind: 'unique';
      readonly field: string;
      readonly colors: Readonly<Record<string, string>>;
      readonly fallback: string;
    }
  | {
      readonly kind: 'graduated';
      readonly field: string;
      readonly method: 'equal' | 'quantile';
      readonly breaks: readonly number[];
      readonly colors: readonly string[];
    };

/** 标注：一个字段、固定字号/颜色/描边。 */
export interface LayerLabels {
  readonly field: string;
  readonly size: number;
  readonly color: string;
  readonly halo: string;
}

/** 图层的显示样式（与 web/app/canvas/symbology.ts 的类型一一对应）。 */
export interface LayerStyle {
  readonly symbology?: LayerSymbology;
  readonly labels?: LayerLabels;
}

/**
 * 项目里的一个图层。
 *
 * path 是**相对路径**：项目文件夹要能直接压缩发出去，
 * 绝对路径换个机器就失效了。
 */
export interface ProjectLayer {
  readonly id: string;
  readonly kind: ProjectLayerKind;
  readonly path: string;
  readonly visible: boolean;
  readonly opacity: number;
  /** 视口分块模式（大文件）：恢复时直接按视口加载 */
  readonly chunked?: boolean;
  /** 按需矢量瓦片模式（超大文件）：恢复时直接走 MVT，不做整层转换 */
  readonly tiled?: boolean;
  /** MVT 瓦片内的图层名（MapLibre 的 source-layer）；tiled 时才有 */
  readonly tileLayer?: string;
  /** 符号化与标注；没配就没有这个字段 */
  readonly style?: LayerStyle;
}

/** 出图设置：图签标题、制图人、纸张方向与 dpi。 */
export interface ProjectSheet {
  readonly title: string;
  readonly operator: string;
  readonly page: 'A4-landscape' | 'A4-portrait';
  readonly dpi: number;
}

/** 画布视野（中心经纬度与缩放级别），打开项目时恢复上次的位置。 */
export interface ProjectView {
  readonly center: readonly [number, number];
  readonly zoom: number;
}

/**
 * 清单里记下的一次操作。
 *
 * 与留痕（history.jsonl）的分工：清单里只放摘要，
 * 留痕里才有参数与影响面——清单要能被人直接打开看懂。
 */
export interface ProjectOperation {
  readonly at: string;
  readonly op: string;
  readonly target: string;
  readonly ok: boolean;
  readonly impact?: Readonly<Record<string, unknown>>;
}

/**
 * 项目清单（.cartouche/project.json）的结构。
 *
 * 刻意是**纯 JSON、人可读**：用户能自己打开看，出错能自己救；
 * 不用数据库，源数据也不出本机。
 */
export interface ProjectManifest {
  readonly version: number;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sheet: ProjectSheet;
  readonly layers: readonly ProjectLayer[];
  readonly view?: ProjectView;
  readonly operations: readonly ProjectOperation[];
}

/**
 * 清单格式不对。
 *
 * 单独一个错误类型：上层要据此告诉用户"project.json 被改坏了"，
 * 而不是笼统的"读取失败"。
 */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/**
 * 新建一份清单。
 *
 * 默认值按最常用的出图场景给：A4 横版、150 dpi、标题用产品名。
 * createdAt 与 updatedAt 相同（此刻两者本就一致）。
 */
export function newManifest(name: string, now = new Date().toISOString()): ProjectManifest {
  return {
    version: PROJECT_MANIFEST_VERSION,
    name,
    createdAt: now,
    updatedAt: now,
    sheet: { title: '图签 Cartouche 出图', operator: '', page: 'A4-landscape', dpi: 150 },
    layers: [],
    operations: [],
  };
}

/**
 * 序列化成落盘字节。
 *
 * 缩进 2 格 + 末尾换行：这是给人看的文件，缩进让 diff 与手工排查都方便。
 */
export function serializeManifest(m: ProjectManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(m, null, 2)}\n`);
}

/**
 * 解析并校验清单。
 *
 * 解析失败一律抛 ManifestError，且**不改原文件**——
 * 用户的源数据不该被工具改坏。
 */
export function parseManifest(bytes: Uint8Array): ProjectManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ManifestError('项目清单不是合法 JSON，无法读取。请检查 .cartouche/project.json 是否被手工改坏。');
  }
  return validateManifest(raw);
}

/**
 * 校验清单内容并返回规范化后的结构。
 *
 * 每条错误都写清"哪个字段、现在写的是什么、该怎么改"——
 * 清单是人手写的（也可能被手工改坏），报错要说人话。
 */
function validateManifest(raw: unknown): ProjectManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new ManifestError('项目清单格式不对：顶层应是一个对象。请检查 .cartouche/project.json 的内容。');
  }
  const o = raw as Record<string, unknown>;

  const version = o.version;
  if (typeof version !== 'number') {
    throw new ManifestError(
      '项目清单缺少 version 字段，无法确认格式版本。请检查 .cartouche/project.json 是否被手工改坏，或用新版图签重新创建项目。',
    );
  }
  if (version > PROJECT_MANIFEST_VERSION) {
    throw new ManifestError(
      `项目由更高版本的图签创建（清单 version=${version}，本机支持到 ${PROJECT_MANIFEST_VERSION}）。请升级后再打开。`,
    );
  }

  const name = o.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ManifestError('项目清单缺少项目名。请检查 .cartouche/project.json 的 name 字段，或重新创建项目。');
  }

  const sheet = validateSheet(o.sheet);
  const layers = validateLayers(o.layers);
  const operations = validateOperations(o.operations);
  const view = o.view === undefined ? undefined : validateView(o.view);

  return {
    version,
    name,
    createdAt: str(o.createdAt),
    updatedAt: str(o.updatedAt),
    sheet,
    layers,
    ...(view ? { view } : {}),
    operations,
  };
}

/** 取字符串；不是字符串就当空串。 */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 把出错的值写进提示语。
 *
 * 不能直接用 `String(value)`：对象会变成 `[object Object]`、空值会变成 `undefined`，
 * 用户看到这种占位符根本不知道该改哪里。这里把对象/数组转成 JSON 片段，
 * 空值说成「空」。
 */
function describeValue(v: unknown): string {
  if (v === undefined) return '空';
  if (v === null) return 'null';
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      if (s === undefined) return '空';
      return s.length > 60 ? `${s.slice(0, 60)}…` : s;
    } catch {
      return '（无法显示的值）';
    }
  }
  return String(v);
}

/**
 * 从固定白名单里挑一个值：缺省用 fallback，不在白名单里就报错。
 * 不用 `as` 断言收窄，避免 `unknown` 的类型收窄在 TS 里踩坑。
 */
function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
  if (value === undefined) return fallback;
  for (const a of allowed) {
    if (value === a) return a;
  }
  throw new ManifestError(
    `${label}只能是 ${allowed.join(' / ')}，现在写的是「${describeValue(value)}」。改这一处后重新打开项目即可。`,
  );
}

/** 相对路径安全检查：非空、不是绝对路径、不含 `..` 段。 */
function isSafeRelative(p: string): boolean {
  if (p === '') return false;
  if (isAbsolute(p)) return false;
  if (/^[a-zA-Z]:/.test(p)) return false; // Windows 盘符：POSIX 下 isAbsolute 认不出
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  const parts = p.split(/[\\/]+/);
  return !parts.includes('..');
}

/** 读一个非空字符串（用于颜色、字段名）。 */
function nonEmptyString(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ManifestError(`${label}必须是非空字符串，现在写的是「${describeValue(v)}」。`);
  }
  return v.trim();
}

/**
 * 校验图层的样式（符号化 + 标注）。
 *
 * 样式是可选字段：没配就没有。配了但写坏了就**明确报错**，
 * 而不是悄悄丢掉 —— 用户以为样式存上了、打开却没了，比报错更难查。
 */
function validateLayerStyle(raw: unknown, layerId: string): LayerStyle | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError(
      `图层 ${layerId} 的 style 必须是一个对象。检查 .cartouche/project.json 的 layers[].style。`,
    );
  }
  const o = raw as Record<string, unknown>;
  const style: { symbology?: LayerSymbology; labels?: LayerLabels } = {};

  const sym = o.symbology;
  if (sym !== undefined && sym !== null) {
    if (typeof sym !== 'object' || Array.isArray(sym)) {
      throw new ManifestError(`图层 ${layerId} 的 style.symbology 必须是一个对象。`);
    }
    const s = sym as Record<string, unknown>;
    const kind = pick(
      s.kind,
      ['single', 'unique', 'graduated'] as const,
      'single',
      `图层 ${layerId} 的符号化类型`,
    );
    if (kind === 'single') {
      style.symbology = {
        kind,
        color: nonEmptyString(s.color, `图层 ${layerId} 的单色颜色`),
      };
    } else if (kind === 'unique') {
      const field = nonEmptyString(s.field, `图层 ${layerId} 唯一值的字段名`);
      const colorsRaw = s.colors;
      if (typeof colorsRaw !== 'object' || colorsRaw === null || Array.isArray(colorsRaw)) {
        throw new ManifestError(
          `图层 ${layerId} 的唯一值颜色表（style.symbology.colors）必须是一个对象。`,
        );
      }
      const colors: Record<string, string> = {};
      for (const [key, value] of Object.entries(colorsRaw)) {
        colors[key] = nonEmptyString(value, `图层 ${layerId} 唯一值「${key}」的颜色`);
      }
      if (Object.keys(colors).length === 0) {
        throw new ManifestError(`图层 ${layerId} 的唯一值颜色表是空的。`);
      }
      style.symbology = {
        kind,
        field,
        colors,
        fallback: nonEmptyString(s.fallback, `图层 ${layerId} 唯一值的兜底颜色`),
      };
    } else {
      const field = nonEmptyString(s.field, `图层 ${layerId} 分级色彩的字段名`);
      const method = pick(
        s.method,
        ['equal', 'quantile'] as const,
        'equal',
        `图层 ${layerId} 的分级方法`,
      );
      if (!Array.isArray(s.breaks)) {
        throw new ManifestError(`图层 ${layerId} 的分级断点（style.symbology.breaks）必须是数组。`);
      }
      const breaks = s.breaks.map((b, i) => {
        if (typeof b !== 'number' || !Number.isFinite(b)) {
          throw new ManifestError(`图层 ${layerId} 的第 ${i + 1} 个分级断点不是有限数字。`);
        }
        return b;
      });
      for (let i = 1; i < breaks.length; i += 1) {
        if (breaks[i]! <= breaks[i - 1]!) {
          throw new ManifestError(`图层 ${layerId} 的分级断点必须严格递增。`);
        }
      }
      if (!Array.isArray(s.colors)) {
        throw new ManifestError(`图层 ${layerId} 的分级颜色（style.symbology.colors）必须是数组。`);
      }
      const colors = s.colors.map((c, i) =>
        nonEmptyString(c, `图层 ${layerId} 的第 ${i + 1} 个分级颜色`),
      );
      if (colors.length !== breaks.length + 1) {
        throw new ManifestError(
          `图层 ${layerId} 的分级颜色数（${colors.length}）必须等于断点数 + 1（${breaks.length + 1}）。`,
        );
      }
      style.symbology = { kind, field, method, breaks, colors };
    }
  }

  const labels = o.labels;
  if (labels !== undefined && labels !== null) {
    if (typeof labels !== 'object' || Array.isArray(labels)) {
      throw new ManifestError(`图层 ${layerId} 的 style.labels 必须是一个对象。`);
    }
    const l = labels as Record<string, unknown>;
    const field = nonEmptyString(l.field, `图层 ${layerId} 的标注字段名`);
    const size = l.size;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 6 || size > 72) {
      throw new ManifestError(
        `图层 ${layerId} 的标注字号必须是 6~72 的数字，现在写的是「${describeValue(size)}」。`,
      );
    }
    style.labels = {
      field,
      size,
      color: nonEmptyString(l.color, `图层 ${layerId} 的标注颜色`),
      halo: nonEmptyString(l.halo, `图层 ${layerId} 的标注描边色`),
    };
  }

  return style.symbology || style.labels ? style : undefined;
}

/** 校验出图设置（页幅、dpi、标题、制图人）。 */
function validateSheet(raw: unknown): ProjectSheet {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const page = pick(
    o.page,
    ['A4-landscape', 'A4-portrait'] as const,
    'A4-landscape',
    '项目清单里的页幅',
  );
  const dpi = o.dpi === undefined ? 150 : o.dpi;
  if (typeof dpi !== 'number' || !Number.isInteger(dpi) || dpi < 1 || dpi > 1200) {
    throw new ManifestError(
      `项目清单里的 dpi 必须是 1~1200 的整数，现在写的是「${describeValue(dpi)}」。请改成 1~1200 之间的整数。`,
    );
  }
  return { title: str(o.title), operator: str(o.operator), page, dpi };
}

/** 校验图层清单，逐层挑出 id / 类型 / 路径 / 可见性 / 不透明度。 */
function validateLayers(raw: unknown): ProjectLayer[] {
  if (!Array.isArray(raw)) {
    throw new ManifestError(
      '项目清单里的 layers 必须是一个数组。检查 .cartouche/project.json 的 layers 字段。',
    );
  }
  const out: ProjectLayer[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      throw new ManifestError(
        '项目清单里有一个图层不是对象，无法读取。请检查 .cartouche/project.json 的 layers 字段。',
      );
    }
    const o = item as Record<string, unknown>;
    const id = str(o.id).trim();
    if (id === '') {
      throw new ManifestError(
        '项目清单里有一个图层缺少 id，无法读取。请检查 .cartouche/project.json，给每个图层补上 id。',
      );
    }
    const kind = pick(o.kind, ['raster', 'vector'] as const, 'raster', `图层 ${id} 的 kind`);
    const path = str(o.path);
    if (!isSafeRelative(path)) {
      throw new ManifestError(
        `图层 ${id} 的 path 必须是相对路径、且不能含 .. 段，现在写的是「${describeValue(o.path)}」。` +
          '项目清单只记相对路径，源数据不用搬家。',
      );
    }
    const visible = o.visible === undefined ? true : o.visible;
    if (typeof visible !== 'boolean') {
      throw new ManifestError(
        `图层 ${id} 的 visible 必须是 true 或 false，现在写的是「${describeValue(visible)}」。请改成 true 或 false。`,
      );
    }
    const opacity = o.opacity === undefined ? 1 : o.opacity;
    if (typeof opacity !== 'number' || Number.isNaN(opacity) || opacity < 0 || opacity > 1) {
      throw new ManifestError(
        `图层 ${id} 的透明度（opacity）必须是 0~1 之间的数字，现在写的是「${describeValue(opacity)}」。请改成 0~1 之间的数字。`,
      );
    }
    const chunked = o.chunked;
    if (chunked !== undefined && typeof chunked !== 'boolean') {
      throw new ManifestError(
        `图层 ${id} 的 chunked 必须是 true 或 false，现在写的是「${describeValue(chunked)}」。`,
      );
    }
    const tiled = o.tiled;
    if (tiled !== undefined && typeof tiled !== 'boolean') {
      throw new ManifestError(
        `图层 ${id} 的 tiled 必须是 true 或 false，现在写的是「${describeValue(tiled)}」。`,
      );
    }
    const tileLayerRaw = o.tileLayer;
    if (tileLayerRaw !== undefined && (typeof tileLayerRaw !== 'string' || tileLayerRaw.trim() === '')) {
      throw new ManifestError(
        `图层 ${id} 的 tileLayer 必须是非空字符串，现在写的是「${describeValue(tileLayerRaw)}」。`,
      );
    }
    const style = validateLayerStyle(o.style, id);
    out.push({
      id,
      kind,
      path,
      visible,
      opacity,
      ...(chunked ? { chunked: true } : {}),
      ...(tiled ? { tiled: true } : {}),
      ...(tiled && typeof tileLayerRaw === 'string' ? { tileLayer: tileLayerRaw } : {}),
      ...(style ? { style } : {}),
    });
  }
  return out;
}

/** 校验操作记录清单。 */
function validateOperations(raw: unknown): ProjectOperation[] {
  if (!Array.isArray(raw)) {
    throw new ManifestError(
      '项目清单里的 operations 必须是一个数组。检查 .cartouche/project.json 的 operations 字段。',
    );
  }
  const out: ProjectOperation[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      throw new ManifestError(
        '项目清单里有一条操作记录不是对象，无法读取。请检查 .cartouche/project.json 的 operations 字段。',
      );
    }
    const o = item as Record<string, unknown>;
    const at = str(o.at);
    const op = str(o.op);
    const target = str(o.target);
    if (at === '' || op === '') {
      throw new ManifestError(
        '项目清单里有一条操作记录缺少 at（时间）或 op（操作名）。请补齐后重新打开项目。',
      );
    }
    const ok = o.ok === undefined ? true : o.ok;
    if (typeof ok !== 'boolean') {
      throw new ManifestError(
        `操作记录 ${at}/${op} 的 ok 必须是 true 或 false，现在写的是「${describeValue(ok)}」。请改成 true 或 false。`,
      );
    }
    const impact = o.impact;
    if (impact !== undefined && (typeof impact !== 'object' || impact === null || Array.isArray(impact))) {
      throw new ManifestError(
        `操作记录 ${at}/${op} 的 impact 必须是一个对象，现在写的是「${describeValue(impact)}」。请改成对象，或删掉这个字段。`,
      );
    }
    out.push({
      at,
      op,
      target,
      ok,
      ...(impact !== undefined ? { impact: impact as Readonly<Record<string, unknown>> } : {}),
    });
  }
  return out;
}

/** 校验画布视野（中心经纬度 + 缩放级别）。 */
function validateView(raw: unknown): ProjectView {
  if (typeof raw !== 'object' || raw === null) {
    throw new ManifestError(
      '项目清单里的 view 必须是一个对象（中心点与缩放）。请检查 .cartouche/project.json 的 view 字段。',
    );
  }
  const o = raw as Record<string, unknown>;
  const center = o.center;
  if (!Array.isArray(center)) {
    throw new ManifestError(
      `项目清单里的 view.center 必须是两个数字（经度、纬度），现在写的是「${describeValue(center)}」。请改成 [经度, 纬度]。`,
    );
  }
  const lon = center[0];
  const lat = center[1];
  if (
    typeof lon !== 'number' ||
    typeof lat !== 'number' ||
    Number.isNaN(lon) ||
    Number.isNaN(lat)
  ) {
    throw new ManifestError(
      '项目清单里的 view.center 必须是两个数字（经度、纬度）。请改成 [经度, 纬度]。',
    );
  }
  const zoom = o.zoom;
  if (typeof zoom !== 'number' || Number.isNaN(zoom)) {
    throw new ManifestError(
      `项目清单里的 view.zoom 必须是数字，现在写的是「${describeValue(zoom)}」。请改成数字。`,
    );
  }
  return { center: [lon, lat], zoom };
}
