/**
 * 引擎服务地址的**唯一定义处**。
 *
 * 优先级：用户在设置页存的本机覆盖（localStorage）→ 构建期注入的环境变量 → 默认回环地址。
 * 覆盖值存在用户自己浏览器的 localStorage 里，不进仓库、不进任何请求头以外的请求体。
 *
 * 历史背景：曾经有三份拷贝（ai/useLlm.ts 与 canvas/useEngine.ts 各一份，
 * canvas/layout/template-store.ts 的 DEFAULT_BASE 没读环境变量），现三处都从这里 import。
 */
export function resolveEngineBase(): string {
  if (typeof window !== 'undefined') {
    try {
      const override = window.localStorage.getItem('cartouche.engine-base');
      if (override && override.trim() !== '') return override.trim().replace(/\/+$/, '');
    } catch {
      /* 隐私模式下 localStorage 不可用，走默认 */
    }
  }
  return process.env.NEXT_PUBLIC_ENGINE_BASE_URL ?? 'http://127.0.0.1:8787';
}

export const ENGINE_BASE = resolveEngineBase();
