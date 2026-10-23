/**
 * 几何类型定义。
 *
 * 为什么对外是「GeoJSON 的形状 + 运行时校验」而不是「严格编译期类型」：
 * 空间连接读到的要素来自文件（Shapefile / GeoJSON / GPKG），几何有可能缺环、
 * 坐标写成字符串、空几何是 null。这些在 TypeScript 里都长得一样（`unknown`），
 * 必须在运行时区分开——「没有几何」和「几何坏了」是两回事，前者可以跳过，
 * 后者是数据错误，必须报出来，不能悄悄当成「不相交」。
 */

/** 一个坐标点：[x, y]。第三维（高程）允许存在但一律忽略。 */
export type Position = readonly [number, number];

/** 包围盒。 */
export interface BBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface PointGeometry {
  readonly type: 'Point';
  readonly coordinates: Position;
}

export interface MultiPointGeometry {
  readonly type: 'MultiPoint';
  readonly coordinates: readonly Position[];
}

export interface LineStringGeometry {
  readonly type: 'LineString';
  readonly coordinates: readonly Position[];
}

export interface MultiLineStringGeometry {
  readonly type: 'MultiLineString';
  readonly coordinates: readonly (readonly Position[])[];
}

/** 一个多边形：第一个环是外环，其余是洞。 */
export interface PolygonGeometry {
  readonly type: 'Polygon';
  readonly coordinates: readonly (readonly Position[])[];
}

export interface MultiPolygonGeometry {
  readonly type: 'MultiPolygon';
  readonly coordinates: readonly (readonly (readonly Position[])[])[];
}

export type Geometry =
  | PointGeometry
  | MultiPointGeometry
  | LineStringGeometry
  | MultiLineStringGeometry
  | PolygonGeometry
  | MultiPolygonGeometry;

/**
 * 校验后的内部表示。
 *
 * 为什么归一化成三种「kind」而不是保留 GeoJSON 的六种类型：
 * 空间关系只关心三件事——点在哪、线怎么走、面盖了哪块地。归一化后
 * 点/线/面之间的判定只有一套代码路径，多部件（Multi*）退化成「多份点/线/面」，
 * 不需要在每个判定函数里重复处理「部件之间也可能自交」这种分支。
 */
export interface NormalizedGeometry {
  /** 点类 / 线类 / 面类。 */
  readonly kind: 'point' | 'line' | 'area';
  /** 点类几何的全部点（MultiPoint 时多于一个）。 */
  readonly points: readonly Position[];
  /** 线类几何的全部线（MultiLineString 时多于一条）。 */
  readonly lines: readonly (readonly Position[])[];
  /** 面类几何的多边形组：每组第一个环是外环，其余是洞。 */
  readonly polygons: readonly (readonly (readonly Position[])[])[];
  /** 全部顶点，用于包围盒与质心兜底。 */
  readonly vertices: readonly Position[];
}
