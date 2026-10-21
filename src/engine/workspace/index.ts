/**
 * 工作区抽象（Workspace Adapter）。
 *
 * 存在的意义：让引擎不关心"文件在哪儿"。
 *  - 桌面版（Tauri）：LocalFolderStore 直读本地目录
 *  - 内网 Web 版：HttpProjectStore 走 HTTP
 *  - 浏览器直连：FileHandleStore 用 File System Access API
 *
 * 现在只落地 LocalFolderStore（单机版够用），接口先固定下来，
 * 后续新增实现不需要改引擎。
 *
 * 本文件是工作区模块的**出口**。实现细节拆到同目录的独立文件里：
 *   - `types.ts`            —— FileStat / WorkspaceAdapter
 *   - `errors.ts`           —— NotFoundError / OccupiedError / PathEscapeError
 *   - `local-folder-store.ts` —— LocalFolderStore
 *   - `roots.ts`            —— RootRegistry（已登记根与路径解析）
 * 拆分的唯一原因是**循环依赖**：`roots.ts` 需要 LocalFolderStore，
 * 而本文件又要 re-export 它——子模块必须直接引具体文件，不能引 `./index.ts`。
 */
import { createHash } from 'node:crypto';

export { LocalFolderStore } from './local-folder-store.ts';
export { NotFoundError, OccupiedError, PathEscapeError, existsFromErrorCode } from './errors.ts';
export type { FileStat, WorkspaceAdapter } from './types.ts';

/**
 * 锁文件候选名。
 * 约定：**去掉扩展名**再加后缀 —— ArcGIS 的锁是 `a.lock`（对应 `a.shp`），
 * 不是 `a.shp.lock`。三种工作区实现与服务端契约必须一致，否则占用检测会漏。
 */
export function lockCandidates(path: string): string[] {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const stem = base.replace(/\.[^.]+$/, '');
  return [`${stem}.lock`, `${stem}.lck`];
}

/** 内容哈希，用于写回后的完整性校验与审计留痕。 */
export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export { RootRegistry } from './roots.ts';
export type { WorkspaceRoot, ResolvedPath } from './roots.ts';
