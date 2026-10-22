/**
 * 栅格编辑内核的公开 API。
 */
export { RasterEditor } from './ops.ts';
export type { RasterOpResult, RasterDeps } from './ops.ts';

export { readRasterPixels, writeRasterPixels, checksumOf } from './raw.ts';
export type { RasterPixels } from './raw.ts';

export {
  buildAlphaMask,
  geoToPixelRegion,
  isInside,
  buildPixelMask,
  maskAlphaAt,
  maskAlphaAtRegion,
} from './mask.ts';
export type { PixelRegion, GeoBounds, PixelMask } from './mask.ts';

export { blendBands } from './blend.ts';
export { inpaintRegion } from './inpaint.ts';
export { adjustLevels } from './levels.ts';
export type { LevelsOptions } from './levels.ts';

export {
  windowForRegion,
  windowGeotransform,
  localRegion,
  windowBytes,
} from './window.ts';
export type { RasterWindow, RasterFrame } from './window.ts';
