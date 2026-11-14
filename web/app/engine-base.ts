/**
 * 引擎服务地址的**唯一定义处**。
 *
 * 之前有三份拷贝：ai/useLlm.ts 与 canvas/useEngine.ts 各一份（读了
 * NEXT_PUBLIC_ENGINE_BASE_URL），canvas/layout/template-store.ts 的
 * DEFAULT_BASE 没读 —— 用户换了引擎地址之后，模板存取仍打 8787，行为分裂。
 * 现在三处都从这里 import，不再各自养一份。
 *
 * next.config.mjs 在构建期把 NEXT_PUBLIC_ENGINE_BASE_URL 注入静态导出；
 * 这里再兜一次 127.0.0.1:8787，保证没注入时（比如测试直跑源码）也有默认值。
 */
export const ENGINE_BASE = process.env.NEXT_PUBLIC_ENGINE_BASE_URL ?? 'http://127.0.0.1:8787';
