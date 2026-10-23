/**
 * 栅格编辑内核的公开 API。
 */
export { RasterEditor, ensureRasterOverviews } from './ops.ts';
export type { RasterOpResult, RasterDeps, OverviewOutcome } from './ops.ts';

export {
  readRasterPixels,
  writeRasterPixels,
  checksumOf,
  readRasterFrame,
  readRasterWindow,
} from './raw.ts';
export type { RasterPixels, RasterWindowPixels, RasterFrameInfo } from './raw.ts';

export { overlayWindowOntoRaster } from './overlay.ts';

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

export {
  DEFAULT_OVERVIEW_THRESHOLD_BYTES,
  overviewPathOf,
  hasOverviews,
  buildOverviews,
  ensureOverviews,
} from './overview.ts';
export type { OverviewResult, EnsureOverviewResult, OverviewSkipReason } from './overview.ts';
