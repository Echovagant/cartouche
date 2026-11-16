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

/**
 * 扫出来的一个几何（GeoJSON 的形状）。
 *
 * coordinates 保持 unknown：GeoJSON 里坐标可能是数字、也可能是字符串、也可能是 null，
 * 判断放到读的时候做，不在这里假装它一定是干净的数值数组。
 */
export interface ScannedGeometry {
  readonly type?: string;
  readonly coordinates?: unknown;
}

/**
 * 扫出来的一个要素。
 *
 * id 是要素在图层里的序号（从 0 起）：GeoJSON 输出必须加 -lco ID_GENERATE=YES 才有，
 * 少了它报告里就会出现"要素 undefined"，那种话没法照着做。
 */
export interface ScannedFeature {
  readonly id: string | number | null;
  readonly geometry: ScannedGeometry | null;
  /** 属性值；字段类型检查要用 */
  readonly properties?: Record<string, unknown> | null;
}

/**
 * 一次扫描的结果。
 *
 * truncated 标出是否撞到了扫描上限：撞到了就必须在报告里说"只查了前 N 个"，
 * 否则用户会以为全查过了。
 */
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

  /**
   * 转一层，返回该层的要素（读不到就 null）。
   *
   * `layer` 为空 = 整文件转（单图层源）；给了层名 = 只转那一层。
   */
  const scanOne = async (layer?: string): Promise<ScannedFeature[] | null> => {
    const args = [
      '-f', 'GeoJSON',
      '-limit', String(limit + 1),
      '-lco', 'RFC7946=NO',
      '-lco', 'ID_GENERATE=YES',
      '/vsistdout/',
      path,
    ];
    if (layer !== undefined) args.push(layer);
    const res = await gdal.ogr2ogr(args);
    if (!res.ok || !res.stdout.trim()) return null;
    try {
      const j = JSON.parse(res.stdout) as { features?: ScannedFeature[] };
      return j.features ?? [];
    } catch {
      return null;
    }
  };

  // 多图层容器（GeoPackage / KML / KMZ …）：**GeoJSON 输出驱动是单图层的**，
  // 整文件转不过去（报 "Layer … cannot be created"）→ 读不到要素 →
  // 报告里整节变成"未检查"。用户看到的是"这工具检查不了"，那是白做。
  // 改成逐层转再合并（与 vector-geojson 的两阶段做法同源）。
  const layerNames = await probeLayerNames(loc, path);
  if (layerNames && layerNames.length > 1) {
    const merged: ScannedFeature[] = [];
    for (const layer of layerNames) {
      if (merged.length > limit) break;
      const feats = await scanOne(layer);
      if (!feats) continue;
      merged.push(...feats);
    }
    if (merged.length === 0) return null;
    const truncated = merged.length > limit;
    return { features: truncated ? merged.slice(0, limit) : merged, truncated };
  }

  const feats = await scanOne();
  if (!feats) return null;
  const truncated = feats.length > limit;
  return { features: truncated ? feats.slice(0, limit) : feats, truncated };
}

/**
 * 探这个文件里的图层名（读不到就 null = 单图层或探不出来）。
 *
 * 探不出来时按单图层处理：老路径照旧，不因为探层失败就把体检整个拖垮。
 */
async function probeLayerNames(loc: GdalLocation, path: string): Promise<string[] | null> {
  try {
    const { probeLayer } = await import('../vector/read.ts');
    const info = await probeLayer(loc, path);
    const names = info.layerNames.filter((n) => n !== '');
    return names.length > 0 ? names : null;
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
