/**
 * 出图模板的存取：模板存在项目目录的 `.cartouche/templates/<名字>.json`。
 *
 * 走的是引擎已有的 `/api/fs/*`。读写**同一套口径**：路径相对**项目根**，
 * 请求带 `?root=<项目根>`，由服务器按那个根定位、并把住工作区边界。
 *
 * 之前写接口只认引擎的工作区根、不认 root，于是模板会「存好了」却落在
 * 用户项目目录之外的地方 —— 存是成功了，回头找不到，比直接报错更糟。
 * 现在读写口径统一；写完仍然**读回来核对一次**，确认它真的落在项目目录里。
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

/** Windows 的盘符路径不区分大小写；判据是开头有盘符 */
function fold(p: string): string {
  return /^[A-Za-z]:/.test(p) ? p.toLowerCase() : p;
}

/**
 * candidate 相对 root 的路径（正斜杠）。
 * 不在 root 之下就返回 null —— 跨盘符当然也算不在。
 */

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

/**
 * 写接口的 URL：带上 root，路径相对项目根。
 *
 * 口径与读接口一致（`/api/fs/read?root=…`），所以模板落在哪儿由服务器按
 * root 定位，边界也由它把关 —— 客户端不猜引擎的工作区根长什么样。
 */
function writeUrl(base: string, endpoint: string, projectRoot: string): string {
  return `${base}${endpoint}?root=${encodeURIComponent(projectRoot)}`;
}

/** 项目里模板文件的相对路径（相对项目根，读写都用它） */
function projectRelativePath(name: string): string {
  return `${TEMPLATE_DIR}/${templateFileName(name)}`;
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
 * 写完**读回来核对**：路径算错、或者目录不可写，接口都可能回 200，
 * 但模板没落在项目目录里。不核对的话，模板就「存好了但找不到」。
 */
export async function saveTemplate(
  projectRoot: string,
  name: string,
  layout: SheetLayout,
  options?: TemplateStoreOptions,
): Promise<void> {
  const safeName = assertTemplateName(name);
  const { base, fetchImpl } = requester(options);
  const body = `${projectRelativePath(safeName)}\0${serializeLayout(layout)}`;
  const bytes = new TextEncoder().encode(body);
  let res: Response;
  try {
    res = await fetchImpl(writeUrl(base, '/api/fs/write', projectRoot), {
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
  let res: Response;
  try {
    res = await fetchImpl(writeUrl(base, '/api/fs/remove', projectRoot), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new TextEncoder().encode(projectRelativePath(safeName)),
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
  const fromPath = projectRelativePath(fromName);
  const toPath = projectRelativePath(toName);
  let res: Response;
  try {
    res = await fetchImpl(writeUrl(base, '/api/fs/rename', projectRoot), {
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
