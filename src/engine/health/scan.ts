/**
 * 要素扫描：把图层的前 N 个要素读成 GeoJSON，供逐要素的检查使用。
 *
 * 为什么走 ogr2ogr 而不是自己解析 shapefile：格式太多（shp / gpkg / geojson /
 * filegdb / …），让 GDAL 统一转一遍比自己写解析器靠谱得多。
 *
 * 为什么限制条数：体检要能跑在几十万要素的图层上，全量读进来会把内存吃光。
 * 截断时必须在报告里说清楚「只查了前 N 个」—— 否则用户会以为全查过了。
 */
import { tools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';

export interface ScannedGeometry {
  readonly type?: string;
  readonly coordinates?: unknown;
}

export interface ScannedFeature {
  readonly id: string | number | null;
  readonly geometry: ScannedGeometry | null;
  /** 属性值；字段类型检查要用 */
  readonly properties?: Record<string, unknown> | null;
}

export interface FeatureScan {
  readonly features: readonly ScannedFeature[];
  /** 要素数超过扫描上限，被截断了 */
  readonly truncated: boolean;
}

/**
 * 拉取要素（限制条数）。
 *
 * `-lco ID_GENERATE=YES` 让 GeoJSON 输出给每个要素带上 "id"（要素在图层里的序号）。
 * 不加这个选项时 GeoJSON 输出里没有 id，报告里就会出现 "要素 undefined" ——
 * 那种话没法照着做，等于没报。
 *
 * 这个序号是**要素在图层中的位置**（从 0 起）。对 Shapefile 来说它就是 FID
 * （Shapefile 的 FID 本来就是从 0 起连续编的）；别的驱动不一定，
 * 所以文案里说「要素序号」而不是「FID」。
 *
 * 返回 null 表示**读不到**（不是「没有要素」）：调用方必须把这两件事分开，
 * 否则一次读取失败会被当成「这个图层很干净」。
 */
export async function scanFeatures(
  loc: GdalLocation,
  path: string,
  limit: number,
): Promise<FeatureScan | null> {
  const gdal = tools(loc);
  const res = await gdal.ogr2ogr([
    '-f', 'GeoJSON',
    '-limit', String(limit + 1),
    '-lco', 'RFC7946=NO',
    '-lco', 'ID_GENERATE=YES',
    '/vsistdout/',
    path,
  ]);
  if (!res.ok || !res.stdout.trim()) return null;
  try {
    const j = JSON.parse(res.stdout) as { features?: ScannedFeature[] };
    const feats = j.features ?? [];
    const truncated = feats.length > limit;
    return { features: truncated ? feats.slice(0, limit) : feats, truncated };
  } catch {
    return null;
  }
}

/** 几何是否为空（没有几何，或坐标为空） */
export function isNullGeometry(g: ScannedGeometry | null): boolean {
  if (!g) return true;
  const c = g.coordinates;
  if (c === undefined || c === null) return true;
  if (Array.isArray(c) && c.length === 0) return true;
  return false;
}
