/**
 * 体检结果的公共类型。
 *
 * 为什么单独一个文件：规则实现分散在几个模块（几何退化 / 坐标范围 / 拓扑 / 参照层），
 * 它们产出的是同一种结论。类型放在一处，各模块只 `import type`，
 * 既不会形成运行期循环依赖，也不用把「结论长什么样」抄四遍。
 */

/** 严重级别 */
export type Severity = 'info' | 'warn' | 'error' | 'blocker';

/** 一条体检结论 */
export interface Finding {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  /** 给用户看的下一步动作 */
  readonly hint?: string;
  readonly affectedCount?: number;
  readonly samples?: readonly string[];
}

/**
 * 检查项的行状态。
 *
 * **为什么要把「checked」与「skipped」分开**：
 * 「查了、没问题」和「根本没查」在报告里长得几乎一样 —— 用户读到
 * 「未发现自相交」会以为引擎查过自相交。这个仓库在这件事上吃过亏：
 * 报告曾经写「✅ 未发现自相交、空几何、零面积等几何问题」，
 * 而引擎从来就没有自相交这一条规则，契约里那几条一直标着「未实现」。
 *
 * 所以状态必须能表达「没查」，而且必须带上**为什么没查**；
 * 报告里凡是没查成的，一律不许出现在「未发现……」的句式里。
 */
export type CheckStatus =
  /** 查了，没发现问题 */
  | 'checked'
  /** 这类数据集没有这一项的适用面（如栅格没有逐要素几何） */
  | 'not-applicable'
  /** 引擎实现了，但这次没查成（缺参照层、缺 SpatiaLite、要素太少……） */
  | 'skipped'
  /** 引擎根本没实现这一项 */
  | 'unsupported';

export interface CheckCoverage {
  /** 检查项名：契约里的 15 项用契约里的名字，引擎自加的用短名 */
  readonly check: string;
  readonly status: CheckStatus;
  /** 没查成 / 不适用 / 未实现的原因（人话，直接进报告） */
  readonly reason?: string;
  /** 这一项落到哪些规则 id */
  readonly rules?: readonly string[];
  /**
   * 'contract' = 契约 `dataset.healthCheck` 声明的检查项；
   * 'extra' = 引擎自加的检查（几何拓扑这一族，契约里没有对应项）。
   */
  readonly scope?: 'contract' | 'extra';
}
