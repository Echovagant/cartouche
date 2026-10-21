/**
 * T28'：出图（服务端部分）。
 *
 * 服务端负责两件事：
 *   1. 用 GDAL 把栅格渲染成 PNG 底图；
 *   2. 把前端画好的 JPEG（MapLibre canvas + 图面要素）封装成 PDF。
 *
 * 图面要素（比例尺/图例/指北针/图框/标题栏）由前端 canvas 绘制，
 * 因此中文字体正常，且与屏幕上所见完全一致。
 */
export { renderRasterPng, readPngSize, RasterRenderError } from './raster-image.ts';
export type { BBox4326, RasterRenderOptions, RasterRenderResult } from './raster-image.ts';

export { buildPdfFromJpeg, inspectPdf, PdfBuildError, A4_LANDSCAPE_PT, A4_PORTRAIT_PT } from './pdf.ts';
export type { PdfOptions } from './pdf.ts';

export { vectorToGeoJson, VectorConvertError } from './vector-geojson.ts';
export type { VectorToGeoJsonOptions, VectorToGeoJsonResult } from './vector-geojson.ts';

export { datasetExtent, DatasetExtentError } from './dataset-extent.ts';
export type { DatasetExtentOptions, DatasetExtentResult } from './dataset-extent.ts';
