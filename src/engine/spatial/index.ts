/**
 * 空间连接模块的公开 API。
 *
 * 纯函数：不碰文件、不碰 GDAL。输入两组要素，输出每个目标要素的匹配与汇总结果。
 */
export { spatialJoin, toOpData, JOIN_COUNT_FIELD } from './join.ts';
export type { SpatialJoinOpData } from './join.ts';

export { SpatialJoinError } from './types.ts';

export type {
  FeatureLike,
  JoinAggregate,
  SpatialJoinOptions,
  SpatialJoinResult,
  SpatialRelation,
} from './types.ts';
