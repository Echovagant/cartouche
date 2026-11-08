/**
 * 项目的读写：清单、留痕、产出物。
 *
 * 落盘形态（源数据原地，工具的痕迹全在隐藏目录里）：
 *   <项目根>/.cartouche/project.json      清单
 *   <项目根>/.cartouche/history.jsonl     留痕（一行一次操作）
 *   <项目根>/.cartouche/outputs/          产出的 PDF / 报告
 *
 * 边界：项目根必须落在**某个已登记根之下**，由 `RootRegistry.resolve()` 保证；
 * 落在某个根之内时，`.cartouche/` 就落在项目根下 —— 这正是要的。
 */
import { join } from 'node:path';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { RootRegistry } from '../workspace/roots.ts';
import { parseManifest, serializeManifest, type ProjectManifest } from './manifest.ts';

/**
 * 工具痕迹目录名（.cartouche）。
 *
 * 源数据原地不动，工具的痕迹全在这个隐藏目录里——
 * 用户把项目文件夹压缩发出去，收件人看到的还是干净的数据。
 */
export const PROJECT_DIR_NAME = '.cartouche';

const MANIFEST_FILE_NAME = 'project.json';
const HISTORY_FILE_NAME = 'history.jsonl';
const OUTPUTS_DIR_NAME = 'outputs';

/** 产出物的一条清单信息：文件名、大小、修改时间。 */
export interface ProjectOutput {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * 留痕里的一次操作。
 *
 * 一行一条（history.jsonl），追加写入：中途崩了也不会把之前的留痕弄坏。
 */
export interface ProjectHistoryEntry {
  readonly at: string;
  readonly op: string;
  readonly target: string;
  readonly ok: boolean;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly impact?: Readonly<Record<string, unknown>>;
  /**
   * 一句话结论：这次到底改了什么。
   *
   * 为什么要有它：像元口径只对栅格型 op 有意义。矢量型 op（改属性、加字段…）
   * 留痕里若只有 "op / target / ok"，交差时说不清"改了几条"——
   * 引擎那边其实有一句现成的人话结论（如"给 12 条要素加上了字段「面积」"），
   * 顺手记下来，交差时直接能用。
   */
  readonly summary?: string;
  readonly error?: string;
}

/**
 * 项目目录的读写入口。
 *
 * 所有路径都先过 RootRegistry.resolve()：项目根必须落在**某个已登记根之下**，
 * 否则直接抛错。源数据可以放在任意位置，但项目的写入范围受登记根约束。
 */
export class ProjectStore {
  readonly #roots: RootRegistry;

  constructor(roots: RootRegistry) {
    this.#roots = roots;
  }

  /** 把项目根绝对路径解析到「已登记根 + 相对路径」；不在任何根下则抛错 */
  locate(projectRoot: string): { rootId: string; relative: string } {
    const r = this.#roots.resolve(projectRoot);
    return { rootId: r.rootId, relative: r.relative };
  }

/**
 * 读清单。
 *
 * 文件不存在返回 null（这是"还没建过项目"，不是错误）；
 * 存在但坏了就抛错，且**不动原文件**。
 */
  async readManifest(projectRoot: string): Promise<ProjectManifest | null> {
    const file = this.#manifestPath(projectRoot);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(file);
    } catch (err) {
      if (isErrno(err) && err.code === 'ENOENT') return null;
      throw err;
    }
    // 清单坏了就抛 ManifestError，**不动原文件** —— 用户的源数据不该被工具改坏。
    return parseManifest(bytes);
  }

/** 写清单（先建目录再落盘）。 */
  async writeManifest(projectRoot: string, m: ProjectManifest): Promise<void> {
    const dir = this.#dirOf(projectRoot);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, MANIFEST_FILE_NAME), serializeManifest(m));
  }

/**
 * 追加一条留痕。
 *
 * 用追加模式（flag: 'a'）：一次操作一行，
 * 中途崩了也不会把之前的留痕弄坏。
 */
  async appendHistory(projectRoot: string, e: ProjectHistoryEntry): Promise<void> {
    const dir = this.#dirOf(projectRoot);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, HISTORY_FILE_NAME), `${JSON.stringify(e)}\n`, { flag: 'a' });
  }

/**
 * 读全部留痕。
 *
 * 坏掉的一行跳过，不拖垮整个读取：留痕是给人查的，
 * 少一行总比整个打不开强。
 */
  async readHistory(projectRoot: string): Promise<ProjectHistoryEntry[]> {
    const file = join(this.#dirOf(projectRoot), HISTORY_FILE_NAME);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if (isErrno(err) && err.code === 'ENOENT') return [];
      throw err;
    }
    const out: ProjectHistoryEntry[] = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(t);
      } catch {
        // 留痕里坏掉的一行不能拖垮整个读取：跳过即可
        continue;
      }
      const entry = toHistoryEntry(parsed);
      if (entry) out.push(entry);
    }
    return out;
  }

/** 列出产出物，按修改时间倒序（最近的排前面）。 */
  async listOutputs(projectRoot: string): Promise<ProjectOutput[]> {
    const dir = join(this.#dirOf(projectRoot), OUTPUTS_DIR_NAME);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if (isErrno(err) && err.code === 'ENOENT') return [];
      throw err;
    }
    const out: ProjectOutput[] = [];
    for (const name of names) {
      const s = await statOrNull(join(dir, name));
      // 只列文件：目录、刚好被删掉的文件都不算产出物
      if (!s || !s.isFile()) continue;
      out.push({ name, size: s.size, mtimeMs: s.mtimeMs });
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

/**
 * 写一个产出物。
 *
 * 文件名必须是单个文件名（safeOutputName 把关），
 * 否则 `../../evil.txt` 就能写到项目外面去。
 * 返回的相对路径一律用 `/`。
 */
  async writeOutput(projectRoot: string, name: string, data: Uint8Array): Promise<string> {
    const safe = safeOutputName(name);
    const dir = join(this.#dirOf(projectRoot), OUTPUTS_DIR_NAME);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, safe), data);
    // 相对路径一律用 `/` —— 清单里的路径就是给别的机器看的，不能带 Windows 反斜杠
    return `${PROJECT_DIR_NAME}/${OUTPUTS_DIR_NAME}/${safe}`;
  }

  #dirOf(projectRoot: string): string {
    const r = this.#roots.resolve(projectRoot);
    return join(r.absolute, PROJECT_DIR_NAME);
  }

  #manifestPath(projectRoot: string): string {
    return join(this.#dirOf(projectRoot), MANIFEST_FILE_NAME);
  }
}

/**
 * 产出物文件名必须是**单个文件名**。
 *
 * 直接把用户给的 name 拼进路径，`../../evil.txt` 就能写到项目外面去——
 * 这是路径穿越，不是"文件名不友好"。所以这里明确拒绝，而不是悄悄截断
 * （悄悄截断会让用户以为存成功了，实际存到了别处）。
 */
function safeOutputName(name: string): string {
  if (!name.trim()) {
    throw new Error('产出物文件名不能为空：请给这个文件起个名字，例如「出图.pdf」。');
  }
  if (name === '.' || name === '..' || /[\\/]/.test(name) || name.includes(':')) {
    throw new Error(
      `产出物文件名只能是单个文件名，不能带路径：${name}。请只写「出图.pdf」这样的名字。`,
    );
  }
  if (name.includes('\0')) {
    throw new Error('产出物文件名里含有无效字符。请改成一个正常文件名，例如「出图.pdf」。');
  }
  return name;
}

/**
 * 把一行留痕解析成条目；不是条目就返回 null（那一行跳过，不拖垮整个读取）。
 */
function toHistoryEntry(raw: unknown): ProjectHistoryEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const at = typeof o.at === 'string' ? o.at : '';
  const op = typeof o.op === 'string' ? o.op : '';
  if (at === '' || op === '') return null;
  const ok = o.ok === undefined ? true : o.ok === true;
  const params = isPlainObject(o.params) ? o.params : undefined;
  const impact = isPlainObject(o.impact) ? o.impact : undefined;
  const summary = typeof o.summary === 'string' ? o.summary : undefined;
  const error = typeof o.error === 'string' ? o.error : undefined;
  return {
    at,
    op,
    target: typeof o.target === 'string' ? o.target : '',
    ok,
    ...(params ? { params } : {}),
    ...(impact ? { impact } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/** 是不是一个普通对象（不是数组、不是 null）。 */
function isPlainObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 是不是带 code 的系统错误（ENOENT 之类）。 */
function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error;
}

/** 取文件信息；文件刚好被删掉就返回 null，而不是让整个列举失败。 */
async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (err) {
    if (isErrno(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}
