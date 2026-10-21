/**
 * 工作区抽象的公共类型。
 *
 * 为什么单独成文件：工作区模块被拆成 `types.ts` / `errors.ts` /
 * `local-folder-store.ts` / `roots.ts` 之后，彼此之间要互相引用。
 * 如果这些类型还留在 `index.ts` 里，子模块就得 `from './index.ts'` 引入，
 * 而 `index.ts` 又要 re-export 子模块 —— 直接形成**循环依赖**。
 * 把类型下沉到独立文件，依赖方向就是单向的（index → 子模块 → types/errors）。
 */

export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly isDirectory: boolean;
}

/** 引擎对文件系统能力的全部要求。刻意做得很窄，便于远程实现。 */
export interface WorkspaceAdapter {
  readonly kind: string;
  /** 相对路径 → 绝对路径 */
  resolve(path: string): string;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  list(dir: string): Promise<string[]>;
  stat(path: string): Promise<FileStat>;
  remove(path: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  /**
   * 重命名/覆盖式移动。目标已存在时必须整体替换（原子）。
   * 这是安全写回的关键能力：临时文件 → rename 覆盖目标。
   */
  rename(from: string, to: string): Promise<void>;
  /** 写入前的占用检查；被占用时抛 OccupiedError */
  assertWritable(path: string): Promise<void>;
}
