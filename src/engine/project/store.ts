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

export const PROJECT_DIR_NAME = '.cartouche';

const MANIFEST_FILE_NAME = 'project.json';
const HISTORY_FILE_NAME = 'history.jsonl';
const OUTPUTS_DIR_NAME = 'outputs';

export interface ProjectOutput {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ProjectHistoryEntry {
  readonly at: string;
  readonly op: string;
  readonly target: string;
  readonly ok: boolean;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly impact?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

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

  async writeManifest(projectRoot: string, m: ProjectManifest): Promise<void> {
    const dir = this.#dirOf(projectRoot);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, MANIFEST_FILE_NAME), serializeManifest(m));
  }

  async appendHistory(projectRoot: string, e: ProjectHistoryEntry): Promise<void> {
    const dir = this.#dirOf(projectRoot);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, HISTORY_FILE_NAME), `${JSON.stringify(e)}\n`, { flag: 'a' });
  }

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
  const error = typeof o.error === 'string' ? o.error : undefined;
  return {
    at,
    op,
    target: typeof o.target === 'string' ? o.target : '',
    ok,
    ...(params ? { params } : {}),
    ...(impact ? { impact } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function isPlainObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

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
