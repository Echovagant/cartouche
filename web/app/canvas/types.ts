/**
 * 画布侧的共享数据形状。
 *
 * 单独抽出来是为了让组件之间只依赖数据、不依赖引擎 hook 的实现：
 * 引擎返回结构以后要变，改 useEngine 就够了，组件不用跟着动。
 */

/** 图层种类：栅格底图 / 矢量要素层 */
export type LayerKind = 'raster' | 'vector';

export interface MapLayer {
  /** 稳定 id：拼成 MapLibre 的 source / layer 名 */
  readonly id: string;
  /** 显示名（文件名） */
  readonly name: string;
  readonly kind: LayerKind;
  /** 工作区内的相对路径 */
  readonly path: string;
  /** 是否显示 */
  visible: boolean;
  /** 不透明度 0~1 */
  opacity: number;
}

export interface SelectedFeature {
  readonly layerId: string;
  readonly layerName: string;
  /** 该图层内的要素序号（从 0 开始） */
  readonly index: number;
  /**
   * 原始属性表。
   * 字段名**保持源文件里的中文原样**——用户要拿它跟 ArcGIS 里的属性表对照，
   * 翻译成英文反而没法核对。
   */
  readonly properties: Record<string, unknown>;
  /** 几何坐标，用于高亮 */
  readonly geometry: unknown;
}

/**
 * 引擎能直接出图的扩展名。
 *
 * 清单来自本机 GDAL 3.13.3 的 `gdalinfo --formats` 实测，不是凭记忆列的：
 *   .tif/.tiff → GTiff      .tff → GTiff（Esri TIFF，ArcGIS 自己的默认输出格式）
 *   .img       → HFA        .asc → AAIGrid（Arc/Info ASCII Grid）
 *   .bil       → EHdr       .vrt → VRT
 *   .png       → PNG        .jpg/.jpeg → JPEG    .gif → GIF   .bmp → BMP
 *
 * ⚠️ `.tff` 漏掉过一次：它是 ArcGIS Pro 默认的 TIFF 输出格式，
 *    不在清单里就等于"本项目主打的目标格式加载不了"。
 */
export const RASTER_EXTENSIONS = [
  '.tif',
  '.tiff',
  '.tff',
  '.img',
  '.asc',
  '.bil',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.vrt',
];

/**
 * 引擎能转 GeoJSON 的扩展名。
 *
 * 同样来自 `ogrinfo --formats` 实测：
 *   .shp → ESRI Shapefile    .gdb → OpenFileGDB（ArcGIS 的文件地理数据库）
 *   .gpkg → GPKG             .json/.geojson → GeoJSON
 *   .gml → GML               .kml/.kmz → KML    .sqlite → SQLite
 */
export const VECTOR_EXTENSIONS = [
  '.shp',
  '.gdb',
  '.gpkg',
  '.geojson',
  '.json',
  '.gml',
  '.kml',
  '.kmz',
  '.sqlite',
];

/**
 * 附属文件（sidecar）：**依附于某个数据集存在，本身不能单独加载**。
 *
 * Shapefile 的 .dbf/.shx/.prj/.cpg、栅格的 .tfw/.wld/.aux.xml 都是这一类。
 * 以前它们不在任何清单里 → 被当成"目录"显示"进入"按钮 → 点下去就是一条报错。
 * 现在单独归类，界面上标成"附属"，不给按钮。
 */
export const SIDECAR_EXTENSIONS = [
  '.dbf',
  '.shx',
  '.sbn',
  '.sbx',
  '.qix',
  '.prj',
  '.cpg',
  '.tfw',
  '.wld',
  '.aux',
  '.xml',
  '.htm',
  '.hinfo',
  '.json.ld',
];

/** 工作区条目在界面上的三类 */
export type EntryKind = 'raster' | 'vector' | 'sidecar' | 'other';

/**
 * 按扩展名猜图层类型。
 *
 * 为什么用扩展名猜而不是让引擎回报：/api/fs/list 只给文件名，不给类型；
 * 多问一次 stat 就要多一轮往返。这里接受"猜错就报错"——真正决定成败的是
 * 引擎能不能打开该数据集，而不是扩展名本身。
 */
export function guessLayerKind(name: string): LayerKind | null {
  const kind = guessEntryKind(name);
  return kind === 'raster' || kind === 'vector' ? kind : null;
}

/**
 * 猜工作区条目的种类。
 *
 * 返回 'other' 的按目录处理（点"进入"）；返回 'sidecar' 的不给出任何操作按钮。
 */
export function guessEntryKind(name: string): EntryKind {
  const lower = name.toLowerCase();
  // 侧车要先判：`.prj` 之类不该被误认成别的东西
  if (SIDECAR_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'sidecar';
  if (RASTER_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'raster';
  if (VECTOR_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'vector';
  return 'other';
}
