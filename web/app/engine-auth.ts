/**
 * 本机引擎访问令牌（浏览器侧）。
 *
 * 引擎现在要求每个 /api 请求带 `x-cartouche-token`，这个令牌由启动器
 * 每次启动随机生成，通过 URL 片段 `#t=…` 交给页面：
 *
 *   - 片段不会发给服务器，也不会进 Referer；
 *   - 读到后立刻从地址栏抹掉，并放进 sessionStorage（同一个标签页刷新还在）；
 *   - 关掉标签页就没了，下次启动换新令牌 —— 旧令牌自动失效。
 *
 * 没令牌时不发请求，直接给出能照着做的中文提示：公共站点上打开画布、
 * 或者绕过启动器直接双击 canvas.html，都会落到这条提示上。
 */

const TOKEN_STORAGE_KEY = 'cartouche.engine-token';

let engineTokenValue: string | null = null;

/**
 * 把地址栏里的令牌片段抹掉。
 *
 * 单独导出：Next 的水合过程可能把初始 URL（含 #t=）再写回去，
 * 所以除了模块加载时调用一次，客户端组件在 hydrate 之后还会再调几次。
 */
export function stripTokenFromAddress(): void {
  if (typeof window === 'undefined') return;
  try {
    const hash = window.location.hash;
    if (!hash) return;
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    if (!params.has('t') && !params.has('token')) return;
    params.delete('t');
    params.delete('token');
    const rest = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`,
    );
  } catch {
    /* 地址栏抹不掉不影响功能，令牌已经存进 sessionStorage */
  }
}

function bootToken(): void {
  if (typeof window === 'undefined') return;
  try {
    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);
    const fromHash = params.get('t') ?? params.get('token');
    if (fromHash) {
      engineTokenValue = fromHash;
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, fromHash);
      stripTokenFromAddress();
      return;
    }
    engineTokenValue = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    engineTokenValue = null;
  }
}

bootToken();

/** 当前标签页持有的令牌；没有就是 null */
export function engineToken(): string | null {
  return engineTokenValue;
}

const NO_TOKEN_MESSAGE =
  '缺少本机访问令牌：请从启动器（START.cmd / start.cmd）重新打开画布，不要直接双击页面文件。';

/**
 * 给 URL 追加令牌查询参数。
 *
 * 只用于 GET（MapLibre 用 <img> 拉栅格图，加不了请求头）。
 * 写请求一律走 {@link engineFetch} 的请求头，令牌不进查询串。
 */
export function withEngineToken(url: string): string {
  if (!engineTokenValue) return url;
  try {
    const target = new URL(url, window.location.href);
    if (!target.searchParams.has('token')) target.searchParams.set('token', engineTokenValue);
    return target.toString();
  } catch {
    return url;
  }
}

/** 统一的引擎请求：自动带令牌，没令牌直接报清楚 */
export async function engineFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  if (!engineTokenValue) throw new Error(NO_TOKEN_MESSAGE);
  const headers = new Headers(init.headers);
  headers.set('x-cartouche-token', engineTokenValue);
  return fetch(input, { ...init, headers });
}
