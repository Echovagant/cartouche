/**
 * HTTP 工作区：Web 版的默认实现，文件操作走内网引擎服务。
 *
 * 契约（引擎服务需实现这些端点）：
 *   GET  /api/fs/read?path=...        → 二进制内容
 *   GET  /api/fs/stat?path=...        → { size, mtimeMs, isDirectory }
 *   GET  /api/fs/list?path=...        → { entries: string[] }
 *   POST /api/fs/write                 → body: <path>\0<bytes>   → { ok, size }
 *   POST /api/fs/remove                → body: <path>           → { ok }
 *   POST /api/fs/copy                  → body: <from>\n<to>     → { ok }
 *   POST /api/fs/rename                → body: <from>\n<to>     → { ok }
 *   POST /api/fs/assert-writable       → body: <path>           → { ok } | 409 { error:'occupied' }
 *
 * 占用判定约定：锁文件按**去掉扩展名**命名 —— `a.shp` 的锁是 `a.lock`（不是 `a.shp.lock`），
 * 与 LocalFolderStore / MemoryStore 保持一致。
 */
import { NotFoundError, OccupiedError, type FileStat, type WorkspaceAdapter } from './index.ts';

/**
 * fetch 的最小本地类型。
 * 引擎包是 Node 包，不引 DOM lib（避免把浏览器全局带进服务端产物），
 * 因此这里自己声明够用的形状，注入时由 globalThis.fetch 适配。
 */
export interface FetchInitLike {
  method?: string;
  body?: ArrayBuffer | ArrayBufferView | string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export interface HttpProjectStoreOptions {
  readonly baseUrl: string;
  /** 自定义 fetch，便于测试与代理 */
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export class HttpProjectStore implements WorkspaceAdapter {
  readonly kind = 'http-project';
  readonly baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: HttpProjectStoreOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    const impl = options.fetchImpl ?? (globalFetch as FetchLike | undefined);
    if (!impl) {
      throw new Error('当前运行时没有 fetch，请注入 fetchImpl');
    }
    this.#fetch = impl;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  resolve(path: string): string {
    return path;
  }

  async #request(pathname: string, init?: FetchInitLike): Promise<FetchResponseLike> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetch(`${this.baseUrl}${pathname}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async #post(pathname: string, body: ArrayBuffer | ArrayBufferView | string): Promise<FetchResponseLike> {
    return this.#request(pathname, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }

  async exists(path: string): Promise<boolean> {
    const res = await this.#request(`/api/fs/stat?path=${encodeURIComponent(path)}`);
    return res.ok;
  }

  async read(path: string): Promise<Uint8Array> {
    const res = await this.#request(`/api/fs/read?path=${encodeURIComponent(path)}`);
    if (res.status === 404) throw new NotFoundError(path);
    if (!res.ok) {
      throw new Error(`读取失败：${path}（HTTP ${res.status}）`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const payload = new Uint8Array(data.length + 1 + Buffer.byteLength(path, 'utf8'));
    const pathBytes = Buffer.from(path, 'utf8');
    payload.set(pathBytes, 0);
    payload[pathBytes.length] = 0;
    payload.set(new Uint8Array(data), pathBytes.length + 1);
    const res = await this.#post('/api/fs/write', payload);
    if (!res.ok) {
      throw new Error(`写入失败：${path}（HTTP ${res.status}）`);
    }
  }

  async list(dir: string): Promise<string[]> {
    const res = await this.#request(`/api/fs/list?path=${encodeURIComponent(dir)}`);
    if (!res.ok) return [];
    const j = (await res.json()) as { entries?: string[] };
    return j.entries ?? [];
  }

  async stat(path: string): Promise<FileStat> {
    const res = await this.#request(`/api/fs/stat?path=${encodeURIComponent(path)}`);
    if (res.status === 404) throw new NotFoundError(path);
    if (!res.ok) throw new Error(`取属性失败：${path}（HTTP ${res.status}）`);
    const j = (await res.json()) as { size?: number; mtimeMs?: number; isDirectory?: boolean };
    return {
      size: j.size ?? 0,
      mtimeMs: j.mtimeMs ?? 0,
      isDirectory: j.isDirectory ?? false,
    };
  }

  async remove(path: string): Promise<void> {
    const res = await this.#post('/api/fs/remove', path);
    if (!res.ok) throw new Error(`删除失败：${path}（HTTP ${res.status}）`);
  }

  async copy(from: string, to: string): Promise<void> {
    const res = await this.#post('/api/fs/copy', `${from}\n${to}`);
    if (!res.ok) throw new Error(`复制失败：${from} → ${to}`);
  }

  async rename(from: string, to: string): Promise<void> {
    const res = await this.#post('/api/fs/rename', `${from}\n${to}`);
    if (!res.ok) throw new Error(`重命名失败：${from} → ${to}`);
  }

  async assertWritable(path: string): Promise<void> {
    const res = await this.#post('/api/fs/assert-writable', path);
    if (res.status === 409) {
      throw new OccupiedError(path, new Error('服务端判定文件被占用'));
    }
    if (!res.ok) {
      throw new Error(`占用检测失败：${path}（HTTP ${res.status}）`);
    }
  }
}
