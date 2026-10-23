/**
 * 几何的运行时校验与归一化。
 *
 * 为什么在这里就把坏数据挡掉：空间判定的结论（相不相关、在不在里面）
 * 直接决定用户的属性表。坏几何如果被当成「不相交」，用户看到的是
 * 「这个区域里没有任何点」——一句看起来正常、实际是错的结论。
 * 所以宁可在这里报错，把「第 7 个要素的坐标是 NaN」这种能定位的信息抛出去。
 */
import { GeometryError } from './errors.ts';
import type { NormalizedGeometry, Position } from './types.ts';

const SUPPORTED_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);

/** 校验一个坐标点：至少两维，前两维必须是有限数。 */
function readPosition(value: unknown, where: string): Position {
  if (!Array.isArray(value)) {
    throw new GeometryError(`${where}不是坐标数组`);
  }
  if (value.length < 2) {
    throw new GeometryError(`${where}的坐标维数不足（至少要 x、y 两维，实为 ${value.length} 维）`);
  }
  const x = value[0];
  const y = value[1];
  if (typeof x !== 'number' || typeof y !== 'number') {
    throw new GeometryError(`${where}的坐标不是数字（x=${String(x)}，y=${String(y)}）`);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new GeometryError(`${where}的坐标含 NaN/Infinity（x=${x}，y=${y}）`);
  }
  return [x, y];
}

function readPositions(value: unknown, where: string): Position[] {
  if (!Array.isArray(value)) {
    throw new GeometryError(`${where}不是坐标数组`);
  }
  return value.map((v, i) => readPosition(v, `${where}第 ${i} 个点`));
}

/** 校验一条线：至少两个点。 */
function readLine(value: unknown, where: string): Position[] {
  const pts = readPositions(value, where);
  if (pts.length < 2) {
    throw new GeometryError(`${where}的点数不足（一条线至少要两个点，实为 ${pts.length} 个）`);
  }
  return pts;
}

/** 校验一个环：至少三个点（闭合环由判定逻辑隐式处理）。 */
function readRing(value: unknown, where: string): Position[] {
  const pts = readPositions(value, where);
  if (pts.length < 3) {
    throw new GeometryError(`${where}的点数不足（一个环至少要三个点，实为 ${pts.length} 个）`);
  }
  return pts;
}

/** 校验一个多边形：至少一个外环。 */
function readPolygonRings(value: unknown, where: string): Position[][] {
  if (!Array.isArray(value)) {
    throw new GeometryError(`${where}不是环数组`);
  }
  if (value.length === 0) {
    throw new GeometryError(`${where}缺少外环`);
  }
  return value.map((ring, i) => readRing(ring, `${where}第 ${i} 个环`));
}

function flatten(groups: readonly (readonly Position[])[]): Position[] {
  const out: Position[] = [];
  for (const g of groups) {
    for (const p of g) out.push(p);
  }
  return out;
}

/**
 * 把任意输入归一化成内部表示。
 *
 * @param value 待校验的几何
 * @param label 出错信息里的称呼（带上「第几个要素」这类定位信息）
 */
export function normalizeGeometry(value: unknown, label = '几何'): NormalizedGeometry {
  if (value === null || value === undefined) {
    throw new GeometryError(`${label}为空（null geometry）`);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new GeometryError(`${label}不是几何对象`);
  }
  const obj = value as { type?: unknown; coordinates?: unknown };
  const type = obj.type;
  if (typeof type !== 'string') {
    throw new GeometryError(`${label}缺少 type 字段`);
  }
  if (!SUPPORTED_TYPES.has(type)) {
    throw new GeometryError(
      `${label}的类型 ${type} 不受支持（只支持 Point / MultiPoint / LineString / MultiLineString / Polygon / MultiPolygon）`,
    );
  }
  const coords = obj.coordinates;
  if (!Array.isArray(coords)) {
    throw new GeometryError(`${label}的 coordinates 不是数组`);
  }

  switch (type) {
    case 'Point': {
      const p = readPosition(coords, `${label}的坐标`);
      return { kind: 'point', points: [p], lines: [], polygons: [], vertices: [p] };
    }
    case 'MultiPoint': {
      const pts = readPositions(coords, `${label}的坐标`);
      if (pts.length === 0) {
        throw new GeometryError(`${label}没有任何点`);
      }
      return { kind: 'point', points: pts, lines: [], polygons: [], vertices: pts };
    }
    case 'LineString': {
      const line = readLine(coords, `${label}的坐标`);
      return { kind: 'line', points: [], lines: [line], polygons: [], vertices: line };
    }
    case 'MultiLineString': {
      if (coords.length === 0) {
        throw new GeometryError(`${label}没有任何线`);
      }
      const lines = coords.map((line, i) => readLine(line, `${label}第 ${i} 条线`));
      return { kind: 'line', points: [], lines, polygons: [], vertices: flatten(lines) };
    }
    case 'Polygon': {
      const rings = readPolygonRings(coords, `${label}的坐标`);
      const vertices = flatten(rings);
      return { kind: 'area', points: [], lines: [], polygons: [rings], vertices };
    }
    case 'MultiPolygon': {
      if (coords.length === 0) {
        throw new GeometryError(`${label}没有任何多边形`);
      }
      const polys = coords.map((poly, i) => readPolygonRings(poly, `${label}第 ${i} 个多边形`));
      const vertices: Position[] = [];
      for (const poly of polys) {
        for (const ring of poly) {
          for (const p of ring) vertices.push(p);
        }
      }
      return { kind: 'area', points: [], lines: [], polygons: polys, vertices };
    }
    default:
      // 上面的 SUPPORTED_TYPES 已经拦过一遍；这里是兜底，防止以后加类型时漏改。
      throw new GeometryError(`${label}的类型 ${type} 尚未实现`);
  }
}

/** 校验调用方传入的坐标点（公开 API 的点参数）。 */
export function readInputPoint(value: unknown, label = '点'): Position {
  return readPosition(value, label);
}
