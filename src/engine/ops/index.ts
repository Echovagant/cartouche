/**
 * 操作计划调度的公开 API（③a-2）。
 */
export {
  executePlan,
  previewOp,
  normalizePlan,
  listImplementedOps,
} from './executor.ts';
export type {
  OperationSpec,
  PlanDocument,
  PlanInput,
  OpImpact,
  OpExecutionRecord,
  PlanExecutionResult,
  ExecutorDeps,
} from './executor.ts';
