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
import {
  MAX_SAMPLE,
  MIN_SAMPLE,
  pixelTypeFromGdal,
  type PixelType,
} from '../raster/pixels.ts';

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

/**
 * 出图的目标格式。
 *
 * 为什么要区分「数据」与「显示」两种导出：
 *   - PNG / JPEG 是**显示**导出：通道只有 8 位，16 位源要按显示档位降位；
 *   - GTiff 是**数据**导出：保留源波段类型与仿射参数，**不做显示拉伸** ——
 *     对一份 16 位影像做「按值域拉伸」再存成 GeoTIFF，存下来的就不是原数据了。
 */
export type RasterOutputFormat = 'PNG' | 'JPEG' | 'GTiff';

export interface RasterBytesResult {
  readonly bytes: Uint8Array;
  readonly format: RasterOutputFormat;
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

/**
 * 源数据集的三项基本信息：坐标系授权码、首个波段类型、仿射参数。
 *
 * 为什么一次 gdalinfo 拿齐三项：出图本来就要开好几个 GDAL 进程，
 * 每多一次 gdalinfo 就多一次进程启动（Windows 上尤其明显）。
 * 三项都出自同一份 -json 输出，取值口径与原先分开调用时完全一致。
 */
interface SourceInfo {
  readonly epsg: number | null;
  readonly bandType: string | null;
  readonly geotransform: readonly number[] | null;
}

/**
 * 探查源数据集。
 *
 * ⚠️ gdalinfo 失败（文件不存在等）时**不报错**，三项一律给 null ——
 * 让渲染命令自己去失败，错误消息仍是既有的「栅格渲染失败：…」，既有用例依赖这一句。
 */
async function probeSource(gdal: GdalTools, path: string): Promise<SourceInfo> {
  const res = await gdal.info(path, ['-json']);
  if (!res.ok) return { epsg: null, bandType: null, geotransform: null };
  let j: {
    coordinateSystem?: { wkt?: string };
    bands?: { type?: string }[];
    geoTransform?: number[];
  };
  try {
    j = JSON.parse(res.stdout) as typeof j;
  } catch {
    return { epsg: null, bandType: null, geotransform: null };
  }
  const wkt = j.coordinateSystem?.wkt ?? '';
  // ⚠️ 必须取**最后一个** ID["EPSG",N]：
  //    投影坐标系的 WKT 里，BASEGEOGCRS 自带的 ID（基准地理 CRS，如 4326）
  //    排在前面，而投影 CRS 自己的 ID（如 32631）在最后。
  //    取第一个会把 UTM 图误判成 4326 —— 然后错误地走"不重投影"那条路。
  const ids = [...wkt.matchAll(/ID\["EPSG",(\d+)\]/g)].map((m) => Number(m[1]));
  return {
    epsg: ids.length > 0 ? ids[ids.length - 1]! : null,
    bandType: j.bands?.[0]?.type ?? null,
    geotransform: Array.isArray(j.geoTransform) ? j.geoTransform : null,
  };
}

/**
 * 南向上（正 NS 分辨率）的源不能走「直接出图」这条路。
 *
 * 结论来自实测（GDAL 3.13.3；8×4 单波段、每行一个可辨认的值 10/11/12/13）：
 *   - **gdal_translate 路**：产物第 0 行 = 源文件第 0 行。
 *     源是南向上时源文件第 0 行在**南边**，于是出来的图是**上下颠倒**的，
 *     而命令退出码是 0、stderr 也是空的 —— 静默给出一张颠倒的地图。
 *   - **gdalwarp 路**：产物第 0 行 = 源文件最后一行。
 *     warp 按坐标重采样、输出恒为北向上，方向是**对的**（同一份数据、同一组像元值）。
 * 所以只有 translate 路会翻转，重投影那条路不需要拦。
 *
 * 为什么不把 warp 路一起拦：拦了等于拒绝一批 GDAL 本来就能正确处理的数据
 * （南向上的投影坐标系栅格），那是无谓的功能损失。
 * 为什么不干脆两条路都放行：translate 路给出一张颠倒的图却报成功，
 * 是最坏的一类错 —— 用户拿到的是颠倒的地图，还会怀疑是自己数据的问题。
 * 与编辑路径（raster/overlay.ts 的 assertNorthUp）保持一致：宁可报错。
 */
function assertNorthUpForRender(gt: readonly number[] | null, path: string): void {
  if (!gt || gt.length < 6) return;
  if ((gt[5] ?? 0) > 0) {
    throw new RasterRenderError(
      `源栅格是南向上（正 NS 分辨率）的栅格：${path}；` +
        '直接出图会把它上下颠倒（gdal_translate 原样复制行序），请先把它转成北向上。',
      '',
    );
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

/**
 * 临时产物的扩展名。
 *
 * 为什么要按格式给扩展名：`-of` 已经指定了驱动，扩展名只影响临时文件本身。
 * 但把 JPEG 字节写进一个叫 render.png 的临时文件，会让排查问题的人以为格式错了。
 */
const FORMAT_EXTENSION: Readonly<Record<RasterOutputFormat, string>> = {
  PNG: 'png',
  JPEG: 'jpg',
  GTiff: 'tif',
};

/**
 * 16 位 → 8 位的**固定全量程**换算：屏幕亮度严格等于文件数值（代价是很暗）。
 *
 * ⚠️ 降位必须跟 `-scale` 一起给：只给 `-ot Byte` 是**静默饱和**
 * （65535 被压成 255，退出码 0、stderr 空，实测 GDAL 3.13.3）。
 */
const FULL_RANGE_16 = Object.freeze(['-scale', '0', String(MAX_SAMPLE.UInt16), '0', '255']);

/**
 * 任意类型 → 8 位的固定全量程换算。
 *
 * 按该类型的**完整值域**换算（有符号类型的下限是负数，浮点的上下限是类型本身的极限）。
 * 32 位与浮点这样换出来几乎是全黑 —— 那正是"固定全量程"该有的样子：
 * 它表示"屏幕亮度严格等于文件数值"，代价就是看不见。
 */
function fullRangeOf(type: PixelType): readonly string[] {
  return ['-scale', String(MIN_SAMPLE[type]), String(MAX_SAMPLE[type]), '0', '255'];
}

/**
 * 决定用哪一档拉伸。
 *
 * 默认：8 位维持现状（不拉伸），其余按实际值域拉伸（ArcGIS Pro 的默认行为）。
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
  // 8 位原样输出就是它的满量程；其余类型（16 位及以上、含 32 位与浮点）
  // 的满量程远大于人眼能分辨的范围，按实际值域拉伸才对得上画面。
  return pixelType === null || pixelType === 'Byte' ? 'none' : 'auto';
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
async function readRenderedBytes(
  res: ToolResult,
  out: string,
  path: string,
  format: RasterOutputFormat,
): Promise<Uint8Array> {
  const { readFileSync, existsSync } = await import('node:fs');
  if (!res.ok) throw new RasterRenderError(`栅格渲染失败：${path}`, res.stderr);
  if (!existsSync(out)) {
    throw new RasterRenderError(`渲染命令成功但没有产出 ${format}：${path}`, res.stderr);
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
 * 用 gdal_translate / gdalwarp 把栅格渲染成目标格式。
 *
 * 两条路：
 *  - **源与目标同 CRS** → `gdal_translate -projwin`（直接裁切，无重采样，最精确）
 *  - **需要重投影** → `gdalwarp -t_srs -te -ts`（gdal_translate **没有 -t_srs**，
 *    投影坐标系的源必须走 warp；否则会出图错位）
 *
 * 显示档位（stretch）只对**显示**导出（PNG / JPEG）有意义：
 *  - PNG / JPEG 的通道只有 8 位，而 16 位影像是常见底图来源。GDAL 的 PNG 驱动对 16 位源
 *    **默认输出 16 位 PNG**，浏览器/纹理侧的 16→8 降位行为不可控。
 *  - 只给 `-ot Byte` 更糟：那是**静默饱和**，65535 被压成 255，退出码仍是 0、stderr 也是空的
 *    （实测 GDAL 3.13.3）。所以降位必须跟 `-scale` 一起给。
 *  - 'auto'（16 位的默认）：按**这一窗口**的实际值域拉伸到 0~255，画面能用；
 *  - 'none'：固定全量程 0~65535 → 0~255，屏幕亮度严格等于文件数值（代价是很暗）。
 *  - GTiff 是数据导出：保留源类型，不拉伸、不降位。
 *
 * ⚠️ 南向上（正 NS 分辨率）的源只在 translate 路上会被静默翻转，
 *    那条路上明确报错 —— 理由与实测数据见 assertNorthUpForRender。
 */
export async function renderRasterBytes(
  loc: GdalLocation,
  options: RasterRenderOptions,
  format: RasterOutputFormat = 'PNG',
): Promise<RasterBytesResult> {
  const gdal: GdalTools = tools(loc);
  const width = Math.max(1, Math.round(options.width));
  const height = Math.max(1, Math.round(options.height));

  if (options.bbox) assertBBox(options.bbox);

  const src = await probeSource(gdal, options.path);
  const dstEpsg = epsgOf(options.targetCrs);
  const needReproject = dstEpsg !== undefined && src.epsg !== null && src.epsg !== dstEpsg;

  // 南向的源只有 translate 路会翻转 —— 只拦这一条（warp 路方向是对的）。
  if (!needReproject) assertNorthUpForRender(src.geotransform, options.path);

  // 源类型决定默认档位，也决定要不要显式降位。
  // ⚠️ gdalinfo 本身失败（比如文件不存在）时**不报错**：让渲染命令自己去失败，
  //    错误消息仍是既有的「栅格渲染失败：…」，既有用例依赖这一句。
  //    但类型**根本不认识**（Complex / Int64 …）必须报错 —— 口径与 pixelTypeFromGdal 一致，
  //    否则渲染层单独放行会让整个引擎的类型口径分裂。
  const pixelType: PixelType | null = src.bandType === null ? null : pixelTypeFromGdal(src.bandType);
  const keepSourceType = format === 'GTiff';
  const stretch: RasterStretch =
    keepSourceType ? 'none' : resolveStretch(options.stretch, pixelType);

  const { rmSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const outDir = mkdtempSync(join(tmpdir(), 'cartouche-render-'));
  const out = join(outDir, `render.${FORMAT_EXTENSION[format]}`);

  try {
    /* ── 单条命令：8 位（或类型未知）+ 'none'，以及 GTiff 数据导出 ──
       绝大多数情况走这里：一个字节都不多写。 */
    if (stretch === 'none' && (pixelType === null || pixelType === 'Byte' || keepSourceType)) {
      const args = renderArgs(options, width, height, needReproject, format, out);
      const res = needReproject ? await gdal.warp(args) : await gdal.translate(args);
      const bytes = await readRenderedBytes(res, out, options.path, format);
      return {
        bytes,
        format,
        width,
        height,
        command: [needReproject ? 'gdalwarp' : 'gdal_translate', ...args],
      };
    }

    /* ── 非 8 位 + 'none'：固定全量程 → 0~255（只可能是 PNG/JPEG） ── */
    if (stretch === 'none') {
      // 不重投影：单条命令即可。-ot Byte 后面**必须**跟 -scale，
      // 只给 -ot Byte 会把高位静默饱和成 255（实测 GDAL 3.13.3）。
      const fullRange = pixelType ? fullRangeOf(pixelType) : FULL_RANGE_16;
      if (!needReproject) {
        const args = renderArgs(options, width, height, false, format, out, [
          ...BYTE_OUTPUT,
          ...fullRange,
        ]);
        const res = await gdal.translate(args);
        const bytes = await readRenderedBytes(res, out, options.path, format);
        return { bytes, format, width, height, command: ['gdal_translate', ...args] };
      }
      // 重投影：gdalwarp 没有 -scale，只能先落中间瓦片再 translate 出去。
      const tile = join(outDir, 'tile.tif');
      await makeTile(gdal, options, width, height, true, tile);
      const args = ['-of', format, ...BYTE_OUTPUT, ...fullRange, tile, out];
      const res = await gdal.translate(args);
      const bytes = await readRenderedBytes(res, out, options.path, format);
      return { bytes, format, width, height, command: ['gdal_translate', ...args] };
    }

    /* ── 'auto'：两步 —— 先落中间瓦片，取瓦片值域，再出 8 位图 ── */
    const tile = join(outDir, 'tile.tif');
    await makeTile(gdal, options, width, height, needReproject, tile);
    const { min, max } = await bandStats(gdal, tile);
    // 瓦片是常量图时拉伸没有意义（GDAL 会除以 0），退回「固定全量程」那条规则：
    // 8 位原样输出、其余按各自类型的全量程换算 —— 宁可暗，也不要一张全黑的图。
    const scale =
      min === max
        ? pixelType === null || pixelType === 'Byte'
          ? []
          : [...(pixelType ? fullRangeOf(pixelType) : FULL_RANGE_16)]
        : ['-scale', String(min), String(max), '0', '255'];
    const args = ['-of', format, ...BYTE_OUTPUT, ...scale, tile, out];
    const res = await gdal.translate(args);
    const bytes = await readRenderedBytes(res, out, options.path, format);
    return { bytes, format, width, height, command: ['gdal_translate', ...args] };
  } finally {
    // 临时目录连同 .aux.xml 一起清掉
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * 渲染成 PNG（既有调用方的入口，行为与命令逐字不变）。
 */
export async function renderRasterPng(
  loc: GdalLocation,
  options: RasterRenderOptions,
): Promise<RasterRenderResult> {
  const res = await renderRasterBytes(loc, options, 'PNG');
  return { png: res.bytes, width: res.width, height: res.height, command: res.command };
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
