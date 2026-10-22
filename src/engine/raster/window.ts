/**
 * 窗口换算（纯计算，不碰 IO）。
 *
 * 为什么要有这一层：局部型操作（涂色/擦除/修补/区域替换）在大影像上
 * 没必要把整个文件读进内存 —— 由操作区域反推一个最小窗口，
 * 只读写那一块，其余像素由 GDAL 原样搬运。
 *
 * 坐标系约定：
 *  - PixelRegion 是**整图**像元坐标（左上原点，x 向右、y 向下）
 *  - RasterWindow 是整图上的一个矩形
 *  - localRegion 把整图坐标换成窗口内坐标（给只拿到窗口像素的算法用）
 */
import type { PixelRegion } from './mask.ts';
import { BYTES_PER_SAMPLE } from './pixels.ts';

export interface RasterWindow {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 整图的基本信息：尺寸 + 仿射参数 */
export interface RasterFrame {
  readonly width: number;
  readonly height: number;
  /** [originX, pixelW, 0, originY, 0, pixelH] */
  readonly geotransform: readonly number[];
}

/** 由操作区域反推最小窗口（外扩 margin，且不越出整图） */
export function windowForRegion(
  frame: RasterFrame,
  region: PixelRegion,
  marginPx = 0,
): RasterWindow {
  const x = Math.max(0, Math.floor(region.minX - marginPx));
  const y = Math.max(0, Math.floor(region.minY - marginPx));
  const maxX = Math.min(frame.width, Math.ceil(region.maxX + marginPx));
  const maxY = Math.min(frame.height, Math.ceil(region.maxY + marginPx));
  return { x, y, w: Math.max(0, maxX - x), h: Math.max(0, maxY - y) };
}

/** 窗口自身的仿射参数：原点平移到窗口左上角，像元大小不变 */
export function windowGeotransform(frame: RasterFrame, win: RasterWindow): number[] {
  const gt = frame.geotransform;
  const pixelW = gt[1] ?? 1;
  const pixelH = gt[5] ?? -1;
  const originX = (gt[0] ?? 0) + win.x * pixelW;
  const originY = (gt[3] ?? 0) + win.y * pixelH;
  return [originX, pixelW, 0, originY, 0, pixelH];
}

/** 整图像素坐标 → 窗口内像素坐标 */
export function localRegion(win: RasterWindow, region: PixelRegion): PixelRegion {
  return {
    minX: region.minX - win.x,
    minY: region.minY - win.y,
    maxX: region.maxX - win.x,
    maxY: region.maxY - win.y,
  };
}

/**
 * 窗口占用的像素字节数。
 *
 * bytesPerSample 默认 1（8 位）。16 位影像必须传 2 ——
 * 否则体积护栏会把实际占用算少一半，护栏就形同虚设了。
 */
export function windowBytes(
  win: RasterWindow,
  bandCount: number,
  bytesPerSample: number = BYTES_PER_SAMPLE.Byte,
): number {
  return win.w * win.h * Math.max(1, bandCount) * bytesPerSample;
}
