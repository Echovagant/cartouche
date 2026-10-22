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
import { tools, type GdalTools, type ToolResult } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';
import { MAX_SAMPLE, pixelTypeFromGdal, type PixelType } from '../raster/pixels.ts';

/** [minX, minY, maxX, maxY]，EPSG:4326（经纬度）。
 *  ⚠️ 用的是**通用 bbox 约定**（min/max 序），不是 GDAL 的 ulx/uly/lrx/lry 序。
 *  前端 `map.getBounds()` 给的正是这个序，服务端负责转成 GDAL 的顺序。 */
export type BBox4326 = readonly [number, number, number, number];

/** 显示拉伸档位。 */
export type RasterStretch = 'auto' | 'none';

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
  /**
   * 显示拉伸档位：
   *  - 'auto'：按这一窗口的实际值域拉伸到 0~255（默认，ArcGIS Pro 的默认行为）
   *  - 'none'：不拉伸 —— 8 位原样输出；16 位按 0~65535 固定映射到 0~255
   * 不给时由引擎按源类型决定：8 位 → 'none'（保持现状），16 位 → 'auto'
   */
  readonly stretch?: RasterStretch;
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

/** 取源数据集的第一个波段类型（Byte / UInt16 …）；拿不到返回 null。 */
async function sourceBandType(gdal: GdalTools, path: string): Promise<string | null> {
  const res = await gdal.info(path, ['-json']);
  if (!res.ok) return null;
  try {
    const j = JSON.parse(res.stdout) as { bands?: { type?: string }[] };
    return j.bands?.[0]?.type ?? null;
  } catch {
    return null;
  }
}

/**
 * 取一张栅格的第一个波段的实际值域。
 *
 * 必须针对**窗口自己的那张图**（中间瓦片）取，而不是整幅：
 * 整幅的值域可能比当前窗口宽得多（比如整图 0~3000、窗口只有 0~1000），
 * 按整幅拉伸的话，窗口里的画面永远是暗的。
 */
async function bandStats(gdal: GdalTools, tile: string): Promise<{ min: number; max: number }> {
  // -stats 会计算统计量；它会在瓦片旁写 .aux.xml —— 瓦片在临时目录里，随目录一起清掉
  const res = await gdal.info(tile, ['-json', '-stats']);
  if (!res.ok) throw new RasterRenderError(`读取栅格统计量失败：${tile}`, res.stderr);
  let j: { bands?: { minimum?: number; maximum?: number }[] };
  try {
    j = JSON.parse(res.stdout);
  } catch {
    throw new RasterRenderError(
      `无法解析栅格统计量（gdalinfo -stats 输出不是合法 JSON）：${tile}`,
      res.stdout,
    );
  }
  const band = j.bands?.[0];
  if (!band || band.minimum === undefined || band.maximum === undefined) {
    throw new RasterRenderError(
      `无法取得栅格值域（gdalinfo -stats 没给 minimum/maximum）：${tile}`,
      res.stdout,
    );
  }
  return { min: band.minimum, max: band.maximum };
}

/** 输出类型固定成 8 位（PNG 的通道是 8 位的，浏览器侧只认这个）。 */
const BYTE_OUTPUT = Object.freeze(['-ot', 'Byte']);

/** 16 位 → 8 位的**固定全量程**换算：屏幕亮度严格等于文件数值（代价是很暗）。 */
const FULL_RANGE = Object.freeze(['-scale', '0', String(MAX_SAMPLE.UInt16), '0', '255']);

/**
 * 决定用哪一档拉伸。
 *
 * 默认：8 位维持现状（不拉伸），16 位按实际值域拉伸（ArcGIS Pro 的默认行为）。
 * 源类型拿不到时按 8 位处理 —— 那时渲染命令自己会失败，错误消息才是真正有用的那条。
 */
function resolveStretch(
  requested: RasterStretch | undefined,
  pixelType: PixelType | null,
): RasterStretch {
  if (requested !== undefined) {
    if (requested !== 'auto' && requested !== 'none') {
      throw new Error(
        `不支持的拉伸档位「${String(requested)}」：只能是 'auto'（按实际值域拉伸）或 'none'（固定全量程）`,
      );
    }
    return requested;
  }
  return pixelType === 'UInt16' ? 'auto' : 'none';
}

/**
 * 拼渲染命令的参数。
 *
 * format 与 scaleArgs 是唯一跟"输出"有关的两处改动点：
 *  - format='PNG' 且 scaleArgs 为空 → 与改动前那条命令**逐字一致**（8 位默认路径必须如此）；
 *  - scaleArgs 给 ['-ot','Byte','-scale',…] → 16 位源出 PNG 时降位并重标定。
 *
 * ⚠️ gdalwarp **没有 -scale**：重投影那条路不能靠 scaleArgs，只能先落中间瓦片再 translate。
 */
function renderArgs(
  options: RasterRenderOptions,
  width: number,
  height: number,
  needReproject: boolean,
  format: string,
  out: string,
  scaleArgs: readonly string[] = [],
): string[] {
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
    args.push('-of', format, options.path, out);
  } else {
    // translate：直接按源 CRS 裁切窗口
    args = ['-of', format, ...scaleArgs, '-outsize', String(width), String(height)];
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
  return args;
}

/** 读出渲染产物。两条错误信息是既有用例的契约，逐字保留。 */
async function readRenderedPng(res: ToolResult, out: string, path: string): Promise<Uint8Array> {
  const { readFileSync, existsSync } = await import('node:fs');
  if (!res.ok) throw new RasterRenderError(`栅格渲染失败：${path}`, res.stderr);
  if (!existsSync(out)) {
    throw new RasterRenderError(`渲染命令成功但没有产出 PNG：${path}`, res.stderr);
  }
  return new Uint8Array(readFileSync(out));
}

/**
 * 落一张中间瓦片（GTiff，保留源类型）。
 *
 * 为什么要有这一步：
 *  - 'auto' 档要按**窗口自己的**值域拉伸，统计量只能从这张瓦片上取；
 *  - gdalwarp 没有 -scale，16 位源走重投影时也必须先落瓦片再 translate 出 PNG。
 */
async function makeTile(
  gdal: GdalTools,
  options: RasterRenderOptions,
  width: number,
  height: number,
  needReproject: boolean,
  tile: string,
): Promise<void> {
  const { existsSync } = await import('node:fs');
  const args = renderArgs(options, width, height, needReproject, 'GTiff', tile);
  const res = needReproject ? await gdal.warp(args) : await gdal.translate(args);
  if (!res.ok) throw new RasterRenderError(`栅格渲染失败：${options.path}`, res.stderr);
  if (!existsSync(tile)) {
    throw new RasterRenderError(`渲染命令成功但没有产出中间瓦片：${options.path}`, res.stderr);
  }
}

/**
 * 用 gdal_translate 把栅格渲染成 PNG。
 *
 * 两条路：
 *  - **源与目标同 CRS** → `gdal_translate -projwin`（直接裁切，无重采样，最精确）
 *  - **需要重投影** → `gdalwarp -t_srs -te -ts`（gdal_translate **没有 -t_srs**，
 *    投影坐标系的源必须走 warp；否则会出图错位）
 *
 * 显示档位（stretch）：
 *  - PNG 的通道只有 8 位，而 16 位影像是常见底图来源。GDAL 的 PNG 驱动对 16 位源
 *    **默认输出 16 位 PNG**，浏览器/纹理侧的 16→8 降位行为不可控。
 *  - 只给 `-ot Byte` 更糟：那是**静默饱和**，65535 被压成 255，退出码仍是 0、stderr 也是空的
 *    （实测 GDAL 3.13.3）。所以降位必须跟 `-scale` 一起给。
 *  - 'auto'（16 位的默认）：按**这一窗口**的实际值域拉伸到 0~255，画面能用；
 *  - 'none'：固定全量程 0~65535 → 0~255，屏幕亮度严格等于文件数值（代价是很暗）。
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

  // 源类型决定默认档位，也决定 16 位要不要显式降位。
  // ⚠️ gdalinfo 本身失败（比如文件不存在）时**不报错**：让渲染命令自己去失败，
  //    错误消息仍是既有的「栅格渲染失败：…」，既有用例依赖这一句。
  //    但类型**认识**而**不支持**（Int16 / Float32）必须报错 —— 口径与 pixelTypeFromGdal 一致，
  //    否则渲染层单独放行会让整个引擎的类型口径分裂。
  const rawType = await sourceBandType(gdal, options.path);
  const pixelType: PixelType | null = rawType === null ? null : pixelTypeFromGdal(rawType);
  const stretch = resolveStretch(options.stretch, pixelType);

  const { rmSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const outDir = mkdtempSync(join(tmpdir(), 'cartouche-render-'));
  const out = join(outDir, 'render.png');

  try {
    /* ── 8 位（或类型未知）+ 'none'：单条命令，输出与改动前完全一致 ──
       绝大多数情况走这里：一个字节都不多写。 */
    if (stretch === 'none' && pixelType !== 'UInt16') {
      const args = renderArgs(options, width, height, needReproject, 'PNG', out);
      const res = needReproject ? await gdal.warp(args) : await gdal.translate(args);
      const png = await readRenderedPng(res, out, options.path);
      return {
        png,
        width,
        height,
        command: [needReproject ? 'gdalwarp' : 'gdal_translate', ...args],
      };
    }

    /* ── 16 位 + 'none'：固定全量程 0~65535 → 0~255 ── */
    if (stretch === 'none') {
      // 不重投影：单条命令即可。-ot Byte 后面**必须**跟 -scale，
      // 只给 -ot Byte 会把 16 位静默饱和成 255（实测 GDAL 3.13.3）。
      if (!needReproject) {
        const args = renderArgs(options, width, height, false, 'PNG', out, [
          ...BYTE_OUTPUT,
          ...FULL_RANGE,
        ]);
        const res = await gdal.translate(args);
        const png = await readRenderedPng(res, out, options.path);
        return { png, width, height, command: ['gdal_translate', ...args] };
      }
      // 重投影：gdalwarp 没有 -scale，只能先落中间瓦片再 translate 出 PNG。
      const tile = join(outDir, 'tile.tif');
      await makeTile(gdal, options, width, height, true, tile);
      const args = ['-of', 'PNG', ...BYTE_OUTPUT, ...FULL_RANGE, tile, out];
      const res = await gdal.translate(args);
      const png = await readRenderedPng(res, out, options.path);
      return { png, width, height, command: ['gdal_translate', ...args] };
    }

    /* ── 'auto'：两步 —— 先落中间瓦片，取瓦片值域，再出 8 位 PNG ── */
    const tile = join(outDir, 'tile.tif');
    await makeTile(gdal, options, width, height, needReproject, tile);
    const { min, max } = await bandStats(gdal, tile);
    // 瓦片是常量图时拉伸没有意义（GDAL 会除以 0），退回「固定全量程」那条规则：
    // 8 位原样输出、16 位按 0~65535 → 0~255 —— 宁可暗，也不要一张全黑的图。
    const scale =
      min === max
        ? pixelType === 'Byte'
          ? []
          : [...FULL_RANGE]
        : ['-scale', String(min), String(max), '0', '255'];
    const args = ['-of', 'PNG', ...BYTE_OUTPUT, ...scale, tile, out];
    const res = await gdal.translate(args);
    const png = await readRenderedPng(res, out, options.path);
    return { png, width, height, command: ['gdal_translate', ...args] };
  } finally {
    // 临时目录连同 .aux.xml 一起清掉
    rmSync(outDir, { recursive: true, force: true });
  }
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
