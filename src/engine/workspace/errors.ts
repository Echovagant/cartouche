/**
 * 工作区相关的错误类型与错误码翻译。
 *
 * 为什么单独成文件：见 `types.ts` 的说明——拆模块后不能让子模块反向
 * 依赖 `index.ts`，否则 re-export 链条会绕成循环依赖。
 */

export class OccupiedError extends Error {
  readonly path: string;
  constructor(path: string, cause?: unknown) {
    super(`文件被占用，无法写入：${path}`);
    this.name = 'OccupiedError';
    this.path = path;
    if (cause !== undefined) this.cause = cause;
  }
}

export class NotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`文件不存在：${path}`);
    this.name = 'NotFoundError';
    this.path = path;
  }
}

export class PathEscapeError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`路径越界：${path}`);
    this.name = 'PathEscapeError';
    this.path = path;
  }
}

/**
 * 把 `fs.access` 的错误码翻译成「目标是否存在」。
 *
 * - `missing`：确实不存在（ENOENT / ENOTDIR）→ 上层可以放心认为没有这个东西
 * - `exists`：文件在，但当前拿不到访问权（EACCES / EPERM / EBUSY）→ **必须当作存在**
 * - `unknown`：没见过的错误 → 不该被伪装成「不存在」，应当抛出
 *
 * 抽成**纯函数**是为了能被直接单测：真实的 EACCES 在进程内无法稳定复现
 * （Node 打开文件始终带 FILE_SHARE_DELETE），不抽出来这条分支就永远测不到。
 */
export function existsFromErrorCode(code: string | undefined): 'exists' | 'missing' | 'unknown' {
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return 'exists';
  return 'unknown';
}
