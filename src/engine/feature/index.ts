/**
 * feature.* 三个 op 的出口。
 *
 * 为什么单独一个目录（而不是放进 vector/）：
 *  - vector/ 是"读要素、写要素"这一层的底座，feature/ 是"按要素做一件事"这一层的 op；
 *    两者依赖方向是 feature → vector，反过来会绕成环。
 *  - op 的登记在 ops/executor.ts —— 那一份由主会话统一维护，
 *    这里只负责把实现交出去，避免两处并行改同一个文件。
 *
 * 三个 op 对应 ArcGIS Pro 里最常做的三件事：
 *  - feature.setAttributes：按条件批量改属性（Pro 里是属性表里逐格改）；
 *  - feature.delete：按条件删除要素；
 *  - feature.summarize：按字段分组汇总（Pro 的"汇总统计"）。
 */
export { runFeatureSetAttributes } from './attributes.ts';
export { runFeatureDelete } from './delete.ts';
export { runFeatureSummarize } from './summarize.ts';

export {
  AREA_UNIT_KEYS,
  areaUnitLabel,
  crsMeasureOf,
  featureSize,
  planarArea,
  planarLength,
} from './measure.ts';
export type { CrsMeasure } from './measure.ts';

export {
  columnKindOf,
  compileWhere,
  matchIndexes,
  resolveFieldName,
} from './common.ts';
export type { ColumnKind, ResolvedField } from './common.ts';
