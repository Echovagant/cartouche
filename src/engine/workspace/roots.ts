/**
 * 已登记的工作区根。
 *
 * 为什么需要（2026-10-21 设计自查发现）：
 *   引擎原本只有一个固定的 WORKSPACE_ROOT（仓库里的 workspace/），路径越界一律 400。
 *   但「项目 = 一次交差任务、源数据原地」的形态意味着用户的数据在
 *   工作区之外的目录（用户的图件**原地不动**）——不允许多根就落不了地。
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

/**
 * 一个已登记的工作区根。
 *
 * 用户的数据通常在工作区之外（图件原地的那些目录），
 * 登记一个根等于"允许引擎动这个目录"，登记之外的一律越界。
 */
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

/**
 * 解析结果：这条路径落在哪个根下、根下的相对路径是什么。
 *
 * relative 为空串表示解析到了根本身。
 */
export interface ResolvedPath {
  readonly rootId: string;
  /**
   * 相对该根的路径。解析到**根本身**时为空串（上层也接受 '.'）。
   */
  readonly relative: string;
  /** 绝对路径 */
  readonly absolute: string;
}

/**
 * 工作区根登记表。
 *
 * 规则：
 *  - 相对路径 → 一律相对**默认根**（与早期单一根的行为一致）；
 *  - 绝对路径 → 与各根做**最长前缀匹配**，命中即转成该根下的相对路径；
 *    一个都不命中 → PathEscapeError。
 */
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

/** 列出已登记的根。 */
  list(): readonly WorkspaceRoot[] {
    return [...this.#roots];
  }

/**
 * 登记一个根。
 *
 * 同一个目录重复登记直接返回原来那条：Windows 上大小写不同也是同一个目录，
 * 不去重就会拿到两个 id 指向同一处。
 */
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

/**
 * 移除一个根。
 *
 * 内置默认根不可移除（builtin 的那一条会被保下来）——
 * 默认根是所有相对路径的落点，删了相对路径就没地方解析了。
 */
  remove(id: string): void {
    this.#roots = this.#roots.filter((r) => r.id !== id || r.builtin);
  }

/**
 * 把输入路径解析成「根 + 相对路径」。
 *
 * 相对路径一律落默认根；绝对路径按最长前缀匹配找根，
 * 嵌套的根要赢（路径长的那个更具体）。
 * 一个根都没命中就抛 PathEscapeError。
 */
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

/**
 * 拿到某个根对应的存储适配器。
 *
 * 每个根一个独立的 LocalFolderStore：写操作必须落在根内，
 * 适配器本身就是那道闸门。
 */
  storeFor(rootId: string): WorkspaceAdapter {
    const root = this.#roots.find((r) => r.id === rootId);
    if (!root) throw new PathEscapeError(rootId);
    return new LocalFolderStore(root.path);
  }
}

/**
 * 候选路径是否落在根之下（含根本身）。
 *
 * 比较前折叠大小写：Windows 上文件系统不区分大小写。
 */
function isInside(rootPath: string, candidate: string): boolean {
  const root = foldCase(rootPath);
  const cand = foldCase(candidate);
  if (cand === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return cand.startsWith(prefix);
}

/**
 * Windows 上文件系统路径不区分大小写。
 * 不折叠大小写的话，登记与撤销时传入的路径大小写不一致，会被误判成"越界"——
 * 这是 Windows 上真实会踩的坑，不是理论问题。
 */
function foldCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** 根的默认展示名：取目录名。 */
function defaultLabel(path: string): string {
  const parts = path.split(sep).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
