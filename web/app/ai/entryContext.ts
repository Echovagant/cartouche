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
