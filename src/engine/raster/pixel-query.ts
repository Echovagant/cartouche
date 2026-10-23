/**
 * 经纬度 → 原生像元的换算（引擎侧）。
 *
 * 为什么必须由引擎来做：
 *   画布上的点是**经纬度**（4326），栅格的像元是**原生坐标**
 *   （投影坐标系的栅格里是米，不是度）。前端没有投影能力，
 *   硬拿经纬度去按 geotransform 反算，结果是"看起来画上了、其实画到天边去"——
 *   这类错误用户发现不了，所以宁可不提供这个能力，也不能给一个错的。
 *
 * 换算分两步：
 *   1. 投影：4326 → 栅格自己的坐标系（PROJ 干这件事，精度到 1e-9 像元）
 *   2. 仿射反算：原生 x/y → col/row
 *
 * 第 2 步的公式与前端 `web/app/canvas/editGeometry.ts` 的 `pixelFromLngLat`
 * **完全一致**（同一个行列式反解），只是输入换成了原生坐标。
 *
 * 为什么用 ogr2ogr 而不是 gdaltransform：
 *   gdaltransform 只从 **stdin** 读坐标，而 `runTool` 用的是 `execFile`，
 *   它既不能喂 stdin 也不会替我们关掉 stdin —— 实测（2026-10-23）传 `input`
 *   无效、子进程会一直等 EOF 直到超时。
 *   ogr2ogr 走的是"文件进、文件出"：把点写成 GeoJSON，指定 `-t_srs` 输出，
 *   坐标按 15 位小数写出（远高于 1e-6 像元的要求），一次进程换算任意多个点。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tools } from '../gdal/runner.ts';
import { isLongitudeLatitude, probeDataset, type CrsInfo } from '../gdal/probe.ts';
import type { GdalLocation } from '../gdal/env.ts';

/** 原生像元坐标（可为小数，与 GDAL 的行列序一致：行号向下增长） */
export interface PixelPoint {
  readonly col: number;
  readonly row: number;
}

/** 一次换算的输入 */
export interface PixelQueryRequest {
  /** 栅格的绝对路径 */
  readonly path: string;
  /** 待换算的点：[经度, 纬度]（EPSG:4326，经度在前） */
  readonly points: readonly (readonly [number, number])[];
  /**
   * 允许点落在影像范围之外（默认不允许）。
   *
   * 为什么要这个开关：视窗的四个角通常在影像之外（地图视野比影像大），
   * 而笔宽换算恰恰需要这四个角。默认仍然是"越界即报错"，
   * 需要跨出影像边界的调用方才显式打开。
   */
  readonly allowOutside?: boolean;
}

/** 一次换算的结果 */
export interface PixelQueryResult {
  readonly pixels: readonly PixelPoint[];
  readonly width: number;
  readonly height: number;
  /** GDAL 六元仿射：[originX, pixelWidth, rotX, originY, rotY, pixelHeight] */
  readonly geotransform: readonly number[];
  /** 实际用到的坐标系；'EPSG:4326' 表示经纬度本身就是原生坐标（没做投影） */
  readonly crs: string;
  /** 是否真的做了投影换算（false = 栅格本来就是经纬度） */
  readonly projected: boolean;
}

/** 一次最多换算多少个点（防止一次请求拖垮引擎） */
const MAX_POINTS = 2048;

/** 越界判定的容差（像元） */
const OUTSIDE_EPS = 1e-6;

/**
 * 请求本身有问题（点不合法、栅格没坐标系、点在影像外……）。
 *
 * 用 `name` 而不是类本身打标记：服务层不必 import 这个类
 * （引擎的公开出口由上层维护，不便为它新增导出），
 * 靠 `err.name` 就能把"请求不合法"（400）与"服务端出故障"（500）分开。
 */
export class PixelQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PixelQueryError';
  }
}

/**
 * 仿射反算：原生 x/y → col/row。
 *
 * geotransform = [originX, pixelWidth, rotX, originY, rotY, pixelHeight]，GDAL 的行列序：
 *   x = originX + col*pixelWidth + row*rotX
 *   y = originY + col*rotY   + row*pixelHeight
 * 反解用行列数。北-up 的栅格（rotX = rotY = 0）退化成
 *   col = (x - originX) / pixelWidth
 *   row = (y - originY) / pixelHeight
 */
export function pixelFromNative(
  geotransform: readonly number[],
  x: number,
  y: number,
): PixelPoint | null {
  const [ox, pw, rx, oy, ry, ph] = geotransform;
  if (
    ox === undefined ||
    pw === undefined ||
    rx === undefined ||
    oy === undefined ||
    ry === undefined ||
    ph === undefined
  ) {
    return null;
  }
  const det = pw * ph - rx * ry;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) return null;
  const dx = x - ox;
  const dy = y - oy;
  const col = (ph * dx - rx * dy) / det;
  const row = (-ry * dx + pw * dy) / det;
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  return { col, row };
}

/**
 * 从 WKT 里抠出 EPSG 代码。
 *
 * 为什么需要：GDAL 的 `gdalinfo -json` 对不少文件**只给 WKT、不给 id**
 * （`coordinateSystem.id` 是 undefined），而 WKT 自己的末尾带着
 * `ID["EPSG",4547]`（WKT2）或 `AUTHORITY["EPSG","4547"]`（WKT1）。
 * 抠出来的好处：交给 PROJ 的是 `EPSG:4547` 这种短形式，
 * 比一整段 WKT 更不容易在 PROJ 版本之间出岔子。
 *
 * 取**最后一个**匹配的代码：投影坐标系的 WKT 里，
 * 基准地理坐标系也会带一个自己的 EPSG（如 4547 的 WKT 里有 4490），
 * 最后一个才是这个坐标系自己的。
 */
function epsgFromWkt(wkt: string): number | null {
  const wkt2 = [...wkt.matchAll(/ID\s*\[\s*"EPSG"\s*,\s*(\d+)\s*\]/g)].map((m) => Number(m[1]));
  if (wkt2.length > 0) return wkt2[wkt2.length - 1] as number;
  const wkt1 = [...wkt.matchAll(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"(\d+)"\s*\]/g)].map((m) => Number(m[1]));
  if (wkt1.length > 0) return wkt1[wkt1.length - 1] as number;
  return null;
}

/**
 * 栅格自己的坐标系怎么表达（给 PROJ 用）。
 *
 * 优先给 `EPSG:<code>`：短、可读、PROJ 认得。
 * 只有 WKT 时就用 WKT —— PROJ 也认 WKT，只是长一点。
 * 两样都没有 → 这个栅格没法做投影换算（说清楚，而不是瞎算）。
 */
function targetCrsOf(crs: CrsInfo): string {
  if (typeof crs.epsg === 'number' && Number.isFinite(crs.epsg)) return `EPSG:${crs.epsg}`;
  if (crs.wkt && crs.wkt.trim() !== '') {
    const code = epsgFromWkt(crs.wkt);
    if (code !== null) return `EPSG:${code}`;
    return crs.wkt;
  }
  throw new PixelQueryError(
    '这个栅格没有坐标系信息，没法把经纬度换算到它的原生坐标：' +
      '请先给它配上坐标系（EPSG 代码或 WKT）再来画',
  );
}

/**
 * 4326 → 原生坐标系（一次进程、任意多个点）。
 *
 * 走 ogr2ogr：点写成 GeoJSON（RFC 7946 = WGS 84，经度在前），
 * `-t_srs` 指定目标坐标系，输出的坐标按 15 位小数写出。
 */
async function transformToNative(
  loc: GdalLocation,
  points: readonly (readonly [number, number])[],
  targetCrs: string,
): Promise<readonly (readonly [number, number])[]> {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-pixels-'));
  try {
    const inFile = join(dir, 'points.geojson');
    const outFile = join(dir, 'points-out.geojson');
    writeFileSync(
      inFile,
      JSON.stringify({
        type: 'FeatureCollection',
        features: points.map((p, i) => ({
          type: 'Feature',
          // 带上序号：ogr2ogr 不保证输出顺序，按序号排回来才稳
          properties: { i },
          geometry: { type: 'Point', coordinates: [p[0], p[1]] },
        })),
      }),
      'utf8',
    );

    const gdal = tools(loc);
    const res = await gdal.ogr2ogr([
      '-f',
      'GeoJSON',
      '-t_srs',
      targetCrs,
      '--config',
      'COORDINATE_PRECISION',
      '15',
      outFile,
      inFile,
    ]);
    if (!res.ok) {
      const detail = (res.stderr || res.stdout).trim();
      throw new PixelQueryError(`坐标换算失败（EPSG:4326 → ${targetCrs}）：${detail}`);
    }

    let parsed: { features?: { properties?: { i?: number }; geometry?: { coordinates?: number[] } | null }[] };
    try {
      parsed = JSON.parse(readFileSync(outFile, 'utf8')) as typeof parsed;
    } catch (err) {
      throw new PixelQueryError(`坐标换算失败（EPSG:4326 → ${targetCrs}）：读不出换算结果（${(err as Error).message}）`);
    }
    const features = parsed.features ?? [];
    if (features.length !== points.length) {
      throw new Error(
        `坐标换算失败（EPSG:4326 → ${targetCrs}）：换了 ${features.length} 个点，期望 ${points.length} 个`,
      );
    }
    const ordered = [...features].sort(
      (a, b) => Number(a.properties?.i ?? 0) - Number(b.properties?.i ?? 0),
    );
    return ordered.map((f, i) => {
      const c = f.geometry?.coordinates;
      if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
        throw new PixelQueryError(`坐标换算失败（EPSG:4326 → ${targetCrs}）：第 ${i + 1} 个点没有换算结果`);
      }
      return [c[0] as number, c[1] as number] as const;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 把一组经纬度换算成目标栅格的原生像元坐标。
 *
 * 4326 的栅格走的是同一条路（只是不做投影，坐标直接当原生坐标用），
 * 这样前端只有一套代码，不必自己判断"这张图是不是经纬度"。
 */
export async function queryRasterPixels(
  loc: GdalLocation,
  request: PixelQueryRequest,
): Promise<PixelQueryResult> {
  const points = request.points;
  if (!Array.isArray(points) || points.length === 0) {
    throw new PixelQueryError('没有要换算的点');
  }
  if (points.length > MAX_POINTS) {
    throw new PixelQueryError(`一次最多换算 ${MAX_POINTS} 个点（收到 ${points.length} 个）`);
  }
  points.forEach((p, i) => {
    if (!Array.isArray(p) || p.length < 2) {
      throw new PixelQueryError(`第 ${i + 1} 个点不是合法的经纬度：${JSON.stringify(p)}`);
    }
    const lon = p[0] as number;
    const lat = p[1] as number;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw new PixelQueryError(`第 ${i + 1} 个点不是合法的经纬度：${JSON.stringify(p)}`);
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw new PixelQueryError(`第 ${i + 1} 个点超出经纬度范围：经度 ${lon}、纬度 ${lat}`);
    }
  });

  const probe = await probeDataset(loc, request.path);
  const ds = probe.dataset;
  if (!ds || ds.kind !== 'raster') {
    const detail = probe.error?.raw ? `\n${probe.error.raw}` : '';
    throw new Error(`打不开该栅格：${request.path}${detail}`);
  }
  const gt = ds.geotransform;
  if (!gt || gt.length < 6) {
    throw new PixelQueryError('该栅格没有仿射参数（geotransform），无法把坐标换算成原生像元');
  }

  const is4326 = isLongitudeLatitude(ds.crs, gt);
  const targetCrs = is4326 ? 'EPSG:4326' : targetCrsOf(ds.crs);
  const native = is4326
    ? points.map((p) => [p[0] as number, p[1] as number] as const)
    : await transformToNative(loc, points, targetCrs);

  const pixels: PixelPoint[] = [];
  native.forEach((xy, i) => {
    const px = pixelFromNative(gt, xy[0], xy[1]);
    if (!px) {
      throw new PixelQueryError(`第 ${i + 1} 个点换算出来的像元坐标不是有效数值`);
    }
    pixels.push(px);
  });

  if (!request.allowOutside) {
    pixels.forEach((px, i) => {
      const offCol = px.col < -OUTSIDE_EPS || px.col > ds.width + OUTSIDE_EPS;
      const offRow = px.row < -OUTSIDE_EPS || px.row > ds.height + OUTSIDE_EPS;
      if (offCol || offRow) {
        throw new PixelQueryError(
          `第 ${i + 1} 个点落在影像范围之外` +
            `（col=${px.col}, row=${px.row}，影像 ${ds.width}×${ds.height}）`,
        );
      }
    });
  }

  return {
    pixels,
    width: ds.width,
    height: ds.height,
    geotransform: [...gt],
    crs: targetCrs,
    projected: !is4326,
  };
}
