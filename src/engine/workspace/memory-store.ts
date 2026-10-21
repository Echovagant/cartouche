/**
 * 内存工作区：测试用，也用于"预演"（不落盘的方案试算）。
 */
import { NotFoundError, OccupiedError, lockCandidates, sha256, type FileStat, type WorkspaceAdapter } from './index.ts';

export class MemoryStore implements WorkspaceAdapter {
  readonly kind = 'memory';
  readonly #files = new Map<string, Uint8Array>();

  resolve(path: string): string {
    return path;
  }

  async exists(path: string): Promise<boolean> {
    return this.#files.has(path);
  }

  async read(path: string): Promise<Uint8Array> {
    const v = this.#files.get(path);
    if (!v) throw new NotFoundError(path);
    return v;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.#files.set(path, new Uint8Array(data));
  }

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

  async stat(path: string): Promise<FileStat> {
    const v = this.#files.get(path);
    if (!v) throw new NotFoundError(path);
    return { size: v.length, mtimeMs: 0, isDirectory: false };
  }

  async remove(path: string): Promise<void> {
    this.#files.delete(path);
  }

  async copy(from: string, to: string): Promise<void> {
    const v = this.#files.get(from);
    if (!v) throw new NotFoundError(from);
    this.#files.set(to, new Uint8Array(v));
  }

  async rename(from: string, to: string): Promise<void> {
    const v = this.#files.get(from);
    if (!v) throw new NotFoundError(from);
    this.#files.set(to, v);
    this.#files.delete(from);
  }

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
