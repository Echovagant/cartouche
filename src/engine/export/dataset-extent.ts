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

/**
 * 查询数据集地理范围的入参。
 *
 * 只要一个路径：范围由引擎自己去问 GDAL（栅格问 gdalinfo、矢量问 ogrinfo）。
 * 不让调用方自己算 bbox —— 算错了会让画布飞到数据之外，而且这种错很难被用户察觉。
 */
export interface DatasetExtentOptions {
  /** 数据集的绝对路径 */
  readonly path: string;
}

/**
 * 数据集范围的结果。
 *
 * bbox 一律是 EPSG:4326 的经纬度（lon/lat、min/max 序），
 * 前端拿它直接喂 MapLibre 的 fitBounds，不需要在前端再做一次投影换算。
 */
export interface DatasetExtentResult {
  /** EPSG:4326 的 [minX, minY, maxX, maxY]（min/max 序，lon/lat） */
  readonly bbox: BBox4326;
  readonly kind: 'raster' | 'vector';
  /** 源坐标系授权码；拿不到为 null */
  readonly sourceEpsg: number | null;
  /** 是否真的做了重投影（false 表示源本来就是 4326，或源没有坐标系、按目标 CRS 直算） */
  readonly reprojected: boolean;
  /**
   * 源文件字节数（拿不到为 null）。
   *
   * 前端靠它判断"整层显示是否注定失败"：5 GB 的矢量直接走按需瓦片，
   * 不做一次注定超出显示上限的全量转换。
   */
  readonly bytes: number | null;
  /** 矢量源的图层名（保持文件内顺序；栅格没有） */
  readonly layerNames?: readonly string[];
}

/**
 * 范围探测失败。
 *
 * 带着 GDAL 的原始 stderr：探测失败的真实原因（文件被锁、缺驱动、格式不支持）
 * 只在原始输出里说得清楚，转成人话之前得先把证据留住。
 */
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
): Promise<{
  bbox: BBox4326;
  sourceEpsg: number | null;
  reprojected: boolean;
  layerNames: readonly string[];
} | null> {
  const res = await gdal.ogrInfo(['-json', '-al', '-so', path]);
  if (!res.ok) return null;

  let j: {
    layers?: {
      name?: string;
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

  const layerNames = (j.layers ?? [])
    .map((l) => l?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
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
    return {
      bbox: unionBox(readExtents()),
      sourceEpsg: srcEpsg,
      reprojected: false,
      layerNames,
    };
  }

  /**
   * 投影源：只把**范围角点**投到 4326，而不是把整个数据集转一遍。
   *
   * 原做法（整份转成 GeoJSON 再读范围）在 5 GB 的投影矢量上要全量解析，
   * 分钟到小时级 —— 而范围只是给画布 fitBounds 用的，不值得为它转整份数据。
   * 每层取 5×5 个格点（含四角）投过去再取包围盒：范围会比要素真实范围略大
   * （轴对齐的投影包围盒投回经纬度后是个旋转矩形，再取轴对齐包围盒），
   * 误差量级是「子午线收敛角 × 范围对角线」，对把视野移到数据上完全够用。
   */
  const { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const outDir = mkdtempSync(join(tmpdir(), 'cartouche-extent-'));
  const src = join(outDir, 'corners.geojson');
  const out = join(outDir, 'corners-4326.geojson');
  try {
    const points: Array<[number, number]> = [];
    for (const [minX, minY, maxX, maxY] of readExtents()) {
      for (let i = 0; i <= 4; i += 1) {
        for (let j = 0; j <= 4; j += 1) {
          points.push([minX + ((maxX - minX) * i) / 4, minY + ((maxY - minY) * j) / 4]);
        }
      }
    }
    writeFileSync(
      src,
      JSON.stringify({
        type: 'FeatureCollection',
        features: points.map(([x, y]) => ({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [x, y] },
        })),
      }),
    );

    // ⚠️ ogr2ogr 的参数顺序是 **dst 在前、src 在后**（与 ogrinfo 相反）。
    const args: string[] = ['-f', 'GeoJSON', '-t_srs', 'EPSG:4326'];
    const srs = srcEpsg !== null ? `EPSG:${srcEpsg}` : withExtent[0]!.coordinateSystem?.wkt;
    if (srs) args.push('-s_srs', srs);
    args.push(out, src);
    const conv = await gdal.ogr2ogr(args);
    if (!conv.ok) throw new DatasetExtentError(`范围重投影失败：${path}`, conv.stderr);
    if (!existsSync(out)) throw new DatasetExtentError(`重投影命令成功但没有产出文件：${path}`, conv.stderr);

    const parsed = JSON.parse(readFileSync(out, 'utf8')) as {
      features?: { geometry?: { coordinates?: [number, number] } }[];
    };
    const coords = (parsed.features ?? [])
      .map((f) => f.geometry?.coordinates)
      .filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (coords.length === 0) throw new DatasetExtentError('重投影结果里没有范围');
    const xs = coords.map((p) => p[0]);
    const ys = coords.map((p) => p[1]);
    return {
      bbox: assertBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], '矢量范围（重投影后）'),
      sourceEpsg: srcEpsg,
      reprojected: true,
      layerNames,
    };
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
  const { statSync } = await import('node:fs');
  // 目录型数据源（FileGDB）拿不到有意义的字节数 → null，由调用方按"未知"处理
  let bytes: number | null = null;
  try {
    const st = statSync(options.path);
    bytes = st.isFile() ? st.size : null;
  } catch {
    bytes = null;
  }

  const raster = await rasterExtent(gdal, options.path);
  if (raster) {
    return {
      bbox: raster.bbox,
      kind: 'raster',
      sourceEpsg: raster.sourceEpsg,
      reprojected: raster.reprojected,
      bytes,
    };
  }

  const vector = await vectorExtent(gdal, options.path);
  if (vector) {
    return {
      bbox: vector.bbox,
      kind: 'vector',
      sourceEpsg: vector.sourceEpsg,
      reprojected: vector.reprojected,
      bytes,
      ...(vector.layerNames.length ? { layerNames: vector.layerNames } : {}),
    };
  }

  throw new DatasetExtentError(
    `无法确定数据集的地理范围（既不是可定位的栅格，也没有矢量几何）：${options.path}`,
  );
}
