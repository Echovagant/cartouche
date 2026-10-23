/**
 * 矢量读写模块的出口。
 *
 * 这一层提供的是**能力**（读要素、写回要素、按条件查、加计算字段），
 * op 的登记在 ops/executor.ts —— 那一份由主会话统一维护，
 * 这里只负责把实现交出去，避免两处并行改同一个文件。
 */
export {
  probeLayer,
  parseLayerInfo,
  epsgOf,
  sameSrs,
  readFeatures,
  referencedFields,
  matchesWhere,
} from './read.ts';

export {
  writeFeatures,
  featuresToGeoJson,
  formatForPath,
  companionFiles,
} from './write.ts';

export { runVectorQuery } from './query.ts';
export { runVectorAddField } from './field.ts';
export { runVectorSpatialJoin } from './spatial-join.ts';
export { runVectorReproject } from './reproject.ts';
export { runVectorRenameFields } from './rename-fields.ts';
export { runVectorRecode } from './recode.ts';
export type { VectorOpDeps } from './query.ts';

export {
  SUPPORTED_ENCODINGS,
  detectEncoding,
  normalizeEncoding,
} from './encoding.ts';
export type { SupportedEncoding } from './encoding.ts';

export { findWrittenField, assertValidFieldName } from './field-names.ts';

export { toRelPath, toRelPathChecked, makeTempDir, timestamp } from './paths.ts';

export { VectorError } from './types.ts';
export type {
  FeatureGeometry,
  FeatureRecord,
  LayerField,
  LayerInfo,
  ReadFeaturesOptions,
  ReadFeaturesResult,
  WriteFeaturesOptions,
  WriteFeaturesResult,
  VectorWriteFormat,
} from './types.ts';
