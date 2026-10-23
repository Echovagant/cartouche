/**
 * 画布 → AI 工作台的**上下文契约**。
 *
 * 为什么用 URL 传，而不是全局变量或本地存储：
 *   - 画布与 AI 工作台是**两个页面**（静态导出下是 canvas.html 与 ai.html），
 *     页面之间唯一稳定的通道就是地址栏；
 *   - URL 可以直接复制、可以后退、可以被测试断言，不需要额外的存储层；
 *   - 本机绝对路径出现在地址栏里不算泄露 —— 它不会离开这台机器，
 *     而且**只发给本机引擎**（引擎用它读项目清单，模型看不到它）。
 *
 * 为什么不把图层清单整个塞进 URL：清单可能很长，地址栏会撑爆；
 * 引擎那边拿到 root 就能自己读清单（server/src/app.ts 的 manifestContext），
 *   这里只带"用户在画布上正看着哪个图层"这层指代信息。
 */

/** 画布带过来的上下文 */
export interface AiEntryContext {
  /** 项目根（本机绝对路径）；为空表示用户是直接打开 AI 页的 */
  readonly root: string | null;
  /** 项目名 */
  readonly projectName: string | null;
  /** 画布上当前选中的图层 id */
  readonly layerId: string | null;
  /** 画布上当前选中的图层名 */
  readonly layerName: string | null;
  /** 项目里的图层总数 */
  readonly layerCount: number;
  /** 上下文是不是从画布带过来的 */
  readonly fromCanvas: boolean;
}

/** 空上下文：直接打开 AI 页时的初始状态 */
export const EMPTY_ENTRY_CONTEXT: AiEntryContext = {
  root: null,
  projectName: null,
  layerId: null,
  layerName: null,
  layerCount: 0,
  fromCanvas: false,
};

/** URL 查询参数的键名（集中一处，避免两边写岔） */
export const AI_ENTRY_KEYS = {
  root: 'root',
  project: 'project',
  layer: 'layer',
  layerName: 'layerName',
  layers: 'layers',
} as const;

/** 把上下文编成查询串 */
export function buildAiEntryQuery(context: AiEntryContext): URLSearchParams {
  const params = new URLSearchParams();
  if (context.root) params.set(AI_ENTRY_KEYS.root, context.root);
  if (context.projectName) params.set(AI_ENTRY_KEYS.project, context.projectName);
  if (context.layerId) params.set(AI_ENTRY_KEYS.layer, context.layerId);
  if (context.layerName) params.set(AI_ENTRY_KEYS.layerName, context.layerName);
  if (context.layerCount > 0) params.set(AI_ENTRY_KEYS.layers, String(context.layerCount));
  return params;
}

/**
 * 从查询串还原上下文。
 *
 * 容错：任何一项缺失或读不出来都只是"这一项没有"，不能因此让整页崩掉。
 */
export function parseAiEntryQuery(search: string): AiEntryContext {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } catch {
    return EMPTY_ENTRY_CONTEXT;
  }
  const root = params.get(AI_ENTRY_KEYS.root)?.trim() || '';
  const projectName = params.get(AI_ENTRY_KEYS.project)?.trim() || '';
  const layerId = params.get(AI_ENTRY_KEYS.layer)?.trim() || '';
  const layerName = params.get(AI_ENTRY_KEYS.layerName)?.trim() || '';
  const layerCountRaw = Number(params.get(AI_ENTRY_KEYS.layers) ?? '');
  const layerCount = Number.isFinite(layerCountRaw) && layerCountRaw > 0 ? Math.round(layerCountRaw) : 0;

  // 只要带了 root 就算是"从画布来的"：项目根是画布能给、AI 页自己猜不出的东西
  if (!root && !projectName && !layerId && !layerName && layerCount === 0) {
    return EMPTY_ENTRY_CONTEXT;
  }
  return {
    root: root || null,
    projectName: projectName || null,
    layerId: layerId || null,
    layerName: layerName || null,
    layerCount,
    fromCanvas: true,
  };
}

/**
 * AI 工作台的入口地址。
 *
 * 静态导出下 canvas.html 与 ai.html 是同目录的兄弟，相对路径在 file:// 下也能解析；
 * `next dev` 不认 .html 后缀，用绝对路由。NODE_ENV 由构建期内联。
 */
export function aiEntryBasePath(isDev: boolean): string {
  return isDev ? '/ai' : 'ai.html';
}

/** 拼出带上下文的完整入口地址 */
export function buildAiEntryHref(context: AiEntryContext, basePath: string): string {
  const query = buildAiEntryQuery(context).toString();
  return query ? `${basePath}?${query}` : basePath;
}

/**
 * 入口的可用性：没有项目根就带不了图层清单。
 *
 * 说清楚**为什么**点不了，比让按钮灰着不说话强。
 */
export function describeAiEntry(context: AiEntryContext): {
  readonly enabled: boolean;
  readonly reason: string;
  readonly summary: string;
} {
  if (!context.root) {
    return {
      enabled: false,
      reason: '还没打开项目：先在画布上选一个项目，才知道该改哪张图。',
      summary: '未打开项目',
    };
  }
  const parts: string[] = [];
  if (context.projectName) parts.push(`项目《${context.projectName}》`);
  if (context.layerName) parts.push(`当前图层《${context.layerName}》`);
  if (context.layerCount > 0) parts.push(`共 ${context.layerCount} 个图层`);
  return {
    enabled: true,
    reason: '',
    summary: parts.join(' · ') || `项目根 ${context.root}`,
  };
}
