/**
 * 出图模板的存取：模板存在项目目录的 `.cartouche/templates/<名字>.json`。
 *
 * 走的是引擎已有的 `/api/fs/*`，所以**服务端不用动**。
 * 但这套接口有个坑，必须在这里绕清楚：
 *
 *   - 读（read / stat / list）认 `root` 参数 —— 路径相对**项目根**；
 *   - 写（write / remove / rename）**不认** `root` —— 路径相对**引擎的工作区根**。
 *
 * 这不是猜的，是 server/src/app.ts 里 `resolveTarget(null, p)` 与
 * `storeFor(root, p)` 的区别。写错的后果是「模板存到了别的地方」，
 * 而用户回头找不到自己存的模板 —— 所以这里把两条路径分开算，
 * 写完还要**读回来核对一次**，确认它真的落在项目目录里。
 */
import {
  LayoutError,
  parseLayout,
  serializeLayout,
  type SheetLayout,
} from './types.ts';

/** 模板目录（相对项目根） */
export const TEMPLATE_DIR = '.cartouche/templates';

/** 模板文件后缀 */
const TEMPLATE_SUFFIX = '.json';

/** 引擎的默认地址（与 web/app/canvas/useEngine.ts 一致） */
const DEFAULT_BASE = 'http://127.0.0.1:8787';

/** 存取模板要用的接口（测试时替换掉 fetch 即可） */
export interface TemplateStoreOptions {
  /** 引擎地址 */
  readonly base?: string;
  /** 注入的 fetch（测试用） */
  readonly fetchImpl?: typeof fetch;
}

/** 一个模板文件的名字（不含 .json） */
export function templateFileName(name: string): string {
  return `${name}${TEMPLATE_SUFFIX}`;
}

/**
 * 模板名的合法性。
 *
 * 名字会直接进文件路径，所以必须挡住分隔符与通配符 ——
 * 这不是"文件名友好"的问题，是路径穿越。
 */
export function assertTemplateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new LayoutError('模板名不能为空。');
  if (trimmed === '.' || trimmed === '..') throw new LayoutError(`模板名「${trimmed}」不合法。`);
  if (/[\\/:*?"<>|]/.test(trimmed)) {
    throw new LayoutError(`模板名「${trimmed}」里不能有 \\ / : * ? " < > | 这些字符。`);
  }
  if (trimmed.length > 80) throw new LayoutError('模板名太长了（最多 80 个字符）。');
  return trimmed;
}

/* ── 路径工具（浏览器里没有 node:path，只能自己算） ─────── */

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Windows 的盘符路径不区分大小写；判据是开头有盘符 */
function fold(p: string): string {
  return /^[A-Za-z]:/.test(p) ? p.toLowerCase() : p;
}

/** candidate 是否落在 root 之下 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const r = toPosix(root).replace(/\/+$/, '');
  const c = toPosix(candidate).replace(/\/+$/, '');
  const rf = fold(r);
  const cf = fold(c);
  return cf === rf || cf.startsWith(`${rf}/`);
}

/**
 * candidate 相对 root 的路径（正斜杠）。
 * 不在 root 之下就返回 null —— 跨盘符当然也算不在。
 */
export function relativeToRoot(root: string, candidate: string): string | null {
  if (!isInsideRoot(root, candidate)) return null;
  const r = toPosix(root).replace(/\/+$/, '');
  const c = toPosix(candidate).replace(/\/+$/, '');
  if (fold(r) === fold(c)) return '';
  return c.slice(r.length + 1);
}

/* ── 引擎交互 ────────────────────────────────────────────── */

async function readErrorMessage(res: Response): Promise<string> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body?.message) detail = body.message;
  } catch {
    /* 错误体不是 JSON，保留状态码 */
  }
  return detail;
}

function requester(options: TemplateStoreOptions | undefined): {
  readonly base: string;
  readonly fetchImpl: typeof fetch;
} {
  return {
    base: options?.base ?? DEFAULT_BASE,
    fetchImpl: options?.fetchImpl ?? globalThis.fetch,
  };
}

/** 引擎工作区根（写操作按它定位路径，所以必须知道） */
let workspaceRootCache: string | null = null;

async function workspaceRoot(options: TemplateStoreOptions | undefined): Promise<string> {
  if (workspaceRootCache) return workspaceRootCache;
  const { base, fetchImpl } = requester(options);
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/health`);
  } catch (err) {
    throw new LayoutError(
      `无法连接引擎服务 ${base}（请确认已运行 npm run dev:server）：${(err as Error).message}`,
    );
  }
  if (!res.ok) throw new LayoutError(`读引擎信息失败：${await readErrorMessage(res)}`);
  const body = (await res.json()) as { workspaceRoot?: string };
  if (!body.workspaceRoot) {
    throw new LayoutError('引擎没有返回工作区根，无法确定模板该写到哪儿。');
  }
  workspaceRootCache = body.workspaceRoot;
  return workspaceRootCache;
}

/** 只在测试里用：清掉工作区根的缓存 */
export function resetWorkspaceRootCache(): void {
  workspaceRootCache = null;
}

/** 项目里模板文件的相对路径（相对项目根，给读接口用） */
function projectRelativePath(name: string): string {
  return `${TEMPLATE_DIR}/${templateFileName(name)}`;
}

/**
 * 模板文件相对**引擎工作区根**的路径（给写接口用）。
 *
 * 项目不在工作区根之下就抛错：写接口没有 root 参数，硬写会写到工作区根里
 * （存是"成功"了，可用户在自己的项目目录里找不到 —— 比直接报错更糟）。
 */
async function workspaceRelativePath(
  projectRoot: string,
  name: string,
  options: TemplateStoreOptions | undefined,
): Promise<string> {
  const root = await workspaceRoot(options);
  const rel = relativeToRoot(root, projectRoot);
  if (rel === null) {
    throw new LayoutError(
      `项目目录不在引擎的工作区根（${root}）之下，引擎的写接口目前只允许写工作区根以内的文件，` +
        `所以模板存不进去。需要引擎侧让 /api/fs/write 支持按 root 写入。`,
    );
  }
  const prefix = rel === '' ? '' : `${rel}/`;
  return `${prefix}${projectRelativePath(name)}`;
}

/* ── 对外的操作 ──────────────────────────────────────────── */

/** 列出项目里存着的模板（不含内置模板） */
export async function listTemplates(
  projectRoot: string,
  options?: TemplateStoreOptions,
): Promise<string[]> {
  const { base, fetchImpl } = requester(options);
  const params = new URLSearchParams({ path: TEMPLATE_DIR, root: projectRoot });
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/fs/list?${params.toString()}`);
  } catch (err) {
    throw new LayoutError(
      `无法连接引擎服务 ${base}（请确认已运行 npm run dev:server）：${(err as Error).message}`,
    );
  }
  // 模板目录还不存在是**正常状态**（还没存过模板），不是错误
  if (res.status === 404) return [];
  if (!res.ok) throw new LayoutError(`列出模板失败：${await readErrorMessage(res)}`);
  const body = (await res.json()) as { entries?: string[] };
  const entries = body.entries ?? [];
  return entries
    .filter((e) => e.endsWith(TEMPLATE_SUFFIX))
    .map((e) => e.slice(0, -TEMPLATE_SUFFIX.length))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

/** 读一个模板；读不出来要说清是"没有"还是"坏了" */
export async function loadTemplate(
  projectRoot: string,
  name: string,
  options?: TemplateStoreOptions,
): Promise<SheetLayout> {
  const { base, fetchImpl } = requester(options);
  const params = new URLSearchParams({ path: projectRelativePath(name), root: projectRoot });
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/fs/read?${params.toString()}`);
  } catch (err) {
    throw new LayoutError(
      `无法连接引擎服务 ${base}（请确认已运行 npm run dev:server）：${(err as Error).message}`,
    );
  }
  if (res.status === 404) {
    throw new LayoutError(`项目里没有名为「${name}」的出图模板。`);
  }
  if (!res.ok) throw new LayoutError(`读取模板「${name}」失败：${await readErrorMessage(res)}`);
  const text = await res.text();
  return parseLayout(text, `模板「${name}」`);
}

/**
 * 存一个模板。
 *
 * 写完**读回来核对**：写接口不认 root，路径算错的话文件会落到工作区根里，
 * 而接口照样回 200。不核对的话，模板就"存好了但找不到"。
 */
export async function saveTemplate(
  projectRoot: string,
  name: string,
  layout: SheetLayout,
  options?: TemplateStoreOptions,
): Promise<void> {
  const safeName = assertTemplateName(name);
  const { base, fetchImpl } = requester(options);
  const wsPath = await workspaceRelativePath(projectRoot, safeName, options);
  const body = `${wsPath}\0${serializeLayout(layout)}`;
  const bytes = new TextEncoder().encode(body);
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/fs/write`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    });
  } catch (err) {
    throw new LayoutError(
      `无法连接引擎服务 ${base}（请确认已运行 npm run dev:server）：${(err as Error).message}`,
    );
  }
  if (!res.ok) throw new LayoutError(`保存模板「${safeName}」失败：${await readErrorMessage(res)}`);

  // 核对：确认它真的落在项目目录里，且内容一致
  const back = await loadTemplate(projectRoot, safeName, options);
  if (JSON.stringify(back) !== JSON.stringify(layout)) {
    throw new LayoutError(
      `模板「${safeName}」写入后读回来的内容与写入的不一致，已按"存坏了"处理。` +
        `请检查项目目录 ${projectRoot} 下是否可写。`,
    );
  }
}

/** 删一个模板 */
export async function deleteTemplate(
  projectRoot: string,
  name: string,
  options?: TemplateStoreOptions,
): Promise<void> {
  const safeName = assertTemplateName(name);
  const { base, fetchImpl } = requester(options);
  const wsPath = await workspaceRelativePath(projectRoot, safeName, options);
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/fs/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new TextEncoder().encode(wsPath),
    });
  } catch (err) {
    throw new LayoutError(
      `无法连接引擎服务 ${base}（请确认已运行 npm run dev:server）：${(err as Error).message}`,
    );
  }
  if (!res.ok) throw new LayoutError(`删除模板「${safeName}」失败：${await readErrorMessage(res)}`);
}

/** 重命名一个模板 */
export async function renameTemplate(
  projectRoot: string,
  from: string,
  to: string,
  options?: TemplateStoreOptions,
): Promise<void> {
  const fromName = assertTemplateName(from);
  const toName = assertTemplateName(to);
  const { base, fetchImpl } = requester(options);
  const fromPath = await workspaceRelativePath(projectRoot, fromName, options);
  const toPath = await workspaceRelativePath(projectRoot, toName, options);
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/fs/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new TextEncoder().encode(`${fromPath}\n${toPath}`),
    });
  } catch (err) {
    throw new LayoutError(
      `无法连接引擎服务 ${base}（请确认已运行 npm run dev:server）：${(err as Error).message}`,
    );
  }
  if (!res.ok) throw new LayoutError(`重命名模板失败：${await readErrorMessage(res)}`);
}
