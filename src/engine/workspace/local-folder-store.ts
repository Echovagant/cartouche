/**
 * 本地文件夹实现：单机版的主用实现。
 *
 * 从 `index.ts` 拆出来的原因：工作区模块要拆成若干独立文件，
 * 而 `roots.ts` 需要直接引用 `LocalFolderStore`——若它还住在 `index.ts` 里，
 * `roots.ts` 就得 `from './index.ts'` 引入，形成循环依赖。
 */
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { NotFoundError, OccupiedError, PathEscapeError, existsFromErrorCode } from './errors.ts';
import type { FileStat, WorkspaceAdapter } from './types.ts';

/** 用 fs.access 探测存在性，错误码语义统一由 {@link existsFromErrorCode} 决定。 */
async function existsViaAccess(fullPath: string): Promise<boolean> {
  try {
    await fs.access(fullPath);
    return true;
  } catch (err) {
    const verdict = existsFromErrorCode((err as NodeJS.ErrnoException).code);
    if (verdict === 'missing') return false;
    if (verdict === 'exists') return true;
    throw err;
  }
}

export class LocalFolderStore implements WorkspaceAdapter {
  readonly kind = 'local-folder';
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  resolve(path: string): string {
    if (isAbsolute(path)) return normalize(path);
    const full = resolve(join(this.root, path));
    // 防止 ../ 逃出根目录
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new PathEscapeError(path);
    }
    return full;
  }

  /**
   * 目标是否存在。
   *
   * **只有"确实不存在"才返回 false。**
   * EACCES / EPERM / EBUSY 表示"文件在，但当前拿不到访问权"——Windows 上杀软实时扫描、
   * 索引器、其它 GIS 软件短暂独占时非常常见。此时必须当作**存在**返回：
   * 否则上层会误判"目标不存在"而跳过备份，最后做出**无备份的覆盖**，
   * 直接破坏"写回必须可回退"的底线。
   *
   * 其它未预期的错误不吞掉，直接抛出——那属于 bug，不该被伪装成"不存在"。
   */
  async exists(path: string): Promise<boolean> {
    return existsViaAccess(this.resolve(path));
  }

  async read(path: string): Promise<Uint8Array> {
    try {
      return await fs.readFile(this.resolve(path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(path);
      throw err;
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const full = this.resolve(path);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  async list(dir: string): Promise<string[]> {
    try {
      return await fs.readdir(this.resolve(dir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async stat(path: string): Promise<FileStat> {
    try {
      const s = await fs.stat(this.resolve(path));
      return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(path);
      throw err;
    }
  }

  async remove(path: string): Promise<void> {
    await fs.rm(this.resolve(path), { force: true, recursive: true });
  }

  async copy(from: string, to: string): Promise<void> {
    const dest = this.resolve(to);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.copyFile(this.resolve(from), dest);
  }

  /**
   * 覆盖式重命名。Node 的 fs.rename 在 Windows 上走 MoveFileEx +
   * MOVEFILE_REPLACE_EXISTING，因此是**原子替换**——目标已存在也能整体换掉。
   */
  async rename(from: string, to: string): Promise<void> {
    const dest = this.resolve(to);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.rename(this.resolve(from), dest);
  }

  /**
   * 占用检测。
   *
   * Windows 上 Node 打开文件默认带 FILE_SHARE_DELETE，
   * **无法**通过"再开一次"判断占用——所以这里用两条线索：
   *  1. 锁文件启发式：ArcGIS 打开数据时会在旁边留锁标记
   *     （shapefile 旁会有 <name>.lock；FileGDB 在 .gdb 目录内留 .lock）
   *  2. 以"独占更新"方式打开，失败即判定被占用
   *
   * 真正的兜底在写回层：rename 覆盖失败会被翻译成 OccupiedError。
   */
  async assertWritable(path: string): Promise<void> {
    const full = this.resolve(path);

    // 1) 锁文件启发式
    const locks = await this.detectLockSidecars(path);
    if (locks.length > 0) {
      throw new OccupiedError(
        path,
        new Error(`检测到锁文件：${locks.join(', ')}（可能是 ArcGIS 正打开该数据）`),
      );
    }

    // 2) 尝试以更新方式打开
    try {
      const handle = await fs.open(full, 'r+');
      await handle.close();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return; // 不存在 → 视为可写
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        throw new OccupiedError(path, err);
      }
      throw err;
    }
  }

  /** 查找可能表示"数据被占用"的锁标记 */
  private async detectLockSidecars(path: string): Promise<string[]> {
    const hits: string[] = [];
    const dir = dirname(this.resolve(path));
    // 注意：base 要从"传入的路径"取，不能拿绝对目录长度去切相对路径
    const base = basename(path);
    const stem = base.replace(/\.[^.]+$/, '');

    let siblings: string[] = [];
    try {
      siblings = await fs.readdir(dir);
    } catch {
      return hits;
    }

    // 同目录下的具名锁：<stem>.lock / <stem>.lck
    for (const ext of ['.lock', '.lck']) {
      if (siblings.includes(`${stem}${ext}`)) hits.push(`${stem}${ext}`);
    }
    // ArcGIS 的临时锁：.~xxx.lock
    for (const name of siblings) {
      if (/^\.~.*\.lock$/i.test(name)) hits.push(name);
    }
    // FileGDB：锁文件在 .gdb 目录**内部**，要去 .gdb 目录里找
    if (/\.gdb$/i.test(base)) {
      try {
        const inner = await fs.readdir(join(dir, base));
        for (const name of inner) {
          if (/\.lock$/i.test(name)) hits.push(`${base}/${name}`);
        }
      } catch {
        /* 读不到就算了 */
      }
    }
    return hits;
  }
}
