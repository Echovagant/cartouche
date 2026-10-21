/**
 * 数据集的地理范围（统一换算到 EPSG:4326）。
 *
 * 为什么需要它：
 *   画布加载图层后必须**把视野移到数据上**，否则用户看到的是一张空白图
 *   （默认视野在北京，而数据在杭州）。
 *   矢量可以由前端从 GeoJSON 算，但栅格的范围只在 GDAL 那边知道，
 *   所以这里给前端一个统一的查询入口，矢量、栅格都能问。
 *
 * 坐标系处理：
 *   范围一律换算到 **EPSG:4326**，且是 **lon/lat 序**（x=经度、y=纬度）。
 *   ⚠️ GDAL 3 的 WKT 里 EPSG:4326 的轴定义是 lat/lon（`AXIS["latitude",north]`），
 *   但 ogrinfo / gdalinfo 给的 extent、cornerCoordinates 都是**数据本身的 x/y 序**，
 *   对 4326 来说就是 lon/lat。projjson 里的 `dataAxisToSRSAxisMapping: [2,1]`
 *   也印证了这一点。前端 MapLibre 用的正是 lon/lat。
 */
import { join } from 'node:path';
import { tools, type GdalTools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { BBox4326 } from './raster-image.ts';

export interface DatasetExtentOptions {
  /** 数据集的绝对路径 */
  readonly path: string;
}

export interface DatasetExtentResult {
  /** EPSG:4326 的 [minX, minY, maxX, maxY]（min/max 序，lon/lat） */
  readonly bbox: BBox4326;
  readonly kind: 'raster' | 'vector';
  /** 源坐标系授权码；拿不到为 null */
  readonly sourceEpsg: number | null;
  /** 是否真的做了重投影（false 表示源本来就是 4326，或源没有坐标系、按目标 CRS 直算） */
  readonly reprojected: boolean;
}

export class DatasetExtentError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr = '') {
    super(message);
    this.name = 'DatasetExtentError';
    this.stderr = stderr;
  }
}

/** 从 projjson 里取权威码；projjson 是结构化的，比正则扒 WKT 可靠。 */
function epsgFromProjJson(cs: { projjson?: unknown } | undefined): number | null {
  const pj = cs?.projjson as { id?: { authority?: string; code?: number } } | undefined;
  const id = pj?.id;
  if (!id || typeof id.code !== 'number') return null;
  if (id.authority && id.authority.toUpperCase() !== 'EPSG') return null;
  return id.code;
}

/** 退化路径：projjson 缺失时从 WKT 里取**最后一个** ID["EPSG",N]。 */
function epsgFromWkt(wkt: string | undefined): number | null {
  if (!wkt) return null;
  const ids = [...wkt.matchAll(/ID\["EPSG",(\d+)\]/g)].map((m) => Number(m[1]));
  return ids.length > 0 ? ids[ids.length - 1]! : null;
}

/** 合并多个范围（一个 .gdb 里可能有很多图层） */
function unionBox(boxes: readonly BBox4326[]): BBox4326 {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [a, b, c, d] of boxes) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) continue;
    minX = Math.min(minX, a);
    minY = Math.min(minY, b);
    maxX = Math.max(maxX, c);
    maxY = Math.max(maxY, d);
  }
  if (!Number.isFinite(minX)) throw new DatasetExtentError('数据集没有可用的地理范围');
  return [minX, minY, maxX, maxY];
}

/** 校验并规整 bbox：确保 min<max，非法就报错（不静默修正） */
function assertBox(box: BBox4326, what: string): BBox4326 {
  const [minX, minY, maxX, maxY] = box;
  for (const v of [minX, minY, maxX, maxY]) {
    if (!Number.isFinite(v)) throw new DatasetExtentError(`${what} 含非法坐标`);
  }
  if (maxX <= minX || maxY <= minY) {
    throw new DatasetExtentError(`${what} 的范围不合法（minX<maxX 且 minY<maxY）：${box.join(', ')}`);
  }
  return box;
}

/** 栅格：gdalinfo -json → geoTransform 推出四角；不在 4326 就 warp 到 4326 再问一次。 */
async function rasterExtent(
  gdal: GdalTools,
  path: string,
): Promise<{ bbox: BBox4326; sourceEpsg: number | null; reprojected: boolean } | null> {
  const res = await gdal.info(path, ['-json']);
  if (!res.ok) return null;

  let j: {
    geoTransform?: number[];
    size?: [number, number];
    cornerCoordinates?: Record<string, [number, number]>;
    coordinateSystem?: { wkt?: string; projjson?: unknown };
  };
  try {
    j = JSON.parse(res.stdout) as typeof j;
  } catch {
    return null;
  }
  // 没有仿射变换 → 不是可定位的栅格（与体检规则 R-GEO-001 一致）
  if (!j.geoTransform || j.geoTransform.length < 6) return null;

  const srcEpsg =
    epsgFromProjJson(j.coordinateSystem) ?? epsgFromWkt(j.coordinateSystem?.wkt);

  // ⚠️ srcEpsg 为 null 表示**这份栅格没有坐标系**（典型：Esri TIFF + .tfw 世界文件，
  //    没有 .prj）。这种情况不能声称"重投影过"——GDAL 的 warp 对无 CRS 的源同样只能
  //    假定它就是目标 CRS，结果与直接用仿射参数算出来的一样。
  //    坐标系缺失本身由体检规则 R-CRS-001 列为阻断项，不在这里替用户猜。
  if (srcEpsg === 4326 || srcEpsg === null) {
    const gt = j.geoTransform;
    const width = j.size?.[0] ?? 0;
    const height = j.size?.[1] ?? 0;
    const originX = gt[0] ?? 0;
    const originY = gt[3] ?? 0;
    const pixelW = gt[1] ?? 0;
    const pixelH = gt[5] ?? 0;
    const x0 = originX;
    const y0 = originY + height * pixelH;
    const x1 = originX + width * pixelW;
    const y1 = originY;
    return {
      bbox: assertBox([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)], '栅格范围'),
      sourceEpsg: srcEpsg,
      reprojected: false,
    };
  }

  // 需要重投影：warp 成 4326 的 VRT（VRT 不落像元，很快），再读它的角点。
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const outDir = mkdtempSync(join(tmpdir(), 'cartouche-extent-'));
  const vrt = join(outDir, 'extent.vrt');
  try {
    const warp = await gdal.warp(['-t_srs', 'EPSG:4326', '-of', 'VRT', path, vrt]);
    if (!warp.ok) throw new DatasetExtentError(`重投影失败：${path}`, warp.stderr);
    if (!existsSync(vrt)) throw new DatasetExtentError(`重投影命令成功但没有产出文件：${path}`, warp.stderr);

    const info = await gdal.info(vrt, ['-json']);
    if (!info.ok) throw new DatasetExtentError(`读取重投影结果失败：${path}`, info.stderr);
    const parsed = JSON.parse(info.stdout) as {
      cornerCoordinates?: Record<string, [number, number]>;
    };
    const cc = parsed.cornerCoordinates;
    if (!cc) throw new DatasetExtentError('重投影结果里没有角点坐标');
    const xs: number[] = [];
    const ys: number[] = [];
    for (const key of ['upperLeft', 'upperRight', 'lowerLeft', 'lowerRight']) {
      const p = cc[key];
      if (!p) continue;
      xs.push(p[0]);
      ys.push(p[1]);
    }
    const bbox: BBox4326 = [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ];
    return { bbox: assertBox(bbox, '栅格范围（重投影后）'), sourceEpsg: srcEpsg, reprojected: true };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** 矢量：ogrinfo -json → geometryFields[].extent；不在 4326 就 ogr2ogr 转过去再问一次。 */
async function vectorExtent(
  gdal: GdalTools,
  path: string,
): Promise<{ bbox: BBox4326; sourceEpsg: number | null; reprojected: boolean } | null> {
  const res = await gdal.ogrInfo(['-json', '-al', '-so', path]);
  if (!res.ok) return null;

  let j: {
    layers?: {
      geometryFields?: {
        extent?: number[];
        coordinateSystem?: { wkt?: string; projjson?: unknown };
      }[];
    }[];
  };
  try {
    j = JSON.parse(res.stdout) as typeof j;
  } catch {
    return null;
  }

  const fields = (j.layers ?? []).flatMap((l) => l.geometryFields ?? []);
  const withExtent = fields.filter((f) => Array.isArray(f.extent) && f.extent.length === 4);
  if (withExtent.length === 0) return null;

  const srcEpsg =
    epsgFromProjJson(withExtent[0]!.coordinateSystem) ??
    epsgFromWkt(withExtent[0]!.coordinateSystem?.wkt);

  const readExtents = (): BBox4326[] =>
    withExtent.map((f) => {
      const e = f.extent as number[];
      return [e[0]!, e[1]!, e[2]!, e[3]!] as BBox4326;
    });

  if (srcEpsg === 4326) {
    return { bbox: unionBox(readExtents()), sourceEpsg: srcEpsg, reprojected: false };
  }

  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const outDir = mkdtempSync(join(tmpdir(), 'cartouche-extent-'));
  const geojson = join(outDir, 'extent.geojson');
  try {
    // ⚠️ ogr2ogr 的参数顺序是 **dst 在前、src 在后**（与 ogrinfo 相反）。
    const conv = await gdal.ogr2ogr(['-f', 'GeoJSON', '-t_srs', 'EPSG:4326', geojson, path]);
    if (!conv.ok) throw new DatasetExtentError(`重投影失败：${path}`, conv.stderr);
    if (!existsSync(geojson)) throw new DatasetExtentError(`重投影命令成功但没有产出文件：${path}`, conv.stderr);

    const info = await gdal.ogrInfo(['-json', '-al', '-so', geojson]);
    if (!info.ok) throw new DatasetExtentError(`读取重投影结果失败：${path}`, info.stderr);
    const parsed = JSON.parse(info.stdout) as {
      layers?: { geometryFields?: { extent?: number[] }[] }[];
    };
    const boxes = (parsed.layers ?? [])
      .flatMap((l) => l.geometryFields ?? [])
      .filter((f) => Array.isArray(f.extent) && f.extent.length === 4)
      .map((f) => {
        const e = f.extent as number[];
        return [e[0]!, e[1]!, e[2]!, e[3]!] as BBox4326;
      });
    if (boxes.length === 0) throw new DatasetExtentError('重投影结果里没有范围');
    return { bbox: unionBox(boxes), sourceEpsg: srcEpsg, reprojected: true };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * 查一个数据集的地理范围（EPSG:4326）。
 *
 * 先当栅格试，不行再当矢量试——与体检模块 probeDataset 的顺序一致。
 */
export async function datasetExtent(
  loc: GdalLocation,
  options: DatasetExtentOptions,
): Promise<DatasetExtentResult> {
  const gdal = tools(loc);

  const raster = await rasterExtent(gdal, options.path);
  if (raster) return { bbox: raster.bbox, kind: 'raster', sourceEpsg: raster.sourceEpsg, reprojected: raster.reprojected };

  const vector = await vectorExtent(gdal, options.path);
  if (vector) return { bbox: vector.bbox, kind: 'vector', sourceEpsg: vector.sourceEpsg, reprojected: vector.reprojected };

  throw new DatasetExtentError(
    `无法确定数据集的地理范围（既不是可定位的栅格，也没有矢量几何）：${options.path}`,
  );
}
