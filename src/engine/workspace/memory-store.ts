/**
 * 内存工作区：测试用，也用于"预演"（不落盘的方案试算）。
 */
import { NotFoundError, OccupiedError, lockCandidates, sha256, type FileStat, type WorkspaceAdapter } from './index.ts';

/**
 * 内存工作区：文件全放在一张 Map 里。
 *
 * 两个用途：单元测试（不碰磁盘）与"预演"（不落盘的方案试算）。
 */
export class MemoryStore implements WorkspaceAdapter {
  readonly kind = 'memory';
  readonly #files = new Map<string, Uint8Array>();

/** 路径原样返回：内存工作区没有根目录的概念。 */
  resolve(path: string): string {
    return path;
  }

/** 有没有这个文件。 */
  async exists(path: string): Promise<boolean> {
    return this.#files.has(path);
  }

/** 读内容；没有就抛 NotFoundError。 */
  async read(path: string): Promise<Uint8Array> {
    const v = this.#files.get(path);
    if (!v) throw new NotFoundError(path);
    return v;
  }

/** 写内容（存一份拷贝，调用方之后改不动我们的数据）。 */
  async write(path: string, data: Uint8Array): Promise<void> {
    this.#files.set(path, new Uint8Array(data));
  }

/** 列出目录下的直接子项（文件与目录都算，只取路径第一段）。 */
  async list(dir: string): Promise<string[]> {
    const prefix = dir ? `${dir}/` : '';
    const names = new Set<string>();
    for (const key of this.#files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      names.add(rest.split('/')[0]!);
    }
    return [...names];
  }

/** 取文件信息：大小已知，修改时间恒为 0（内存里没有时间概念）。 */
  async stat(path: string): Promise<FileStat> {
    const v = this.#files.get(path);
    if (!v) throw new NotFoundError(path);
    return { size: v.length, mtimeMs: 0, isDirectory: false };
  }

/** 删除；文件不在也不报错（与本地实现的 force 语义一致）。 */
  async remove(path: string): Promise<void> {
    this.#files.delete(path);
  }

/** 复制：源不存在就抛 NotFoundError。 */
  async copy(from: string, to: string): Promise<void> {
    const v = this.#files.get(from);
    if (!v) throw new NotFoundError(from);
    this.#files.set(to, new Uint8Array(v));
  }

/** 重命名：读出来写过去再删源；源不存在就抛 NotFoundError。 */
  async rename(from: string, to: string): Promise<void> {
    const v = this.#files.get(from);
    if (!v) throw new NotFoundError(from);
    this.#files.set(to, v);
    this.#files.delete(from);
  }

/**
 * 占用检测：看同名锁文件在不在。
 *
 * 锁文件按**去掉扩展名**命名（a.shp 的锁是 a.lock），与另两个实现保持一致。
 */
  async assertWritable(path: string): Promise<void> {
    for (const candidate of lockCandidates(path)) {
      if (this.#files.has(candidate)) {
        throw new OccupiedError(path, new Error(`检测到锁文件 ${candidate}`));
      }
    }
  }

  /** 便于测试与预演：直接拿到内容哈希 */
  hash(path: string): string {
    const v = this.#files.get(path);
    if (!v) throw new NotFoundError(path);
    return sha256(v);
  }
}
