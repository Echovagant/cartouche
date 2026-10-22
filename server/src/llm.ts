/**
 * 密钥管理（本机引擎服务侧）。
 *
 * 设计目标来自项目要求：**API Key 不进 GitHub，且不以明文保存**。
 *
 * 因此这里有且只有三条取钥路径：
 *
 * 1. **环境变量** `MINIMAX_API_KEY`
 *    由 `scripts/run-engine.ps1` 从 **DPAPI 加密文件**解密后注入到**当前进程**。
 *    进程退出，密钥随之消失；磁盘上只有密文。
 * 2. **内存态**（Web 界面临时粘贴）
 *    只驻留在本进程内存里，服务重启即失效，**任何时候都不写盘**。
 * 3. 将来接**团队托管模式**时，替换本模块的取钥实现即可，引擎侧无需改动。
 *
 * 对外只暴露**状态**（是否已配置、用的是哪条路径），**绝不返回密钥本身**。
 */
import {
  MiniMaxProvider,
  redactSecrets,
  MINIMAX_MODELS,
  MINIMAX_EFFORT_LEVELS,
  MINIMAX_CN_BASE_URL,
  listModelIds,
  chatOnce,
  pickModelsAfterFailure,
  type KeyProvider,
  type LlmCredentials,
  type ModelsSource,
} from '@cartouche/engine';

export type KeySource = 'none' | 'env' | 'session';

/** 内存态密钥：不落盘，进程退出即消失 */
let sessionApiKey: string | null = null;

/** 环境变量里的密钥（由启动脚本注入） */
function envApiKey(): string | null {
  const v = process.env.MINIMAX_API_KEY;
  return v && v.trim() ? v.trim() : null;
}

/** 当前生效的密钥：内存态优先于环境变量 */
export function currentApiKey(): string | null {
  return sessionApiKey ?? envApiKey();
}

/** 当前密钥来自哪条路径——只暴露来源，不暴露内容 */
export function currentKeySource(): KeySource {
  if (sessionApiKey) return 'session';
  if (envApiKey()) return 'env';
  return 'none';
}

/** 设置/清除内存态密钥。传入 null 即清除。 */
export function setSessionApiKey(key: string | null): void {
  sessionApiKey = key && key.trim() ? key.trim() : null;
}

/** 抹掉可能出现在错误信息里的密钥 */
export function scrub(text: string): string {
  return redactSecrets(text, [sessionApiKey, envApiKey()]);
}

export interface LlmStatus {
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
}

const provider = new MiniMaxProvider({
  readApiKey: () => currentApiKey(),
  model: process.env.MINIMAX_MODEL || undefined,
  baseUrl: process.env.MINIMAX_BASE_URL || undefined,
  effort: process.env.MINIMAX_EFFORT || undefined,
});

/** 供引擎/网关使用的 KeyProvider 实例 */
export function keyProvider(): KeyProvider {
  return provider;
}

/** 对外状态（不含密钥） */
export function llmStatus(): LlmStatus {
  return {
    provider: provider.id,
    displayName: provider.displayName,
    model: provider.model,
    baseUrl: provider.baseUrl,
    configured: Boolean(currentApiKey()),
    source: currentKeySource(),
    // 拉过一次之后就用拉到的真清单；还没拉过就给代码里的离线兜底清单
    models: lastSuccessfulModels ?? MINIMAX_MODELS,
    effortLevels: MINIMAX_EFFORT_LEVELS,
  };
}

/**
 * 模型清单的来源。
 *
 * - `api`：刚从官方 `GET {base}/models` 实时拉到 —— 这是**准确**的那一份，
 *   因为模型上下线很频繁，写死在代码里的清单随时会过期。
 * - `stale`：这次没拉到，用的是**上一次成功**拉到的那份（用户知道它可能过期）。
 * - `fallback`：一次都没成功拉过，只能用代码里的离线清单。
 *
 * 哪一种都**必须**标出来 —— 只给一份列表却不说是哪来的，
 * 用户会以为那就是实时结果。
 */
export type LlmModelsSource = ModelsSource;

export interface LlmModelsResult {
  readonly models: readonly string[];
  readonly source: LlmModelsSource;
  /** 拉取失败时的原因（已脱敏）；source = api 时为 null */
  readonly warning: string | null;
}

export interface LlmTestResult {
  readonly reply: string;
  readonly model: string;
  /** 往返耗时（毫秒） */
  readonly elapsedMs: number;
}

/**
 * 上一次成功拉到的模型清单。
 *
 * 只在内存里（跟密钥一样的待遇）。有了它，一次网络抽风不会把用户
 * 正在用的模型清单清空 —— 只是把它标成"上次成功的"。
 */
let lastSuccessfulModels: readonly string[] | null = null;

/** 取当前凭据（供网关发请求用）。没有就返回 null。 */
export async function resolveCredentials(): Promise<LlmCredentials | null> {
  return provider.resolve('local');
}

/**
 * 拉模型清单：能实时拉就实时拉，拉不到才退回上一次成功的（再退才轮到离线清单）。
 *
 * 实时拉取失败**不算错误** —— 这一步是给用户选模型用的，
 * 断网时给一份能用的清单比直接报错有用。但失败原因必须如实带出去。
 */
export async function llmModels(): Promise<LlmModelsResult> {
  const creds = await resolveCredentials();
  // apiKey 在 KeyProvider 接口里是可选的（有些提供方不需要密钥），
  // 这里收窄成"一定有"再往下走 —— 没有密钥就别去打扰官方接口。
  if (!creds?.apiKey) {
    throw new Error('还没有配置 API Key：先在「密钥来源」里粘贴，或用启动脚本从本机密文注入。');
  }
  const apiKey = creds.apiKey;
  try {
    const models = await listModelIds({
      apiKey,
      baseUrl: creds.baseUrl ?? MINIMAX_CN_BASE_URL,
      model: creds.model,
    });
    lastSuccessfulModels = models;
    return { models, source: 'api', warning: null };
  } catch (err) {
    return pickModelsAfterFailure({
      lastSuccessful: lastSuccessfulModels,
      fallback: MINIMAX_MODELS,
      warning: scrub((err as Error).message),
    });
  }
}

/**
 * 连通性测试：发一句话，把回话与耗时带回来。
 *
 * 密钥只在这一次请求里用一次，用完就只留在内存里。
 */
export async function llmTest(options: {
  readonly prompt?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}): Promise<LlmTestResult> {
  const creds = await resolveCredentials();
  if (!creds?.apiKey) {
    throw new Error('还没有配置 API Key：先在「密钥来源」里粘贴，或用启动脚本从本机密文注入。');
  }
  const apiKey = creds.apiKey;
  const prompt = options.prompt?.trim() || '用一句话打个招呼。';
  const result = await chatOnce({
    apiKey,
    baseUrl: creds.baseUrl ?? MINIMAX_CN_BASE_URL,
    model: options.model?.trim() || creds.model,
    ...(options.effort ? { effort: options.effort } : {}),
    prompt,
  });
  return { reply: result.reply, model: result.model, elapsedMs: result.elapsedMs };
}
