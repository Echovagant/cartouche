/**
 * 已登记的工作区根。
 *
 * 为什么需要（2026-10-21 设计自查发现）：
 *   引擎原本只有一个固定的 WORKSPACE_ROOT（仓库里的 workspace/），路径越界一律 400。
 *   但「项目 = 一次交差任务、源数据原地」的形态意味着用户的数据在
 *   `D:\任务\2026改图\` 这类**工作区之外**的位置——不允许多根就落不了地。
 *
 * 规则（保持向后兼容）：
 *   - **相对路径** → 一律相对**默认根**，与今天的行为完全一致；
 *   - **绝对路径** → 与各已登记根做**最长前缀匹配**，命中即转成该根下的相对路径；
 *     一个都不命中 → PathEscapeError（越界），语义与今天的 400 一致。
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { LocalFolderStore } from './local-folder-store.ts';
import { PathEscapeError } from './errors.ts';
import type { WorkspaceAdapter } from './types.ts';

export interface WorkspaceRoot {
  /** 形如 'r1' 'r2'；内置默认根固定是 'r0' */
  readonly id: string;
  /** 绝对路径，已 resolve */
  readonly path: string;
  /** 展示名（默认取目录名） */
  readonly label: string;
  /** 默认根为 true */
  readonly builtin: boolean;
}

export interface ResolvedPath {
  readonly rootId: string;
  /**
   * 相对该根的路径。解析到**根本身**时为空串（上层也接受 '.'）。
   */
  readonly relative: string;
  /** 绝对路径 */
  readonly absolute: string;
}

export class RootRegistry {
  #roots: WorkspaceRoot[] = [];
  #seq = 0;
  readonly #defaultRoot: string;

  constructor(defaultRoot: string) {
    this.#defaultRoot = resolve(defaultRoot);
    this.#roots.push({
      id: 'r0',
      path: this.#defaultRoot,
      label: defaultLabel(this.#defaultRoot),
      builtin: true,
    });
  }

  list(): readonly WorkspaceRoot[] {
    return [...this.#roots];
  }

  add(path: string, label?: string): WorkspaceRoot {
    const abs = resolve(path);
    // 同一个目录重复登记不该拿到两个 id——Windows 上大小写不同也是同一个目录。
    const existing = this.#roots.find((r) => foldCase(r.path) === foldCase(abs));
    if (existing) return existing;
    this.#seq += 1;
    const root: WorkspaceRoot = {
      id: `r${this.#seq}`,
      path: abs,
      label: label && label.trim() ? label.trim() : defaultLabel(abs),
      builtin: false,
    };
    this.#roots.push(root);
    return root;
  }

  remove(id: string): void {
    this.#roots = this.#roots.filter((r) => r.id !== id || r.builtin);
  }

  resolve(input: string): ResolvedPath {
    if (!isAbsolute(input)) {
      const root = this.#roots[0];
      if (!root) throw new PathEscapeError(input);
      const abs = resolve(root.path, input);
      if (!isInside(root.path, abs)) throw new PathEscapeError(input);
      return { rootId: root.id, relative: relative(root.path, abs), absolute: abs };
    }
    const abs = resolve(input);
    // 最长前缀匹配：嵌套的根要赢
    const hit = [...this.#roots]
      .sort((a, b) => b.path.length - a.path.length)
      .find((r) => isInside(r.path, abs));
    if (!hit) throw new PathEscapeError(input);
    return { rootId: hit.id, relative: relative(hit.path, abs), absolute: abs };
  }

  storeFor(rootId: string): WorkspaceAdapter {
    const root = this.#roots.find((r) => r.id === rootId);
    if (!root) throw new PathEscapeError(rootId);
    return new LocalFolderStore(root.path);
  }
}

function isInside(rootPath: string, candidate: string): boolean {
  const root = foldCase(rootPath);
  const cand = foldCase(candidate);
  if (cand === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return cand.startsWith(prefix);
}

/**
 * Windows 上文件系统路径不区分大小写。
 * 不折叠大小写的话，用户输入 `d:\任务` 而登记的是 `D:\任务` 会被误判成"越界"——
 * 这是 Windows 上真实会踩的坑，不是理论问题。
 */
function foldCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function defaultLabel(path: string): string {
  const parts = path.split(sep).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
