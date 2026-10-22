/**
 * MiniMax 官方接口的最小客户端（OpenAI 兼容协议）。
 *
 * 只做两件事：
 *
 * 1. **拉模型清单** —— `GET {base}/models`，鉴权走 `Authorization: Bearer <key>`
 * 2. **发一句话测连通性** —— `POST {base}/chat/completions`
 *
 * 为什么自己写而不是引 SDK：这个仓库的依赖门禁卡得严（`check:licenses` 只放行
 * 宽松许可的依赖），而这里真正需要的就两个请求；自己写反而更好控制一件事 ——
 * **密钥只在内存里**，出错信息必须由我们自己保证不回显。
 *
 * fetch 可注入：单元测试不联网，用假的 fetch 验证解析与错误处理。
 */
import { redactSecrets } from '../key-provider.ts';

/** 只用到的响应字段（够测，也不把整个 Response 类型拖进来） */
export interface MinimaxResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface MinimaxRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  /**
   * 请求体。
   *
   * **GET 不带 body** —— undici（Node 自带的 fetch）会直接拒绝
   * "Request with GET/HEAD method must have no body"，连空串都不行。
   */
  readonly body?: string;
}

export type MinimaxFetch = (
  url: string,
  init: MinimaxRequestInit,
) => Promise<MinimaxResponseLike>;

/** 默认实现：Node 自带的 fetch */
const defaultFetch: MinimaxFetch = async (url, init) => {
  const res = await fetch(url, init as unknown as RequestInit);
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

/** 一次调用所需的凭据（密钥只在内存里待着，不落盘、不回显） */
export interface MinimaxCallOptions {
  readonly apiKey: string;
  /** 形如 `https://api.minimax.cn/v1`（**不带**结尾斜杠） */
  readonly baseUrl: string;
  readonly model: string;
  /**
   * 思考深度档位。
   *
   * OpenAI 兼容协议下字段名是 `reasoning_effort`；官方默认即 max 且**不可关闭**，
   * 想省 token 只能调低档位。省略则不传该字段，由官方按默认走。
   */
  readonly effort?: string | undefined;
  /** 注入的 fetch（测试用）；省略则用 Node 自带的 */
  readonly fetchImpl?: MinimaxFetch | undefined;
}

export class MinimaxApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'MinimaxApiError';
    this.status = status;
  }
}

/** 拼接端点：base 去掉结尾斜杠，避免拼出 `//models` */
function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function headers(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
}

/**
 * 从官方错误体里挖出一句人能看懂的话。
 *
 * 官方有两种形态，都见过：
 *   - OpenAI 兼容：`{"error":{"message":"...","code":1004}}`
 *   - 官方原生：`{"base_resp":{"status_code":1004,"status_msg":"..."}}`
 * 挖不出来就返回 null，让调用方退回状态码。
 */
export function extractErrorMessage(text: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const err = o.error;
  if (typeof err === 'object' && err !== null) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  }

  const baseResp = o.base_resp;
  if (typeof baseResp === 'object' && baseResp !== null) {
    const msg = (baseResp as Record<string, unknown>).status_msg;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  }

  const message = o.message;
  if (typeof message === 'string' && message.trim()) return message.trim();

  return null;
}

/**
 * 拉模型清单。
 *
 * 返回该账号**当前可用**的模型 id —— 这比任何静态清单都准，
 * 所以它才是"拉取模型"按钮的答案，静态清单只作离线兜底。
 */
export async function listModelIds(options: MinimaxCallOptions): Promise<readonly string[]> {
  const doFetch = options.fetchImpl ?? defaultFetch;
  const url = endpoint(options.baseUrl, '/models');

  let res: MinimaxResponseLike;
  try {
    res = await doFetch(url, { method: 'GET', headers: headers(options.apiKey) });
  } catch (err) {
    // 网络层面的错误信息里可能夹着请求头 —— 抹掉密钥再往外说
    throw new MinimaxApiError(
      redactSecrets(`连不上模型服务 ${options.baseUrl}：${(err as Error).message}`, [options.apiKey]),
      0,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    const detail = extractErrorMessage(text);
    throw new MinimaxApiError(
      redactSecrets(
        detail ? `模型服务返回 ${res.status}：${detail}` : `模型服务返回 ${res.status}`,
        [options.apiKey],
      ),
      res.status,
    );
  }

  const ids = parseModelIds(text);
  if (ids.length === 0) {
    throw new MinimaxApiError('模型服务返回的清单里没有可用的模型 id', res.status);
  }
  return ids;
}

/** 从响应体里取出模型 id 列表（OpenAI 兼容的 `data[].id`） */
export function parseModelIds(text: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null) return [];
  const o = raw as Record<string, unknown>;
  const data = o.data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data) {
    if (typeof item === 'object' && item !== null) {
      const id = (item as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) ids.push(id.trim());
    }
  }
  return ids;
}

export interface MinimaxChatResult {
  /** 模型回话正文 */
  readonly reply: string;
  /** 实际使用的模型 */
  readonly model: string;
  /** 往返耗时（毫秒） */
  readonly elapsedMs: number;
}

/**
 * 模型清单的来源。
 *
 * - `api`：刚从官方实时拉到 —— 这一份才准
 * - `stale`：这次没拉到，用的是**上一次成功**拉到的那份（用户知道它可能过期了）
 * - `fallback`：一次都没成功拉过，只能用代码里的离线兜底清单
 */
export type ModelsSource = 'api' | 'stale' | 'fallback';

export interface ModelsOutcome {
  readonly models: readonly string[];
  readonly source: ModelsSource;
  /** 拉取失败时的原因（已脱敏）；source = api 时为 null */
  readonly warning: string | null;
}

/**
 * 拉不到清单时，给用户看哪一份。
 *
 * 优先给**上一次成功**拉到的那份，并标成 `stale` ——
 * 正在用着的模型清单不该因为一次网络抽风就被清空。
 * 一次都没成功过才退到代码里的离线兜底清单。
 */
export function pickModelsAfterFailure(options: {
  readonly lastSuccessful: readonly string[] | null;
  readonly fallback: readonly string[];
  readonly warning: string;
}): ModelsOutcome {
  const last = options.lastSuccessful;
  if (last && last.length > 0) {
    return { models: last, source: 'stale', warning: options.warning };
  }
  return { models: options.fallback, source: 'fallback', warning: options.warning };
}

/**
 * 发一句话，测连通性。
 *
 * 用的是**最小消息**：官方默认思考深度是 max 且不可关闭，
 * 所以这里不做"关闭思考"的尝试（那样只会换来 400）。
 */
export async function chatOnce(
  options: MinimaxCallOptions & { readonly prompt: string },
): Promise<MinimaxChatResult> {
  const doFetch = options.fetchImpl ?? defaultFetch;
  const url = endpoint(options.baseUrl, '/chat/completions');

  const payload: Record<string, unknown> = {
    model: options.model,
    messages: [{ role: 'user', content: options.prompt }],
    max_tokens: 256,
  };
  if (options.effort) payload.reasoning_effort = options.effort;

  const started = Date.now();
  let res: MinimaxResponseLike;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: headers(options.apiKey),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new MinimaxApiError(
      redactSecrets(`连不上模型服务 ${options.baseUrl}：${(err as Error).message}`, [options.apiKey]),
      0,
    );
  }
  const elapsedMs = Date.now() - started;

  const text = await res.text();
  if (!res.ok) {
    const detail = extractErrorMessage(text);
    throw new MinimaxApiError(
      redactSecrets(
        detail ? `模型服务返回 ${res.status}：${detail}` : `模型服务返回 ${res.status}`,
        [options.apiKey],
      ),
      res.status,
    );
  }

  const parsed = parseChatReply(text);
  if (!parsed.reply) {
    throw new MinimaxApiError('模型服务返回了响应，但没能读出回话内容', res.status);
  }
  return { reply: parsed.reply, model: parsed.model || options.model, elapsedMs };
}

/** 从 chat/completions 响应里取出回话正文与模型名 */
export function parseChatReply(text: string): { reply: string; model: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { reply: '', model: '' };
  }
  if (typeof raw !== 'object' || raw === null) return { reply: '', model: '' };
  const o = raw as Record<string, unknown>;

  const model = typeof o.model === 'string' ? o.model : '';

  const choices = o.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { reply: '', model };
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return { reply: '', model };
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) return { reply: '', model };

  const content = (message as Record<string, unknown>).content;
  // content 通常是字符串；多模态接口也可能给数组，这里都收下
  if (typeof content === 'string') return { reply: content.trim(), model };
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (typeof part === 'object' && part !== null) {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
    return { reply: parts.join('').trim(), model };
  }
  return { reply: '', model };
}
