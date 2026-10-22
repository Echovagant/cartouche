/**
 * （服务端部分）：把栅格渲染成 PNG 底图。
 *
 * 出图链路（本项目的最终形态）：
 *
 *   服务端 GDAL 出**栅格底图 PNG**  →  前端 MapLibre 叠加矢量层与图面要素
 *   →  canvas 上合成  →  canvas.toDataURL('image/jpeg')  →  服务端封装成 PDF
 *
 * 为什么服务端只出 PNG、不直接出 PDF：
 *   - GDAL 的 PDF 驱动在本机 conda 构建里**不存在**（只有 PNG / JPEG / JPEGXL）；
 *   - 图面要素（比例尺、图例、指北针、图框、标题栏）由**前端 canvas** 绘制，
 *     这样中文字体正常（PDF 内嵌字体是另一条路），且与用户在屏幕上看到的完全一致。
 *
 * 栅格底图的请求窗口用 **EPSG:4326（经纬度）**表达，前端从 MapLibre 的
 * `map.getBounds()` 直接换算即可，不需要在前端做投影计算。
 */
import { join } from 'node:path';
import { tools, type GdalTools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';

/** [minX, minY, maxX, maxY]，EPSG:4326（经纬度）。
 *  ⚠️ 用的是**通用 bbox 约定**（min/max 序），不是 GDAL 的 ulx/uly/lrx/lry 序。
 *  前端 `map.getBounds()` 给的正是这个序，服务端负责转成 GDAL 的顺序。 */
export type BBox4326 = readonly [number, number, number, number];

export interface RasterRenderOptions {
  /** 栅格的绝对路径 */
  readonly path: string;
  /** 输出像素宽 */
  readonly width: number;
  /** 输出像素高 */
  readonly height: number;
  /** 取景窗口（EPSG:4326）；不给就出整幅 */
  readonly bbox?: BBox4326;
  /** 输出坐标系；默认与源一致 */
  readonly targetCrs?: string;
  /** 重采样方式，默认 bilinear */
  readonly resample?: 'nearest' | 'bilinear' | 'cubic' | 'average';
  /** 选波段，如 [1,2,3] 变 RGB；不给就全部 */
  readonly bands?: readonly number[];
}

export interface RasterRenderResult {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** 实际使用的命令，便于排查 */
  readonly command: readonly string[];
}

export class RasterRenderError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = 'RasterRenderError';
    this.stderr = stderr;
  }
}

/** 校验 bbox，避免把非法窗口递给 GDAL。
 *  约定是 [minX, minY, maxX, maxY]（通用 bbox 序），所以这里要求 maxX>minX 且 maxY>minY。 */
function assertBBox(bbox: BBox4326): void {
  const [minX, minY, maxX, maxY] = bbox;
  for (const v of [minX, minY, maxX, maxY]) {
    if (!Number.isFinite(v)) throw new Error(`bbox 含非法数值：${bbox.join(', ')}`);
  }
  if (maxX <= minX || maxY <= minY) {
    throw new Error(
      `bbox 的范围不合法（要求 minX<maxX 且 minY<maxY，顺序为 [minX,minY,maxX,maxY]）：${bbox.join(', ')}`,
    );
  }
}

/** 从 "EPSG:4326" 里取数字部分 */
function epsgOf(crs: string | undefined): number | undefined {
  if (!crs) return undefined;
  const m = /^EPSG:(\d+)$/i.exec(crs.trim());
  return m ? Number(m[1]) : undefined;
}

/** 取源数据集的 EPSG 授权码（拿不到返回 null） */
async function sourceEpsg(gdal: GdalTools, path: string): Promise<number | null> {
  const res = await gdal.info(path, ['-json']);
  if (!res.ok) return null;
  try {
    const j = JSON.parse(res.stdout) as { coordinateSystem?: { wkt?: string } };
    const wkt = j.coordinateSystem?.wkt ?? '';
    // ⚠️ 必须取**最后一个** ID["EPSG",N]：
    //    投影坐标系的 WKT 里，BASEGEOGCRS 自带的 ID（基准地理 CRS，如 4326）
    //    排在前面，而投影 CRS 自己的 ID（如 32631）在最后。
    //    取第一个会把 UTM 图误判成 4326 —— 然后错误地走"不重投影"那条路。
    const ids = [...wkt.matchAll(/ID\["EPSG",(\d+)\]/g)].map((m) => Number(m[1]));
    return ids.length > 0 ? ids[ids.length - 1]! : null;
  } catch {
    return null;
  }
}

/**
 * 用 gdal_translate 把栅格渲染成 PNG。
 *
 * 两条路：
 *  - **源与目标同 CRS** → `gdal_translate -projwin`（直接裁切，无重采样，最精确）
 *  - **需要重投影** → `gdalwarp -t_srs -te -ts`（gdal_translate **没有 -t_srs**，
 *    投影坐标系的源必须走 warp；否则会出图错位）
 */
export async function renderRasterPng(
  loc: GdalLocation,
  options: RasterRenderOptions,
): Promise<RasterRenderResult> {
  const gdal: GdalTools = tools(loc);
  const width = Math.max(1, Math.round(options.width));
  const height = Math.max(1, Math.round(options.height));

  if (options.bbox) assertBBox(options.bbox);

  const srcEpsg = await sourceEpsg(gdal, options.path);
  const dstEpsg = epsgOf(options.targetCrs);
  const needReproject =
    dstEpsg !== undefined && srcEpsg !== null && srcEpsg !== dstEpsg;

  const { readFileSync, rmSync, existsSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const outDir = mkdtempSync(join(tmpdir(), 'cartouche-render-'));
  const out = join(outDir, 'render.png');

  let args: string[];
  if (needReproject) {
    // warp：-te 用目标 CRS 的 minx miny maxx maxy，-ts 给输出像素尺寸
    args = ['-t_srs', options.targetCrs!, '-ts', String(width), String(height)];
    if (options.bbox) {
      const [minX, minY, maxX, maxY] = options.bbox;
      args.push('-te', String(minX), String(minY), String(maxX), String(maxY));
    }
    if (options.resample) args.push('-r', options.resample);
    for (const b of options.bands ?? []) args.push('-b', String(b));
    args.push('-of', 'PNG', options.path, out);
  } else {
    // translate：直接按源 CRS 裁切窗口
    args = ['-of', 'PNG', '-outsize', String(width), String(height)];
    if (options.bbox) {
      const [minX, minY, maxX, maxY] = options.bbox;
      // GDAL 的 -projwin 用「左上角在前」：ulx=minX, uly=maxY, lrx=maxX, lry=minY
      args.push('-projwin', String(minX), String(maxY), String(maxX), String(minY));
      args.push('-projwin_srs', 'EPSG:4326');
    }
    if (options.resample) args.push('-r', options.resample);
    for (const b of options.bands ?? []) args.push('-b', String(b));
    args.push(options.path, out);
  }

  const res = needReproject
    ? await gdal.warp(args)
    : await gdal.translate(args);

  if (!res.ok) {
    rmSync(outDir, { recursive: true, force: true });
    throw new RasterRenderError(`栅格渲染失败：${options.path}`, res.stderr);
  }
  if (!existsSync(out)) {
    rmSync(outDir, { recursive: true, force: true });
    throw new RasterRenderError(`渲染命令成功但没有产出 PNG：${options.path}`, res.stderr);
  }
  const png = new Uint8Array(readFileSync(out));
  rmSync(outDir, { recursive: true, force: true });

  return {
    png,
    width,
    height,
    command: [needReproject ? 'gdalwarp' : 'gdal_translate', ...args],
  };
}

/**
 * 从 PNG 头里读出宽高（IHDR），免去再解析一次文件。
 */
export function readPngSize(png: Uint8Array): { width: number; height: number } | null {
  // PNG 签名 8 字节 + IHDR chunk：长度(4) 类型(4) 宽(4) 高(4)
  if (png.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) if (png[i] !== sig[i]) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) return null;
  return { width, height };
}
