/**
 * 几何模块的公开 API。
 *
 * 这一层是纯计算：不碰文件、不碰 GDAL、不碰数据库。
 * 输入是 GeoJSON 风格的几何对象，输出是布尔或数值。
 */
export {
  bboxOf,
  centroidOf,
  centroidNormalized,
  distanceBetween,
  distanceNormalized,
} from './metrics.ts';

export {
  contains,
  containsNormalized,
  geometryIntersects,
  intersectsNormalized,
  pointInPolygon,
  pointInNormalizedArea,
  bboxPreFilter,
  bboxOfNormalized,
} from './predicates.ts';

export { GeometryError } from './errors.ts';

export { normalizeGeometry, readInputPoint } from './normalize.ts';

export { EPS } from './primitives.ts';

export type {
  BBox,
  Geometry,
  LineStringGeometry,
  MultiLineStringGeometry,
  MultiPointGeometry,
  MultiPolygonGeometry,
  NormalizedGeometry,
  PointGeometry,
  PolygonGeometry,
  Position,
} from './types.ts';
