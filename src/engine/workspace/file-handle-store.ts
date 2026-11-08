/**
 * 浏览器文件系统工作区：用户直接授权访问本地目录，不经过服务器。
 *
 * 依赖 File System Access API（Chrome/Edge 86+）。
 * 适合场景：单机版桌面壳、浏览器直连本地图件目录。
 */
import { NotFoundError, OccupiedError, type FileStat, type WorkspaceAdapter } from './index.ts';

/** File System Access API 的最小子集 */
export interface FileHandleLike {
  readonly kind: 'file';
  readonly name: string;
  createWritable(): Promise<{
    write(data: Uint8Array | string): Promise<void>;
    close(): Promise<void>;
  }>;
  getFile(): Promise<{
    readonly size: number;
    readonly lastModified: number;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

/**
 * 目录句柄（File System Access API 的最小子集）。
 *
 * 自己声明这层类型而不用 DOM lib：引擎是 Node 包，
 * 不引 DOM 类型才能让服务端产物里不出现浏览器全局。
 */
export interface DirectoryHandleLike {
  readonly kind: 'directory';
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  removeEntry(name: string): Promise<void>;
  values?(): AsyncIterableIterator<FileHandleLike | DirectoryHandleLike>;
}

/**
 * 整个文件系统访问入口（最小子集）。
 *
 * 可注入：测试里用假实现验证路径解析，不碰真实浏览器 API。
 */
export interface FileSystemAccessLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string): Promise<void>;
}

/**
 * 浏览器文件系统工作区的选项。
 *
 * api 不给就取全局 navigator.storage；浏览器不支持时构造直接报错——
 * 与其等到第一次读写才失败，不如建对象时就说明白。
 */
export interface FileHandleStoreOptions {
  /** 注入的 File System Access API；默认取全局 navigator.storage */
  readonly api?: FileSystemAccessLike;
  /** 根目录名，默认仓库根 */
  readonly rootName?: string;
}

/**
 * 浏览器文件系统工作区：用户授权后直接读写本机目录，不经过服务器。
 *
 * 适合单机版桌面壳与浏览器直连本地图件目录。
 * 语义与 LocalFolderStore 对齐，最要紧的一条是：
 * 权限类错误必须当作"存在"（否则会做出无备份的覆盖）。
 */
export class FileHandleStore implements WorkspaceAdapter {
  readonly kind = 'file-handle';
  readonly #api: FileSystemAccessLike;
  readonly #rootName: string;

  constructor(options: FileHandleStoreOptions = {}) {
    const injected = options.api;
    if (injected) {
      this.#api = injected;
    } else {
      const nav = (globalThis as { navigator?: { storage?: { getDirectoryHandle?: (n: string, o?: { create?: boolean }) => Promise<DirectoryHandleLike> } } }).navigator;
      const getDir = nav?.storage?.getDirectoryHandle;
      if (!getDir) {
        throw new Error('当前浏览器不支持 File System Access API');
      }
      this.#api = { getDirectoryHandle: getDir.bind(nav!.storage!) } as FileSystemAccessLike;
    }
    this.#rootName = options.rootName ?? 'cartouche';
  }

/** 路径原样返回：这里的路径是相对于已授权根目录的。 */
  resolve(path: string): string {
    return path;
  }

  /** 逐级拿到目录句柄 */
  async #dirOf(path: string, create: boolean): Promise<DirectoryHandleLike> {
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    let dir = await this.#api.getDirectoryHandle(this.#rootName, { create: true });
    for (const p of parts) {
      dir = await dir.getDirectoryHandle(p, { create });
    }
    return { dir, fileName } as unknown as DirectoryHandleLike;
  }

  async #fileHandle(path: string, create: boolean): Promise<FileHandleLike> {
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) throw new Error(`非法路径：${path}`);
    let dir = await this.#api.getDirectoryHandle(this.#rootName, { create: true });
    for (const p of parts) {
      dir = await dir.getDirectoryHandle(p, { create });
    }
    return dir.getFileHandle(fileName, { create });
  }

  /**
   * 目标是否存在。
   *
   * 语义与 `LocalFolderStore` 对齐：**只有"确实不存在"才返回 false**。
   * 浏览器侧可能抛权限类错误（NotAllowedError / NoModificationAllowedError），
   * 那表示"文件在，但当前拿不到句柄"——必须当作**存在**返回，
   * 否则写回层会误判"目标不存在"而跳过备份，最后做出**无备份的覆盖**。
   */
  async exists(path: string): Promise<boolean> {
    try {
      await this.#fileHandle(path, false);
      return true;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NotFoundError') return false;
      return true;
    }
  }

/** 读文件；拿不到句柄就抛 NotFoundError。 */
  async read(path: string): Promise<Uint8Array> {
    let handle: FileHandleLike;
    try {
      handle = await this.#fileHandle(path, false);
    } catch {
      throw new NotFoundError(path);
    }
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

/** 写文件（先打开可写流，写完关闭）。 */
  async write(path: string, data: Uint8Array): Promise<void> {
    const handle = await this.#fileHandle(path, true);
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

/** 列目录下的直接子项；浏览器不支持枚举时返回空数组。 */
  async list(dir: string): Promise<string[]> {
    const parts = dir.split('/').filter(Boolean);
    let handle = await this.#api.getDirectoryHandle(this.#rootName, { create: true });
    for (const p of parts) {
      handle = await handle.getDirectoryHandle(p, { create: true });
    }
    if (!handle.values) return [];
    const names: string[] = [];
    for await (const entry of handle.values()) names.push(entry.name);
    return names;
  }

/** 取文件信息；拿不到句柄就抛 NotFoundError。 */
  async stat(path: string): Promise<FileStat> {
    let handle: FileHandleLike;
    try {
      handle = await this.#fileHandle(path, false);
    } catch {
      throw new NotFoundError(path);
    }
    const file = await handle.getFile();
    return { size: file.size, mtimeMs: file.lastModified, isDirectory: false };
  }

/** 删除文件或目录。 */
  async remove(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) return;
    let handle = await this.#api.getDirectoryHandle(this.#rootName, { create: true });
    for (const p of parts) handle = await handle.getDirectoryHandle(p, { create: true });
    await handle.removeEntry(fileName);
  }

/** 复制：读出来再写到目标（浏览器没有原生的复制操作）。 */
  async copy(from: string, to: string): Promise<void> {
    const data = await this.read(from);
    await this.write(to, data);
  }

/** 重命名：读出来写到目标再删源。 */
  async rename(from: string, to: string): Promise<void> {
    const data = await this.read(from);
    await this.write(to, data);
    await this.remove(from);
  }

/**
 * 占用检测：退化为"能否打开写句柄"。
 *
 * 浏览器端没有可靠的独占锁探测，能打开写句柄就认为可写；
 * 打不开就当被占用。
 */
  async assertWritable(path: string): Promise<void> {
    // 浏览器端没有可靠的独占锁探测，退化为"能否打开写句柄"
    try {
      const handle = await this.#fileHandle(path, false);
      const writable = await handle.createWritable();
      await writable.close();
    } catch (err) {
      throw new OccupiedError(path, err);
    }
  }
}
