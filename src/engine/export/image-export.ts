/**
 * 导出图片（png / jpeg / pdf / tif）。
 *
 * 这一层只做四件事：定输出尺寸、把栅格渲染成目标格式、把字节写进工作区、报清楚失败原因。
 * 渲染本身交给 raster-image.ts（GDAL 那部分只有一份实现），
 * PDF 封装交给 pdf.ts，地理范围换算交给 dataset-extent.ts。
 *
 * 输出坐标系统一是 **EPSG:4326**：
 *   - 契约里的 bbox 就是 4326 的经纬度范围；
 *   - 引擎的出图链路（前端 MapLibre 的 image source）也是按 4326 贴图的；
 *   - 投影坐标系的源走 gdalwarp 重投影 —— gdal_translate 没有 -t_srs，硬裁会错位。
 *
 * 为什么不支持多图层合成：契约里的 layers 指的是**图层标识**，
 * 而引擎这一侧没有图层树（layer:// 引用解析不了），所以带 layers 时明确报"尚未支持"，
 * 不拿单幅栅格冒充合成结果。
 */
import { probeDataset } from '../gdal/probe.ts';
import { datasetExtent } from './dataset-extent.ts';
import { renderRasterBytes, type BBox4326 } from './raster-image.ts';
import { buildPdfFromJpeg } from './pdf.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { WorkspaceAdapter } from '../workspace/types.ts';

export type ImageExportFormat = 'png' | 'jpeg' | 'pdf' | 'tif';

/** 契约里 export.image 的 format 取值全集 */
export const IMAGE_EXPORT_FORMATS: readonly ImageExportFormat[] = ['png', 'jpeg', 'pdf', 'tif'];

/** 格式 → 文件扩展名（jpeg 的扩展名用 .jpg，与 GDAL 的 JPEG 驱动一致） */
export const IMAGE_EXPORT_EXTENSIONS: Readonly<Record<ImageExportFormat, string>> = {
  png: 'png',
  jpeg: 'jpg',
  pdf: 'pdf',
  tif: 'tif',
};

/**
 * 基准 dpi：72 dpi 时**一个源像素对应一个输出像素**。
 *
 * 为什么不按"每英寸多少像素"直接推算：契约里的 bbox 是经纬度（度），
 * 度不是物理长度 —— 按 72 dpi 把一度算成几百英寸会得到荒谬的像素数。
 * 所以 dpi 在这里只表示"相对源分辨率放大多少倍"，并把 72 定成 1:1 这个基准。
 */
const BASE_DPI = 72;

/**
 * 输出像素数上限。
 *
 * 为什么要有上限：产物要先**整个读进内存**再写进工作区（工作区接口只接受字节数组），
 * 一张 4 亿像素的图就是几百 MB 内存 + 几百 MB 磁盘。
 * 宁可明确报错让用户缩小范围，也不要把机器的内存吃光。
 *
 * 为什么数据导出（GTiff）的上限更高：GeoTIFF 是**交付物**，一块整幅影像
 * 本来就可能上亿像素；而 PNG / JPEG 是给人看的，超过屏幕分辨率再多也没有意义。
 */
const MAX_OUTPUT_PIXELS = 64_000_000;
const MAX_OUTPUT_PIXELS_DATA = 256_000_000;

export interface ImageExportOptions {
  readonly loc: GdalLocation;
  readonly store: WorkspaceAdapter;
  /** 目标（工作区相对路径；路径闸门由调用方负责） */
  readonly target: string;
  readonly format: ImageExportFormat;
  /** 导出范围（EPSG:4326，经纬度，min/max 序） */
  readonly bbox?: BBox4326;
  /** 输出分辨率（72~1200） */
  readonly dpi?: number;
  /** 产出文件（工作区相对路径） */
  readonly outputPath: string;
  /** true = 只算不写（预演） */
  readonly dryRun?: boolean;
}

export interface ImageExportResult {
  readonly outputPath: string;
  readonly format: ImageExportFormat;
  readonly width: number;
  readonly height: number;
  /** 产出的字节数（预演时为 0） */
  readonly byteLength: number;
  readonly dryRun: boolean;
}

/** 目标是不是受支持的格式 */
export function isImageExportFormat(value: string): value is ImageExportFormat {
  return (IMAGE_EXPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * 导出图片。
 *
 * 失败一律带着原因抛错：目标不存在、打不开、是矢量、格式不支持、
 * dpi 越界、范围与数据不相交、渲染失败、写盘失败 —— 都不静默降级。
 */
export async function exportImage(options: ImageExportOptions): Promise<ImageExportResult> {
  const { loc, store, target, format, outputPath } = options;
  const dpi = options.dpi ?? BASE_DPI;
  if (!Number.isInteger(dpi) || dpi < 72 || dpi > 1200) {
    throw new Error(`dpi 必须是 72~1200 之间的整数，实为 ${dpi}`);
  }
  if (!(await store.exists(target))) {
    throw new Error(`目标不存在，无法导出图片：${target}`);
  }
  const abs = store.resolve(target);
  const { dataset, error } = await probeDataset(loc, abs);
  if (!dataset) {
    throw new Error(
      `打不开数据集，无法导出图片：${target}（${error?.message ?? '未知原因'}）`,
    );
  }
  if (dataset.kind !== 'raster') {
    throw new Error(
      `出图只支持栅格；目标 ${target} 是矢量数据集，矢量出图尚未支持。`,
    );
  }

  const size = await computeOutputSize(
    loc,
    abs,
    dataset.width,
    dataset.height,
    options.bbox,
    dpi,
    format,
  );

  if (options.dryRun) {
    // 预演不落盘，也不真的渲染：确认卡上点一下就留下一张图，这个"预演"就是假的
    return {
      outputPath,
      format,
      width: size.width,
      height: size.height,
      byteLength: 0,
      dryRun: true,
    };
  }

  const bytes = await renderForFormat(
    loc,
    abs,
    format,
    size,
    options.bbox,
    dpi,
    target,
    dataset.bandCount,
  );
  await writeOutput(store, outputPath, bytes);
  return {
    outputPath,
    format,
    width: size.width,
    height: size.height,
    byteLength: bytes.length,
    dryRun: false,
  };
}

/**
 * 算出输出像素尺寸。
 *
 * 基准尺寸：
 *  - 不给范围 → 源的原始像素尺寸；
 *  - 给了范围 → 范围占源的比例乘上去（4326 的源是精确的；
 *    投影坐标系的源只能近似，因为它的 4326 范围不是矩形）。
 * 之后再按 dpi 放大（72 dpi 为 1:1）。
 */
async function computeOutputSize(
  loc: GdalLocation,
  abs: string,
  srcWidth: number,
  srcHeight: number,
  bbox: BBox4326 | undefined,
  dpi: number,
  format: ImageExportFormat,
): Promise<{ width: number; height: number }> {
  let baseWidth = srcWidth;
  let baseHeight = srcHeight;
  if (bbox) {
    const [minX, minY, maxX, maxY] = bbox;
    if (maxX <= minX || maxY <= minY) {
      throw new Error(
        `bbox 的范围不合法（要求 minX<maxX 且 minY<maxY，顺序为 [minX,minY,maxX,maxY]）：${bbox.join(', ')}`,
      );
    }
    let extent: BBox4326;
    try {
      extent = (await datasetExtent(loc, { path: abs })).bbox;
    } catch (err) {
      throw new Error(
        `算不出数据的地理范围，无法按导出范围确定输出尺寸：${(err as Error).message}`,
      );
    }
    const extWidth = extent[2] - extent[0];
    const extHeight = extent[3] - extent[1];
    if (maxX <= extent[0] || minX >= extent[2] || maxY <= extent[1] || minY >= extent[3]) {
      throw new Error(
        `导出范围与数据不相交：范围 [${bbox.join(', ')}]，数据范围 [${extent.join(', ')}]；` +
          '这样出来的是一张空白图。',
      );
    }
    baseWidth = Math.max(1, Math.round(srcWidth * ((maxX - minX) / extWidth)));
    baseHeight = Math.max(1, Math.round(srcHeight * ((maxY - minY) / extHeight)));
  }
  const scale = dpi / BASE_DPI;
  const width = Math.max(1, Math.round(baseWidth * scale));
  const height = Math.max(1, Math.round(baseHeight * scale));
  const limit = format === 'tif' ? MAX_OUTPUT_PIXELS_DATA : MAX_OUTPUT_PIXELS;
  if (width * height > limit) {
    throw new Error(
      `输出尺寸过大：按 ${dpi} dpi 算是 ${width}×${height}（约 ${(width * height / 1e6).toFixed(1)} 百万像素），` +
        `超过上限 ${(limit / 1e6).toFixed(0)} 百万像素；` +
        (dpi > BASE_DPI ? '请降低 dpi 或缩小导出范围。' : '请缩小导出范围（给一个 bbox）。'),
    );
  }
  return { width, height };
}

/** 按目标格式出字节 */
async function renderForFormat(
  loc: GdalLocation,
  abs: string,
  format: ImageExportFormat,
  size: { width: number; height: number },
  bbox: BBox4326 | undefined,
  dpi: number,
  target: string,
  bandCount: number,
): Promise<Uint8Array> {
  const renderOptions = {
    path: abs,
    width: size.width,
    height: size.height,
    targetCrs: 'EPSG:4326',
    ...(bbox ? { bbox } : {}),
  };
  if (format === 'pdf') {
    // PDF 封装器只收 JPEG（PDF 用 DCTDecode 直接嵌原始字节，不重编码）。
    // ⚠️ 封装器把图像声明成 DeviceRGB，所以这里必须给三个波段：
    //    单波段影像出的是灰度 JPEG，直接塞进去会与声明的颜色空间对不上。
    const bands = bandCount >= 3 ? [1, 2, 3] : [1, 1, 1];
    const jpeg = await renderRasterBytes(loc, { ...renderOptions, bands }, 'JPEG');
    return buildPdfFromJpeg(jpeg.bytes, jpeg.width, jpeg.height, {
      dpi,
      title: target.slice(target.lastIndexOf('/') + 1),
    });
  }
  if (format === 'tif') {
    // GTiff 是**数据**导出：保留源波段类型与仿射参数，不做显示拉伸
    const tif = await renderRasterBytes(loc, renderOptions, 'GTiff');
    return tif.bytes;
  }
  const png = await renderRasterBytes(loc, renderOptions, format === 'png' ? 'PNG' : 'JPEG');
  return png.bytes;
}

/** 写盘；失败要把原因说出来（空间不足、目录写不了…） */
async function writeOutput(
  store: WorkspaceAdapter,
  outputPath: string,
  bytes: Uint8Array,
): Promise<void> {
  try {
    await store.write(outputPath, bytes);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOSPC') {
      throw new Error(`磁盘空间不足，导出未完成：${outputPath}`);
    }
    throw new Error(`写入导出文件失败：${outputPath}（${(err as Error).message}）`);
  }
}
