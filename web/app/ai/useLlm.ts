'use client';

/**
 * AI 接入页与引擎之间的全部对话。
 *
 * 为什么单独一个文件：这个页面要说的东西**只有四件** ——
 * 密钥从哪来、能用哪个模型、能不能连通、**一句话能不能变成一份操作计划**。
 * 把这些请求都收在一个 hook 里，页面组件就只剩界面，
 * 不会一边排版一边操心请求的成败形态。
 *
 * 密钥的三条铁律在这一层就守死：
 *   1. **不落盘明文** —— 粘贴的 key 只发给本机引擎，引擎只留在内存里；
 *   2. **永不回显** —— 状态接口只回 `configured` / `source`，这里也从不缓存 key；
 *   3. **不进 GitHub** —— 这个文件里没有任何密钥，一个字都没有。
 */
import { useCallback, useState } from 'react';
import { classifyPlanFailure, type PlanFailure } from './failures';

/** 引擎服务地址；next.config.mjs 已通过 env 注入，静态导出后仍是硬编码值 */
export const ENGINE_BASE = process.env.NEXT_PUBLIC_ENGINE_BASE_URL ?? 'http://127.0.0.1:8787';

/** 密钥来源：none = 还没配；env = 启动脚本注入；session = 这次会话里粘贴的 */
export type LlmSource = 'none' | 'env' | 'session';

export interface LlmStatus {
  readonly provider: string;
  readonly displayName: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly configured: boolean;
  readonly source: LlmSource;
  readonly models: readonly string[];
  readonly effortLevels: readonly string[];
}

/**
 * 模型清单的结果。
 *
 * `source` 必须带出去：给一份列表却不说是实时拉的还是上次成功的，
 * 用户会以为那就是官方当前能用的全部。
 *
 * - `api`：刚从官方实时拉到
 * - `stale`：这次没拉到，用的是上一次成功拉到的那份
 * - `fallback`：一次都没成功拉过，用的是代码里的离线兜底清单
 */
export interface LlmModelsPayload {
  readonly models: readonly string[];
  readonly source: 'api' | 'stale' | 'fallback';
  readonly warning: string | null;
}

export interface LlmTestPayload {
  readonly ok: true;
  readonly reply: string;
  readonly model: string;
  readonly elapsedMs: number;
}

export type LlmResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

/** 统一的取 JSON：把"连不上"和"服务端报错"翻译成能直接显示的中文 */
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(
      `无法连接引擎服务 ${ENGINE_BASE}（请确认已运行 npm run dev:server）：${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      /* 错误体不是 JSON（例如代理返回的 HTML），保留状态码 */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

/* ───────── AI 提议层（一句话 → 操作计划） ───────── */

/** 一条被提议的操作 */
export interface PlanOp {
  readonly op: string;
  readonly params: Record<string, unknown>;
  readonly preconditions?: Record<string, unknown>;
  readonly expect?: Record<string, unknown>;
  readonly requireUserConfirm?: boolean;
}

/** 一份操作计划（与引擎的 PlanDocument 同形） */
export interface PlanDocument {
  readonly version: string;
  readonly intent?: string;
  readonly ops: readonly PlanOp[];
}

/** 闸门①：Schema 校验的问题 */
export interface PlanSchemaIssue {
  readonly opIndex: number | null;
  readonly op: string | null;
  readonly message: string;
}

/** 闸门②：引擎还没实现的 op */
export interface UnsupportedOp {
  readonly opIndex: number;
  readonly op: string;
  readonly message: string;
}

/** 闸门②：引擎前置校验的逐条结论 */
export type PrecheckStatus = 'pass' | 'fail' | 'unimplemented' | 'unpreviewable';

export interface PrecheckEntry {
  readonly opIndex: number;
  readonly op: string;
  readonly status: PrecheckStatus;
  readonly message: string | null;
}

/** 「本次将发送什么」的预览 */
export interface ContextPreview {
  readonly context: unknown;
  readonly prompt: string;
  readonly bytes: number;
  readonly model: string | null;
  readonly effort: string | null;
}

/** 提议层的一次返回 */
export interface PlanPayload {
  readonly ok: boolean;
  /** 错误类别：llm_not_configured / llm_unauthorized / llm_unreachable / plan_schema_invalid / op_not_supported … */
  readonly error: string | null;
  /** 官方错误码（如 1004 = authorized_error） */
  readonly code: number | null;
  readonly message: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly elapsedMs: number | null;
  readonly plan: PlanDocument | null;
  readonly schemaIssues: readonly PlanSchemaIssue[];
  readonly unsupported: readonly UnsupportedOp[];
  readonly precheck: readonly PrecheckEntry[];
  readonly context: ContextPreview | null;
}

/**
 * 失败的**类别**。
 *
 * 「连不上 MiniMax」与「密钥不对」必须分开说：前者查网络，后者换密钥，
 * 混成一句"出错了"等于让用户自己猜。
 *
 * 分类与文案都放在 `failures.ts`（纯函数，可被 Node 直接测），
 * 这里只是转出去，界面的旧引用不用改。
 */
export type { PlanFailure, PlanFailureKind } from './failures';
export { classifyPlanFailure } from './failures';

/** 统一的取 JSON（失败时也要把响应体带出来：分类要看 body.error） */
async function postJson<T>(url: string, body: unknown): Promise<{ status: number; body: T | null }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `无法连接引擎服务 ${ENGINE_BASE}（请确认已运行 npm run dev:server）：${(err as Error).message}`,
    );
  }
  try {
    return { status: res.status, body: (await res.json()) as T };
  } catch {
    return { status: res.status, body: null };
  }
}

export interface LlmApi {
  readonly status: LlmStatus | null;
  readonly statusError: string | null;
  readonly models: LlmModelsPayload | null;
  readonly testResult: LlmTestPayload | null;
  readonly busy: Readonly<Record<string, boolean>>;
  readonly error: string | null;
  readonly isBusy: (key: string) => boolean;
  readonly refreshStatus: () => Promise<void>;
  /** 粘贴密钥：只发给本机引擎，引擎留在内存里 */
  readonly setKey: (apiKey: string) => Promise<LlmResult<LlmStatus>>;
  /** 清除内存态密钥 */
  readonly clearKey: () => Promise<LlmResult<LlmStatus>>;
  /** 实时拉模型清单 */
  readonly pullModels: () => Promise<LlmResult<LlmModelsPayload>>;
  /** 发一句话测连通性 */
  readonly testConnection: (options: {
    readonly prompt: string;
    readonly model: string;
    readonly effort: string;
  }) => Promise<LlmResult<LlmTestPayload>>;
  /* ── 提议层 ── */
  /** 最近一次提议的结果 */
  readonly plan: PlanPayload | null;
  /** 最近一次提议的失败（分类过，界面据此给不同的提示） */
  readonly planFailure: PlanFailure | null;
  /** 正在向模型要计划 */
  readonly planBusy: boolean;
  /** 要一份操作计划（只提议，不执行） */
  readonly requestPlan: (options: {
    readonly prompt: string;
    readonly model: string;
    readonly effort: string;
    /** 项目根（绝对路径）；给了才会带上图层清单 */
    readonly root?: string | null;
  }) => Promise<PlanPayload | null>;
  /** 「本次将发送什么」的预览（不发请求给模型） */
  readonly fetchContextPreview: (options: {
    readonly prompt?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly root?: string | null;
  }) => Promise<ContextPreview | null>;
}

export function useLlm(): LlmApi {
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [models, setModels] = useState<LlmModelsPayload | null>(null);
  const [testResult, setTestResult] = useState<LlmTestPayload | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanPayload | null>(null);
  const [planFailure, setPlanFailure] = useState<PlanFailure | null>(null);
  const [planBusy, setPlanBusy] = useState(false);

  const isBusy = useCallback((key: string) => Boolean(busy[key]), [busy]);

  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<LlmResult<T>> => {
    setBusy((prev) => ({ ...prev, [key]: true }));
    try {
      const data = await fn();
      setError(null);
      return { ok: true, data };
    } catch (err) {
      const message = (err as Error).message || String(err);
      setError(message);
      return { ok: false, error: message };
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    const res = await run('status', () => requestJson<LlmStatus>(`${ENGINE_BASE}/api/llm/status`));
    if (res.ok) {
      setStatus(res.data);
      setStatusError(null);
    } else {
      setStatusError(res.error);
    }
  }, [run]);

  const setKey = useCallback(
    async (apiKey: string) => {
      const res = await run('key', () =>
        requestJson<LlmStatus>(`${ENGINE_BASE}/api/llm/session-key`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey }),
        }),
      );
      if (res.ok) {
        setStatus(res.data);
        // 换密钥就意味着旧的模型清单不再作数，重新拉一次
        setModels(null);
        setTestResult(null);
      }
      return res;
    },
    [run],
  );

  const clearKey = useCallback(async () => {
    const res = await run('key', () =>
      requestJson<LlmStatus>(`${ENGINE_BASE}/api/llm/session-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      }),
    );
    if (res.ok) {
      setStatus(res.data);
      setModels(null);
      setTestResult(null);
    }
    return res;
  }, [run]);

  const pullModels = useCallback(async () => {
    const res = await run('models', () =>
      requestJson<LlmModelsPayload>(`${ENGINE_BASE}/api/llm/models`),
    );
    if (res.ok) setModels(res.data);
    return res;
  }, [run]);

  const testConnection = useCallback(
    async (options: { readonly prompt: string; readonly model: string; readonly effort: string }) => {
      const res = await run('test', () =>
        requestJson<LlmTestPayload>(`${ENGINE_BASE}/api/llm/test`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: options.prompt,
            model: options.model,
            effort: options.effort,
          }),
        }),
      );
      if (res.ok) setTestResult(res.data);
      return res;
    },
    [run],
  );

  const requestPlan = useCallback(
    async (options: {
      readonly prompt: string;
      readonly model: string;
      readonly effort: string;
      readonly root?: string | null;
    }): Promise<PlanPayload | null> => {
      setPlanBusy(true);
      setPlanFailure(null);
      try {
        const { status, body } = await postJson<PlanPayload>(`${ENGINE_BASE}/api/llm/plan`, {
          prompt: options.prompt,
          model: options.model,
          effort: options.effort,
          ...(options.root ? { root: options.root } : {}),
        });
        if (!body) {
          setPlanFailure({
            kind: 'unknown',
            message: `引擎返回了意料之外的内容（HTTP ${status}）`,
            code: null,
          });
          return null;
        }
        setPlan(body);
        if (!body.ok) setPlanFailure(classifyPlanFailure(body));
        return body;
      } catch (err) {
        setPlanFailure({
          kind: 'network',
          message: (err as Error).message,
          code: null,
        });
        return null;
      } finally {
        setPlanBusy(false);
      }
    },
    [],
  );

  const fetchContextPreview = useCallback(
    async (options: {
      readonly prompt?: string;
      readonly model?: string;
      readonly effort?: string;
      readonly root?: string | null;
    }): Promise<ContextPreview | null> => {
      try {
        const { body } = await postJson<ContextPreview>(`${ENGINE_BASE}/api/llm/context-preview`, {
          ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.effort !== undefined ? { effort: options.effort } : {}),
          ...(options.root ? { root: options.root } : {}),
        });
        return body ?? null;
      } catch {
        // 预览拿不到不是致命错误：真正发送时服务端还会再裁剪一次
        return null;
      }
    },
    [],
  );

  return {
    status,
    statusError,
    models,
    testResult,
    busy,
    error,
    isBusy,
    refreshStatus,
    setKey,
    clearKey,
    pullModels,
    testConnection,
    plan,
    planFailure,
    planBusy,
    requestPlan,
    fetchContextPreview,
  };
}
