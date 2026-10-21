/**
 * LLM 密钥提供方接口。
 *
 * v1 仅实现 BYOK（用户自带 Key）：密钥由调用方在请求中提供，服务端不落盘、不代管。
 * 团队托管模式（服务端统一管理 Key）预留为 ManagedKeyProvider，v1 不启用。
 *
 * 设计约束：
 * 1. 引擎与 AI 网关只依赖本接口，不感知密钥来源，便于后续切换实现。
 * 2. 任何实现都不得把密钥写入日志、审计记录或发往模型的内容里。
 *
 * 密钥的**不可泄露**约束（贯穿本文件所有实现）：
 *
 * 3. 密钥**永远不落盘明文**。要么来自环境变量，要么来自操作系统级加密存储
 *    （Windows 用 DPAPI，见 `scripts/set-key.ps1`），要么只存在于内存。
 * 4. 密钥**永远不出现在**日志、审计记录、错误信息、发往模型的内容里。
 * 5. 任何对外接口只允许返回「是否已配置」这类**布尔状态**，不允许返回密钥本身。
 * 6. 引擎层不直接读 `process.env`（那会把引擎绑死在 Node 上）；
 *    读取动作由调用方注入，引擎只拿到一个取值函数。
 */

/** 取密钥的函数：返回 null 表示当前没有可用密钥 */
export type CredentialReader = () => string | null | undefined;

export type LlmProviderId =
  | 'minimax'
  | 'deepseek'
  | 'qwen'
  | 'glm'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openai-compatible'
  | 'local';

export interface LlmCredentials {
  /** 模型标识，如 MiniMax-M3.1-Flash、gpt-4o-mini、qwen-plus */
  readonly model: string;
  /** API Key。BYOK 模式下由调用方随请求提供，服务端不持久化 */
  readonly apiKey?: string;
  /** 自定义接入点，如内网 vLLM / Ollama 的 /v1 */
  readonly baseUrl?: string;
  /** 额外请求头 */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * 思考深度档位（MiniMax：low/medium/high/xhigh/max，默认 max 且不可关闭）。
   * OpenAI 兼容协议下字段名为 `reasoning_effort`，Anthropic 兼容下为 `output_config.effort`。
   */
  readonly effort?: string;
}

export interface KeyProvider {
  readonly id: LlmProviderId;
  readonly displayName: string;
  /** 该接入点可选的模型列表 */
  listModels(): Promise<readonly string[]>;
  /** 解析某个使用者的凭据；返回 null 表示没有可用凭据 */
  resolve(ownerId: string): Promise<LlmCredentials | null>;
  /** 是否具备可用凭据，用于在 UI 上直接给出"请填写 Key"的提示而不是报错 */
  hasCredentials(ownerId: string): Promise<boolean>;
}

/**
 * BYOK：凭据由请求携带，随用随取。
 * ownerId 用于把凭据与"当前会话/用户"绑定，防止串用；具体绑定方式由调用方注入。
 */
export class ByokKeyProvider implements KeyProvider {
  readonly id: LlmProviderId;
  readonly displayName: string;
  readonly #resolve: (ownerId: string) => Promise<LlmCredentials | null>;
  readonly #models: readonly string[];

  constructor(options: {
    id: LlmProviderId;
    displayName: string;
    models?: readonly string[];
    resolve: (ownerId: string) => Promise<LlmCredentials | null>;
  }) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.#models = options.models ?? [];
    this.#resolve = options.resolve;
  }

  async listModels(): Promise<readonly string[]> {
    return this.#models;
  }

  async resolve(ownerId: string): Promise<LlmCredentials | null> {
    return this.#resolve(ownerId);
  }

  async hasCredentials(ownerId: string): Promise<boolean> {
    return (await this.resolve(ownerId)) !== null;
  }
}

/**
 * 团队托管模式占位。v1 不启用；启用时须补齐：密钥加密存储、轮换、访问审计、租户隔离。
 */
export class ManagedKeyProvider implements KeyProvider {
  readonly id: LlmProviderId;
  readonly displayName: string;
  readonly #enabled: boolean;

  constructor(options: { id: LlmProviderId; displayName: string; enabled?: boolean }) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.#enabled = options.enabled ?? false;
  }

  async listModels(): Promise<readonly string[]> {
    return [];
  }

  async resolve(_ownerId: string): Promise<LlmCredentials | null> {
    if (!this.#enabled) {
      throw new Error('团队托管模式未启用，请使用自带 Key（BYOK）');
    }
    throw new Error('尚未实现');
  }

  async hasCredentials(_ownerId: string): Promise<boolean> {
    return this.#enabled;
  }
}

export class KeyProviderRegistry {
  readonly #providers = new Map<LlmProviderId, KeyProvider>();

  register(provider: KeyProvider): void {
    this.#providers.set(provider.id, provider);
  }

  get(id: LlmProviderId): KeyProvider {
    const found = this.#providers.get(id);
    if (!found) {
      throw new Error(`未注册的模型提供方：${id}`);
    }
    return found;
  }

  list(): readonly KeyProvider[] {
    return [...this.#providers.values()];
  }
}

/* ────────────────────────── 具体提供方 ────────────────────────── */

/**
 * MiniMax 提供方（当前 v1 唯一落地的 provider）。
 *
 * ── 以下接入点与模型清单，均于 2026-10-21 **直接打真实端点**核实得出 ──
 *  平台首页（模型清单在此）：https://platform.minimax.io/
 *  国内版文档站有防爬，脚本抓不到深链 → **模型清单以 API 返回为准**：
 *    GET {base_url}/models   （带 key；返回该账号可用的模型 id 列表）
 *    这也是"拉取模型"按钮的实现依据，比任何静态清单都准。
 *
 *  · 国内版 base_url：OpenAI 兼容 `https://api.minimax.cn/v1`
 *                     Anthropic 兼容 `https://api.minimax.cn/anthropic`（官方推荐，支持 thinking 块与 interleaved thinking）
 *  · 国际版 base_url：`https://api.minimax.io/v1` / `https://api.minimax.io/anthropic`
 *  · 鉴权：`Authorization: Bearer <API Key>`
 *    （实测：无 key 时官方返回 401 `authorized_error` / code 1004，
 *      "Please carry the API secret key in the 'Authorization' field"）
 *  · 路径形态实测：`/anthropic/v1/messages` 存在（401），`/anthropic/messages` 不存在（404）
 *    ⇒ Anthropic 兼容端的 base_url 就是 `.../anthropic`，由 SDK 再补 `/v1/messages`。
 *
 * ⚠️ **模型迭代很快**：M2 / M2.1 / M2.5 / M2.7 / M2-her 已全部下线
 *    （官方公告：停止向新用户开放 2026-10-19，M2.7 正式下线 2026-11-18；
 *     M Plan / Token Plan 用户的 M2.5、M2.7 请求自 2026-10-19 起统一路由到 M3.1 Flash）。
 *    **不要凭记忆写模型名**——接模型前先拉一次 `/models` 拿实时清单。
 */
export const MINIMAX_CN_BASE_URL = 'https://api.minimax.cn/v1';
export const MINIMAX_CN_ANTHROPIC_BASE_URL = 'https://api.minimax.cn/anthropic';
export const MINIMAX_INTL_BASE_URL = 'https://api.minimax.io/v1';
export const MINIMAX_INTL_ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';

/**
 * 官方当前可用的语言模型（2026-10-21 核对）。
 * 两个都是原生多模态、1M 上下文的 Frontier Coding 模型。
 */
export const MINIMAX_MODELS: readonly string[] = [
  'MiniMax-M3.1-Flash', // 最新：思考深度可调，通过 effort 调档
  'MiniMax-M3',
];

/**
 * 思考深度档位。官方说明：**深度思考默认开启且不可关闭**
 * （传 `thinking:{type:"disabled"}` 或 `effort:"none"` 会返回 400 `requires adaptive thinking`）。
 * 想省 token 就**调低档位**，不要试图关掉。
 */
export const MINIMAX_EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** 默认思考深度（官方默认即 max） */
export const MINIMAX_DEFAULT_EFFORT = 'max';

export interface MiniMaxProviderOptions {
  /** 取密钥的方式；返回 null 表示未配置 */
  readonly readApiKey: CredentialReader;
  /** 默认模型 */
  readonly model?: string | undefined;
  /** 接入点，默认国内版 OpenAI 兼容端点 */
  readonly baseUrl?: string | undefined;
  /** 覆盖模型清单 */
  readonly models?: readonly string[] | undefined;
  /** 思考深度档位；省略则由网关按官方默认（max）处理 */
  readonly effort?: string | undefined;
}

/**
 * MiniMax 提供方。
 *
 * 密钥**只从注入的读取函数取**，本类不持有、不缓存、不落盘。
 */
export class MiniMaxProvider implements KeyProvider {
  readonly id: LlmProviderId = 'minimax';
  readonly displayName = 'MiniMax（国内版）';
  readonly #readApiKey: CredentialReader;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #models: readonly string[];
  readonly #effort: string | undefined;

  constructor(options: MiniMaxProviderOptions) {
    this.#readApiKey = options.readApiKey;
    this.#model = options.model ?? MINIMAX_MODELS[0]!;
    this.#baseUrl = options.baseUrl ?? MINIMAX_CN_BASE_URL;
    this.#models = options.models ?? MINIMAX_MODELS;
    this.#effort = options.effort;
  }

  get model(): string {
    return this.#model;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async listModels(): Promise<readonly string[]> {
    return this.#models;
  }

  async resolve(_ownerId: string): Promise<LlmCredentials | null> {
    const apiKey = this.#readApiKey();
    if (!apiKey) return null;
    return {
      model: this.#model,
      apiKey,
      baseUrl: this.#baseUrl,
      ...(this.#effort ? { effort: this.#effort } : {}),
    };
  }
  async hasCredentials(_ownerId: string): Promise<boolean> {
    return Boolean(this.#readApiKey());
  }
}

/**
 * 内存态提供方：密钥由调用方（通常是 Web 界面的输入框）在**本次会话**里临时交给，
 * 只驻留在进程内存中，进程退出即消失，**任何时候都不写盘**。
 */
export class SessionKeyProvider implements KeyProvider {
  readonly id: LlmProviderId;
  readonly displayName: string;
  readonly #readApiKey: CredentialReader;
  readonly #models: readonly string[];

  constructor(options: {
    id: LlmProviderId;
    displayName: string;
    readApiKey: CredentialReader;
    models?: readonly string[];
  }) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.#readApiKey = options.readApiKey;
    this.#models = options.models ?? [];
  }

  async listModels(): Promise<readonly string[]> {
    return this.#models;
  }

  async resolve(_ownerId: string): Promise<LlmCredentials | null> {
    const apiKey = this.#readApiKey();
    if (!apiKey) return null;
    return { model: this.#models[0] ?? '', apiKey };
  }

  async hasCredentials(_ownerId: string): Promise<boolean> {
    return Boolean(this.#readApiKey());
  }
}

/**
 * 把密钥从任意文本里抹掉。
 *
 * 用于**错误信息与日志**的最后一道防线：模型网关、HTTP 客户端、代理都可能
 * 把请求头原样塞进异常消息里，只要密钥进过异常就会泄到日志或前端。
 */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 8) continue; // 太短的不抹，避免把正常文本打成马赛克
    out = out.split(s).join('***REDACTED***');
  }
  // 兜底：常见厂商的 key 前缀
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, '***REDACTED***');
  return out;
}
