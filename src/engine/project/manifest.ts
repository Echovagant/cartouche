/**
 * 项目清单（`.cartouche/project.json`）的格式、解析与校验。
 *
 * 设计取舍（2026-10-21 定稿）：
 *   - **纯 JSON、人可读**：用户能自己打开看，出错能自己救；不用数据库（"数据不出本机"）
 *   - **源数据用相对路径引用**：整个项目文件夹可直接压缩发出去 —— "交差"= 压缩一个文件夹
 *   - **带 version**：以后加字段不破旧项目
 */
import { isAbsolute } from 'node:path';

export const PROJECT_MANIFEST_VERSION = 1;

export type ProjectLayerKind = 'raster' | 'vector';

export interface ProjectLayer {
  readonly id: string;
  readonly kind: ProjectLayerKind;
  readonly path: string;
  readonly visible: boolean;
  readonly opacity: number;
}

export interface ProjectSheet {
  readonly title: string;
  readonly operator: string;
  readonly page: 'A4-landscape' | 'A4-portrait';
  readonly dpi: number;
}

export interface ProjectView {
  readonly center: readonly [number, number];
  readonly zoom: number;
}

export interface ProjectOperation {
  readonly at: string;
  readonly op: string;
  readonly target: string;
  readonly ok: boolean;
  readonly impact?: Readonly<Record<string, unknown>>;
}

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

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

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

export function serializeManifest(m: ProjectManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(m, null, 2)}\n`);
}

export function parseManifest(bytes: Uint8Array): ProjectManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ManifestError('项目清单不是合法 JSON，无法读取。请检查 .cartouche/project.json 是否被手工改坏。');
  }
  return validateManifest(raw);
}

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
    out.push({ id, kind, path, visible, opacity });
  }
  return out;
}

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
