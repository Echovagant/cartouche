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
  type KeyProvider,
  type LlmCredentials,
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
    models: MINIMAX_MODELS,
    effortLevels: MINIMAX_EFFORT_LEVELS,
  };
}

const MINIMAX_MODEL_LIST = [
  'MiniMax-M2.7',
  'MiniMax-M2.7-highspeed',
  'MiniMax-M2.5',
  'MiniMax-M2.5-highspeed',
  'MiniMax-M2.1',
  'MiniMax-M2.1-highspeed',
  'MiniMax-M2',
];

/** 取当前凭据（供网关发请求用）。没有就返回 null。 */
export async function resolveCredentials(): Promise<LlmCredentials | null> {
  return provider.resolve('local');
}
