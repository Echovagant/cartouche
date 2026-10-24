/**
 * OpenAI 兼容协议的厂商目录。
 *
 * ## 为什么需要这张表
 *
 * 密钥是**用户自带**的：不同的人手里是不同的厂商的 key。
 * 产品若只认一家（原来的 MiniMax 一家），别人就**根本用不了**这个功能 ——
 * 而报错只会说"该操作尚未支持"，用户根本看不出是自己的 key 不被认。
 *
 * ## 表里的每一条都是实测出来的，不是抄文档
 *
 * 2026-10-24 逐个打过这些端点的 `GET {base}/models`：
 *
 *   · 401 / 403（"请带上密钥"）→ 端点存在且要求鉴权 ⇒ **支持拉模型清单**
 *   · 200（无需鉴权）→ 支持，且清单是公开的
 *   · 404 → 没有这个端点 ⇒ **不支持**（只能手填模型名）
 *
 * 拿到 401 只能证明"端点存在"，不能证明"这把 key 有权限"——套餐可能不给这个权限。
 * 那一层要拿真 key 再实测一次才算数。
 *
 * ## 一条都不要凭记忆写
 *
 * 厂商的端点与套餐规则会变（百炼 Coding Plan 的专用端点、火山方舟的 Coding Plan
 * 路径、模型清单…）。改这张表之前，先去打一发真实端点。
 */
import type { CredentialReader, KeyProvider, LlmCredentials, LlmProviderId } from '../key-provider.ts';
import { MINIMAX_MODELS } from '../key-provider.ts';

/** 一条接入线（厂商 × 端点 × 凭证类型） */
export interface LlmProviderEntry {
  /**
   * 稳定 id：界面与接口都用它。
   *
   * 类型收紧到 LlmProviderId 是故意的 —— 目录里写了一个联合类型里没有的 id，
   * 编译就会报错，而不是等到运行时才发现某家厂商没人认。
   */
  readonly id: LlmProviderId;
  /** 给用户看的名字 */
  readonly displayName: string;
  /** OpenAI 兼容端点（不带结尾斜杠） */
  readonly baseUrl: string;
  /**
   * 这个端点**是否提供** `GET {base}/models`。
   *
   * 2026-10-24 实测：绝大多数 OpenAI 兼容端点都提供（返回 401 = 端点在、只是要鉴权）。
   * 标成 false 的那些，界面就**不要**给「拉取模型清单」按钮 ——
   * 发一个必然失败的请求，比不给这个按钮更糟。
   */
  readonly modelsSupported: boolean;
  /**
   * 厂商家族（判断"这把 key 是哪一家的"用）。
   *
   * 为什么要分两级：同一家常有**多条接入线**（MiniMax 国内版 / 国际版、
   * 百炼按量 / Coding Plan），它们的 key 长得一样，光看 key 分不出是哪条线。
   * 所以先认出"是哪一家"（家族），再尽力认出"是哪条线"（认不出就说认不出）。
   */
  readonly family: string;
  /**
   * 这把 key 的前缀（用来识别"你贴的是别家的 key"）。
   *
   * ⚠️ **只放有区分度的前缀**：`sk-` 这种通用前缀**不能**用 ——
   * DeepSeek、Kimi、硅基流动、百炼按量的 key 全都是 `sk-` 开头，
   * 拿它当百炼的特征，等于把别家的 key 一律误判成百炼。
   *
   * 匹配时**按长度从长到短**排：`sk-sp-` 是 `sk-` 的前缀，
   * 先匹短的会把套餐 key 误判成按量 key（百炼就有这个坑）。
   * 认不出来就不提示 —— **认不出就不提示**，不能硬猜。
   */
  readonly keyPrefixes: readonly string[];
  /** 给用户看的提醒（协议差异、套餐条款…）；没有就不显示 */
  readonly note?: string;
  /** 是不是「用户自己填端点」的那种（界面要给一个 URL 输入框） */
  readonly customEndpoint?: boolean;
  /**
   * 这条接入线认不认 `reasoning_effort`（思考深度）。
   *
   * ⚠️ **认不出来就不要发**：OpenAI 兼容协议里这个字段不是通用标准，
   * 多数实现遇到不认识的参数会直接报错（400），而不是忽略它。
   * 2026-10-24 只对 MiniMax 核实过（官方文档明确列了这个字段），
   * 其它家一律按"不认"处理 —— 少给一个参数最多是思考深度用默认值，
   * 多给一个不认的参数是整次请求失败。
   */
  readonly effortSupported?: boolean;
  /**
   * 拉不到清单时的兜底模型名。
   *
   * 只有 MiniMax 有一份可信的离线清单（写死的是当时拉到的真清单）。
   * 其它家没有 —— 没有就说"拉不到，请手填模型名"，
   * **不要**拿别家的模型名凑数。
   */
  readonly fallbackModels?: readonly string[];
}

/**
 * 厂商目录。
 *
 * ⚠️ 端点、key 前缀、套餐限制都可能是 2026-10-24 的状态。
 * 动手改之前先打真实端点复核（见文件头的「实测」段）。
 */
export const LLM_PROVIDERS: readonly LlmProviderEntry[] = [
  {
    id: 'minimax-cn',
    displayName: 'MiniMax（国内版）',
    baseUrl: 'https://api.minimax.cn/v1',
    modelsSupported: true,
    family: 'minimax',
    keyPrefixes: ['sk-cp-', 'sk-api-'],
    effortSupported: true,
    fallbackModels: MINIMAX_MODELS,
    note: '与 MiniMax 国际版是两套账号体系，key 不通用。',
  },
  {
    id: 'minimax-intl',
    displayName: 'MiniMax（国际版）',
    baseUrl: 'https://api.minimax.io/v1',
    modelsSupported: true,
    family: 'minimax',
    keyPrefixes: ['sk-cp-', 'sk-api-'],
    effortSupported: true,
    fallbackModels: MINIMAX_MODELS,
    note: '与国内版是两套账号体系，key 不通用。',
  },
  {
    id: 'glm',
    displayName: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelsSupported: true,
    family: 'glm',
    keyPrefixes: [],
  },
  {
    id: 'dashscope',
    displayName: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelsSupported: true,
    family: 'dashscope',
    keyPrefixes: [],
  },
  {
    id: 'dashscope-coding',
    displayName: '阿里云百炼 Coding Plan',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    modelsSupported: true,
    // `sk-sp-` 是 `sk-` 的前缀 —— 匹配必须按长度倒序，否则套餐 key 会被当成按量 key。
    family: 'dashscope',
    keyPrefixes: ['sk-sp-'],
    note: '套餐 key（sk-sp- 开头）与按量 key 不通用。官方条款限定在编程工具内交互式使用，禁止 API 调用。',
  },
  {
    id: 'ark',
    displayName: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelsSupported: true,
    family: 'ark',
    keyPrefixes: [],
  },
  {
    id: 'ark-coding',
    displayName: '火山方舟 Coding Plan',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    // 官方文档给的是 Anthropic 协议路径；OpenAI 兼容能否直连**未验证**
    // （实测 401 = 网关在鉴权，但鉴权通过后是不是 OpenAI 格式，问不出来）。
    // 所以这里标成不支持拉清单：宁可让用户手填模型名，
    // 也不发一个可能必然失败的请求。
    modelsSupported: false,
    family: 'ark',
    keyPrefixes: [],
    note: '官方文档给的是 Anthropic 协议路径，OpenAI 兼容直连未验证（可用自定义端点试）；套餐额度仅限 AI 编程工具内使用。',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    modelsSupported: true,
    family: 'deepseek',
    keyPrefixes: [],
  },
  {
    id: 'moonshot',
    displayName: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    modelsSupported: true,
    family: 'moonshot',
    keyPrefixes: [],
  },
  {
    id: 'siliconflow',
    displayName: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    modelsSupported: true,
    family: 'siliconflow',
    keyPrefixes: [],
  },
  {
    id: 'ollama',
    displayName: '本机 Ollama / vLLM',
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelsSupported: true,
    family: 'local',
    keyPrefixes: [],
    note: '本机服务，不用密钥；要先把 Ollama 或 vLLM 起起来。',
  },
  {
    id: 'custom',
    displayName: '自定义（OpenAI 兼容）',
    baseUrl: '',
    modelsSupported: true,
    family: 'custom',
    keyPrefixes: [],
    note: '任何讲 OpenAI 兼容协议的端点都能填进来。',
    customEndpoint: true,
  },
];

/** 按 id 找一条接入线；找不到返回 null（不抛错，界面上可能拿到旧 id） */
export function findProvider(id: string): LlmProviderEntry | null {
  return LLM_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** 厂商家族的中文名（提示用户用） */
export const LLM_FAMILY_LABELS: Readonly<Record<string, string>> = {
  minimax: 'MiniMax',
  dashscope: '阿里云百炼',
  ark: '火山方舟',
  glm: '智谱 GLM',
  deepseek: 'DeepSeek',
  moonshot: '月之暗面 Kimi',
  siliconflow: '硅基流动',
  local: '本机模型服务',
  custom: '自定义服务',
};

/** 认出这把 key 的结果 */
export interface KeyDetection {
  /** 认得出是哪一家（厂商家族） */
  readonly family: string;
  /** 认得出是哪条接入线；同一家有多条线而 key 分不出时是 null */
  readonly providerId: string | null;
}

/**
 * 认出这把 key 像是哪一家的。
 *
 * **认不出就返回 null**：不能硬猜。猜错的提示比没有提示更糟 ——
 * 用户会以为自己贴错了，其实他贴得完全正确。
 *
 * 两级判定：
 *   1. 先按前缀认出**厂商家族**（MiniMax / 百炼 / 方舟…）——这一步通常做得准；
 *   2. 再看这个家族里是不是只有**一条**接入线配了这个前缀；
 *      是的话能认出是哪条线，不是的话（国内版 vs 国际版）就说认不出。
 *
 * 前缀包含关系是真实存在的：`sk-sp-` 是 `sk-` 的前缀，
 * 所以同厂商内**按长度从长到短**匹配。
 */
export function detectProviderByKey(key: string): KeyDetection | null {
  const trimmed = key.trim();
  if (!trimmed) return null;
  const matched: LlmProviderEntry[] = [];
  for (const provider of LLM_PROVIDERS) {
    const prefixes = [...provider.keyPrefixes].sort((a, b) => b.length - a.length);
    if (prefixes.some((p) => trimmed.startsWith(p))) matched.push(provider);
  }
  if (matched.length === 0) return null;
  const families = [...new Set(matched.map((p) => p.family))];
  if (families.length > 1) return null; // 一把 key 同时像几家？认不出
  const family = families[0]!;
  const candidates = matched.filter((p) => p.family === family);
  return { family, providerId: candidates.length === 1 ? candidates[0]!.id : null };
}

/**
 * OpenAI 兼容协议的通用 provider。
 *
 * 为什么不用 MiniMaxProvider：那个类把端点固定在构造参数里，
 * 而这里要支持"用户在界面上换一家"——端点必须能在**调用时**才定。
 */
export class OpenAiCompatibleProvider implements KeyProvider {
  readonly id: LlmProviderId;
  readonly displayName: string;
  readonly #readApiKey: CredentialReader;
  readonly #baseUrl: () => string;
  readonly #model: () => string;
  readonly #effort: string | undefined;

  constructor(options: {
    id: LlmProviderId;
    displayName: string;
    readApiKey: CredentialReader;
    /** 取端点：做成函数，才能在用户换接入线时立刻生效 */
    baseUrl: () => string;
    model: () => string;
    effort?: string | undefined;
  }) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.#readApiKey = options.readApiKey;
    this.#baseUrl = options.baseUrl;
    this.#model = options.model;
    this.#effort = options.effort;
  }

  get baseUrl(): string {
    return this.#baseUrl();
  }

  get model(): string {
    return this.#model();
  }

  async listModels(): Promise<readonly string[]> {
    return [];
  }

  async resolve(_ownerId: string): Promise<LlmCredentials | null> {
    const apiKey = this.#readApiKey();
    if (!apiKey) return null;
    return {
      model: this.#model(),
      apiKey,
      baseUrl: this.#baseUrl(),
      ...(this.#effort ? { effort: this.#effort } : {}),
    };
  }

  async hasCredentials(_ownerId: string): Promise<boolean> {
    return Boolean(this.#readApiKey());
  }
}
