/**
 * 密钥管理与接入线选择（本机引擎服务侧）。
 *
 * 设计目标来自项目要求：**API Key 不进 GitHub，且不以明文保存**。
 * 因此这里有且只有三条取钥路径：
 *
 * 1. **环境变量** `MINIMAX_API_KEY`
 *    由 `scripts/run-engine.ps1` 从 **DPAPI 加密文件**解密后注入到**当前进程**。
 *    进程退出，密钥随之消失；磁盘上只有密文。
 *    这把 key 属于**哪条接入线**跟着 `MINIMAX_BASE_URL` 走；没设就是国内版。
 * 2. **内存态**（Web 界面临时粘贴）
 *    只驻留在本进程内存里，服务重启即失效，**任何时候都不写盘**。
 *    **每条接入线各存一把**——换一家不等于丢掉上一家的。
 * 3. 将来接**团队托管模式**时，替换本模块的取钥实现即可，引擎侧无需改动。
 *
 * 对外只暴露**状态**（是否已配置、用的是哪条路径、选的是哪家），**绝不返回密钥本身**。
 *
 * ## 为什么要支持多家厂商
 *
 * 密钥是**用户自带**的：不同的人手里是不同的厂商的 key。
 * 产品若只认一家，别人就**根本用不了**这个功能 —— 而报错只会说
 * 「该操作尚未支持」，用户根本看不出是自己的 key 不被认。
 */
import {
  redactSecrets,
  MINIMAX_MODELS,
  MINIMAX_EFFORT_LEVELS,
  listModelIds,
  chatOnce,
  pickModelsAfterFailure,
  type KeyProvider,
  type LlmCredentials,
  type ModelsSource,
} from '@cartouche/engine';
import {
  LLM_PROVIDERS,
  LLM_FAMILY_LABELS,
  OpenAiCompatibleProvider,
  detectProviderByKey,
  findProvider,
  type LlmProviderEntry,
} from '@cartouche/engine';

export type KeySource = 'none' | 'env' | 'session';

/** 每条接入线各自的状态：内存态密钥、上次拉到的清单、用户选的模型 */
interface ProviderSession {
  key: string | null;
  /** 上次成功拉到的模型清单（换 key 后作废） */
  models: readonly string[] | null;
  /** 用户在界面上选的模型 */
  model: string | null;
}

/** 默认接入线：MiniMax 国内版（与历史行为一致） */
const DEFAULT_PROVIDER_ID = 'minimax-cn';

/** 各接入线的会话状态；没有条目的按"什么都没配"处理 */
const sessions = new Map<string, ProviderSession>();

/**
 * 当前选中的接入线。
 *
 * 初始值**跟着环境变量走**：开发者用 MINIMAX_BASE_URL 指了国际版，
 * 那把环境变量里的 key 就属于国际版 —— 当前选中必须跟着它，
 * 否则会出现「key 在手，引擎却说没配置密钥」（2026-10-24 真机验证时踩到）。
 */
let activeProviderId = envProviderId();

/** 自定义端点的地址（providerId === 'custom' 时用） */
let customBaseUrl = '';

function sessionOf(providerId: string): ProviderSession {
  let s = sessions.get(providerId);
  if (!s) {
    s = { key: null, models: null, model: null };
    sessions.set(providerId, s);
  }
  return s;
}

/** 环境变量里的密钥（由启动脚本注入） */
function envApiKey(): string | null {
  const v = process.env.MINIMAX_API_KEY;
  return v && v.trim() ? v.trim() : null;
}

/**
 * 环境变量里的密钥属于哪条接入线。
 *
 * 跟着 `MINIMAX_BASE_URL` 走：开发者换端点时，密钥自然跟着换。
 * 认不出来就归默认那条（总比"不认这把 key"好）。
 */
function envProviderId(): string {
  const base = (process.env.MINIMAX_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!base) return DEFAULT_PROVIDER_ID;
  const hit = LLM_PROVIDERS.find((p) => p.baseUrl === base);
  return hit?.id ?? DEFAULT_PROVIDER_ID;
}

/** 这条接入线实际用的端点（自定义那条用用户填的地址） */
export function baseUrlOf(providerId: string): string {
  const entry = findProvider(providerId);
  if (!entry) return '';
  if (entry.customEndpoint) return customBaseUrl.trim();
  if (providerId === envProviderId() && process.env.MINIMAX_BASE_URL) {
    return process.env.MINIMAX_BASE_URL.trim().replace(/\/+$/, '');
  }
  return entry.baseUrl;
}

/** 当前生效的密钥：内存态优先于环境变量 */
export function currentApiKey(providerId: string = activeProviderId): string | null {
  const s = sessions.get(providerId);
  if (s?.key) return s.key;
  if (providerId === envProviderId()) return envApiKey();
  return null;
}

/** 当前密钥来自哪条路径——只暴露来源，不暴露内容 */
export function currentKeySource(providerId: string = activeProviderId): KeySource {
  if (sessions.get(providerId)?.key) return 'session';
  if (providerId === envProviderId() && envApiKey()) return 'env';
  return 'none';
}

/** 当前选中的接入线 id */
export function currentProviderId(): string {
  return activeProviderId;
}

/**
 * 设置/清除某条接入线的内存态密钥，并把这条接入线设为当前选中。
 *
 * 传 null 即清除那一条的密钥（**只清这一条**，别家的不动）。
 */
export function setSessionApiKey(providerId: string, key: string | null): void {
  const s = sessionOf(providerId);
  s.key = key && key.trim() ? key.trim() : null;
  if (s.key) {
    // 换 key 就换能力边界：上一次的模型清单作废（那是上一把 key 的权限范围）
    s.models = null;
    s.model = null;
  }
  if (key) activeProviderId = providerId;
}

/** 切换当前选中的接入线 */
export function setActiveProvider(providerId: string): void {
  if (findProvider(providerId)) activeProviderId = providerId;
}

/** 设置自定义端点 */
export function setCustomBaseUrl(url: string): void {
  customBaseUrl = url.trim();
}

/** 记下用户在界面上选的模型 */
export function setSessionModel(providerId: string, model: string | null): void {
  sessionOf(providerId).model = model && model.trim() ? model.trim() : null;
}

/** 抹掉可能出现在错误信息里的密钥（所有接入线的都要抹） */
export function scrub(text: string): string {
  const secrets: (string | null)[] = [envApiKey()];
  for (const s of sessions.values()) secrets.push(s.key);
  return redactSecrets(text, secrets);
}

export interface LlmProviderStatus {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  /** 这个端点提供不提供模型清单接口 */
  readonly modelsSupported: boolean;
  /** 认不认思考深度参数 */
  readonly effortSupported: boolean;
  readonly note?: string;
  /** 这条线当前有没有可用密钥 */
  readonly configured: boolean;
  /** 是不是当前选中的那条 */
  readonly active: boolean;
  /** 要不要给用户一个"端点地址"输入框 */
  readonly customEndpoint: boolean;
}

export interface LlmStatus {
  /** 当前选中的接入线 id */
  readonly provider: string;
  readonly displayName: string;
  readonly model: string;
  readonly baseUrl: string;
  /** 是否已配置可用密钥 */
  readonly configured: boolean;
  /** 密钥来源：none / env / session —— 不含密钥内容 */
  readonly source: KeySource;
  readonly models: readonly string[];
  /** 思考深度档位（官方默认 max，且不可关闭） */
  readonly effortLevels: readonly string[];
  /** 全部可选接入线 */
  readonly providers: readonly LlmProviderStatus[];
}

function providerStatus(entry: LlmProviderEntry): LlmProviderStatus {
  return {
    id: entry.id,
    displayName: entry.displayName,
    baseUrl: baseUrlOf(entry.id),
    modelsSupported: entry.modelsSupported,
    effortSupported: entry.effortSupported === true,
    ...(entry.note ? { note: entry.note } : {}),
    configured: Boolean(currentApiKey(entry.id)),
    active: entry.id === activeProviderId,
    customEndpoint: entry.customEndpoint === true,
  };
}

/** 对外状态（不含密钥） */
export function llmStatus(): LlmStatus {
  const entry = findProvider(activeProviderId);
  const s = sessions.get(activeProviderId);
  const models = s?.models ?? entry?.fallbackModels ?? MINIMAX_MODELS;
  return {
    provider: activeProviderId,
    displayName: entry?.displayName ?? activeProviderId,
    model: s?.model ?? (activeProviderId === envProviderId() ? process.env.MINIMAX_MODEL || models[0] || '' : models[0] || ''),
    baseUrl: baseUrlOf(activeProviderId),
    configured: Boolean(currentApiKey()),
    source: currentKeySource(),
    // 拉过一次之后就用拉到的真清单；还没拉过就给代码里的离线兜底清单
    models,
    effortLevels: entry?.effortSupported === true ? MINIMAX_EFFORT_LEVELS : [],
    providers: LLM_PROVIDERS.map(providerStatus),
  };
}

/**
 * 认出用户贴的是不是别家的 key —— 给人话提示。
 *
 * 只做提示，**不拦**：用户可能正打算换厂商，拦下来反而添乱。
 * 认不出就返回 null：硬猜比不提示更糟（他会以为自己贴错了，其实完全正确）。
 */
export function detectProviderMismatch(key: string): string | null {
  const detected = detectProviderByKey(key);
  if (!detected) return null;
  const active = findProvider(activeProviderId);
  if (!active) return null;
  if (detected.providerId) {
    if (detected.providerId === activeProviderId) return null;
    const want = findProvider(detected.providerId);
    return `这把 key 看起来是「${want?.displayName ?? detected.providerId}」的，当前选的是「${active.displayName}」——换一条接入线试试。`;
  }
  // 认得出是哪一家、认不出是哪条线：只要不是同一家族就提醒
  if (detected.family === active.family) return null;
  const label = LLM_FAMILY_LABELS[detected.family] ?? detected.family;
  return `这把 key 看起来是 ${label} 家的，当前选的是「${active.displayName}」。`;
}

/* ── 引擎侧的 provider 实例（给 KeyProvider 接口用） ───────────── */

/** 为某条接入线造一个 provider（端点与密钥都在调用时才取，所以换线立刻生效） */
export function providerFor(providerId: string): KeyProvider {
  const entry = findProvider(providerId);
  if (!entry) throw new Error(`未知的接入线：${providerId}`);
  return new OpenAiCompatibleProvider({
    id: entry.id,
    displayName: entry.displayName,
    readApiKey: () => currentApiKey(providerId),
    baseUrl: () => baseUrlOf(providerId),
    model: () => {
      const s = sessions.get(providerId);
      if (s?.model) return s.model;
      if (providerId === envProviderId() && process.env.MINIMAX_MODEL) return process.env.MINIMAX_MODEL;
      return s?.models?.[0] ?? entry.fallbackModels?.[0] ?? '';
    },
    effort: entry.effortSupported === true ? process.env.MINIMAX_EFFORT : undefined,
  });
}

/** 供引擎/网关使用的 KeyProvider 实例（当前选中的那条） */
export function keyProvider(): KeyProvider {
  return providerFor(activeProviderId);
}

/** 取当前凭据（供网关发请求用）。没有就返回 null。 */
export async function resolveCredentials(providerId?: string): Promise<LlmCredentials | null> {
  return providerFor(providerId ?? activeProviderId).resolve('local');
}

export interface LlmModelsResult {
  readonly models: readonly string[];
  readonly source: ModelsSource;
  /** 拉取失败时的原因（已脱敏）；source = api 时为 null */
  readonly warning: string | null;
}

/**
 * 拉模型清单：**实时**从官方拉。拉不到就退回上一次成功的（再退才轮到离线清单）。
 *
 * 实时拉取失败**不算错误** —— 这一步是给用户选模型用的，
 * 断网时给一份能用的清单比直接报错有用。但失败原因必须如实带出去。
 */
export async function llmModels(providerId?: string): Promise<LlmModelsResult> {
  const id = providerId ?? activeProviderId;
  const entry = findProvider(id);
  if (!entry) throw new Error(`未知的接入线：${id}`);
  if (!entry.modelsSupported) {
    // 这个端点本来就没有清单接口：明说，别发一个必然失败的请求
    return {
      models: entry.fallbackModels ?? [],
      source: 'fallback',
      warning: `${entry.displayName} 这条接入线没有模型清单接口，请手填模型名。`,
    };
  }
  const creds = await resolveCredentials(id);
  // apiKey 在 KeyProvider 接口里是可选的（有些提供方不需要密钥），
  // 这里收窄成"一定有"再往下走 —— 没有密钥就别去打扰官方接口。
  if (!creds?.apiKey) {
    throw new Error('还没有配置 API Key：先在「密钥来源」里粘贴，或用启动脚本从本机密文注入。');
  }
  const apiKey = creds.apiKey;
  const s = sessionOf(id);
  try {
    const models = await listModelIds({
      apiKey,
      baseUrl: creds.baseUrl ?? entry.baseUrl,
      model: creds.model,
    });
    s.models = models;
    return { models, source: 'api', warning: null };
  } catch (err) {
    const warning = scrub((err as Error).message);
    if (!entry.fallbackModels) {
      // 这家没有内置清单：宁可说"拉不到，请手填"，也不要拿别家的模型名凑数
      s.models = null;
      return { models: [], source: 'fallback', warning: `${warning}（拉不到清单也没内置清单，请手填模型名）` };
    }
    return pickModelsAfterFailure({
      lastSuccessful: s.models,
      fallback: entry.fallbackModels,
      warning,
    });
  }
}

export interface LlmTestResult {
  readonly reply: string;
  readonly model: string;
  readonly elapsedMs: number;
}

/**
 * 连通性测试：发一句话，把回话与耗时带回来。
 *
 * 密钥只在这一次请求里用一次，用完就只留在内存里。
 */
export async function llmTest(options: {
  readonly providerId?: string | undefined;
  readonly prompt?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}): Promise<LlmTestResult> {
  const id = options.providerId ?? activeProviderId;
  const entry = findProvider(id);
  const creds = await resolveCredentials(id);
  if (!creds?.apiKey) {
    throw new Error('还没有配置 API Key：先在「密钥来源」里粘贴，或用启动脚本从本机密文注入。');
  }
  const apiKey = creds.apiKey;
  const prompt = options.prompt?.trim() || '用一句话打个招呼。';
  // 思考深度只在**认这个参数**的接入线上发：多发一个不认的参数会让整次请求失败。
  const effort = entry?.effortSupported === true ? options.effort : undefined;
  const result = await chatOnce({
    apiKey,
    baseUrl: creds.baseUrl ?? entry?.baseUrl ?? '',
    model: options.model?.trim() || creds.model,
    ...(effort ? { effort } : {}),
    prompt,
  });
  return { reply: result.reply, model: result.model, elapsedMs: result.elapsedMs };
}
