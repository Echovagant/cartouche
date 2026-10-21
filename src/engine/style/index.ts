/**
 * T32：CIM → MapLibre 渲染描述转换。
 */
export {
  cimToMapLibreLayers,
  describeRenderer,
  cimColorToCss,
  cimRgbToRgba,
  cimHsvToRgba,
  pickLayerType,
  toLayerId,
} from './cim-to-style.ts';
export type {
  CimToStyleOptions,
  CimToStyleResult,
  MapLibreLayer,
  MapLibreLayerType,
  MapLibrePaint,
} from './cim-to-style.ts';
