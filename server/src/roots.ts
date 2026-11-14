/**
 * 已登记根的**持久化**。
 *
 * - 根列表存 `%LOCALAPPDATA%\cartouche\roots.json`（配置目录，**不在工作区里**——
 *   工作区会被用户拷走，配置不该跟着走）
 * - 默认根 `<repo>/workspace` 由 app.ts 传进来、内置，**不写进文件**
 *
 * 刻意**不在这里 new RootRegistry**：实例由 app.ts 建（它手里有 WORKSPACE_ROOT），
 * 这里只提供「把实例灌上已登记根」与「把新根登记并落盘」两个函数。
 * 反过来（roots.ts new、app.ts import）会形成循环依赖：
 * app.ts 要用 roots，roots.ts 又要从 app.ts 拿 WORKSPACE_ROOT。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import type { RootRegistry, WorkspaceRoot } from '@cartouche/engine';

const configDir =
  process.env.CARTOUCHE_CONFIG_DIR ??
  join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '.', 'cartouche');
const rootsFile = join(configDir, 'roots.json');

interface RegisteredRoot {
  readonly path: string;
  readonly label?: string;
}

/** 读回已登记的根；文件不存在或坏了都当「没登记过」，不能因此启动失败 */
function loadRegistered(): RegisteredRoot[] {
  try {
    if (!existsSync(rootsFile)) return [];
    const raw = JSON.parse(readFileSync(rootsFile, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: RegisteredRoot[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as { path?: unknown; label?: unknown };
      if (typeof o.path !== 'string' || o.path.trim() === '') continue;
      const label = typeof o.label === 'string' && o.label.trim() !== '' ? o.label : undefined;
      out.push(label === undefined ? { path: o.path } : { path: o.path, label });
    }
    return out;
  } catch {
    return [];
  }
}

/** 落盘；写不了只警告，不让服务起不来（配置写不了不该挡住用户干活） */
function saveRegistered(list: RegisteredRoot[]): void {
  try {
    mkdirSync(dirname(rootsFile), { recursive: true });
    writeFileSync(rootsFile, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[engine] 根列表写入失败：${(err as Error).message}`);
  }
}

/** 启动时把上次登记过的根灌回注册表（根可能已被删除或无权限，跳过即可） */
export function loadRegisteredRoots(roots: RootRegistry): void {
  for (const r of loadRegistered()) {
    if (!isExistingDir(r.path)) continue;
    try {
      roots.add(r.path, r.label);
    } catch {
      // 根可能已被删除或不可访问，跳过即可
    }
  }
}

/**
 * 登记一个新根并落盘。
 *
 * 登记前**必须**确认它是个真实存在的目录 —— 否则会登记出一个永远打不开的根，
 * 用户之后只会看到「打不开」这类没法自查的报错。
 */
export function registerRoot(roots: RootRegistry, path: string, label?: string): WorkspaceRoot {
  const abs = resolve(path);
  let isDir: boolean;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    throw new Error(
      `这个文件夹不存在：${abs}。请确认路径拼写是否正确，或先在资源管理器里把它建出来。`,
    );
  }
  if (!isDir) {
    throw new Error(`这里不是一个文件夹：${abs}。工作区根必须是一个目录，请改选它里面的某个文件夹。`);
  }
  const root = roots.add(abs, label);
  if (!root.builtin) {
    const list = loadRegistered().filter((r) => r.path !== abs);
    list.push(label && label.trim() ? { path: abs, label: label.trim() } : { path: abs });
    saveRegistered(list);
  }
  return root;
}

/**
 * 撤销一个根的登记，并把它从落盘文件里去掉。
 *
 * 为什么需要「撤销」：登记是**有后果**的——登记之后，那棵目录树整棵树
 * 可被读/写/删。原来的接口只有「登记」没有「撤销」，用户登记错了目录
 * 就只能去手改 `%LOCALAPPDATA%\cartouche\roots.json`，承诺是单向的。
 * 补上撤销，「只碰你登记过的目录」才是个闭环。
 *
 * 三条拒绝的情况都要说清楚，不能静默成功：
 *  - 没登记过 → 说清是哪个路径没登记过；
 *  - 内置默认根 → 说清为什么不能撤（它是所有相对路径的落点，撤了相对路径就没地方解析）；
 *  - 路径写法不同但其实是同一个目录（Windows 大小写）→ 按同一个目录处理。
 */
export function unregisterRoot(roots: RootRegistry, path: string): WorkspaceRoot {
  const abs = resolve(path);
  const root = roots.list().find((r) => foldCase(r.path) === foldCase(abs));
  if (!root) {
    throw new Error(`这个文件夹没有登记过：${abs}`);
  }
  if (root.builtin) {
    throw new Error(
      '默认工作区不能撤销：所有相对路径都落在它下面，撤了相对路径就没有地方解析了。',
    );
  }
  roots.remove(root.id);
  // 落盘的那份也要去掉，否则下次启动又被读回来 —— 撤销必须是真的撤销。
  const list = loadRegistered().filter((r) => foldCase(resolve(r.path)) !== foldCase(abs));
  saveRegistered(list);
  return root;
}

/**
 * Windows 上文件系统路径不区分大小写。
 *
 * 不折叠大小写的话，登记与撤销时传入的路径大小写不一致
 * 会被当成两个目录，撤销不掉 —— 这是 Windows 上真实会踩的坑。
 */
function foldCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
