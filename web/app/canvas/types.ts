/**
 * 画布侧的共享数据形状。
 *
 * 单独抽出来是为了让组件之间只依赖数据、不依赖引擎 hook 的实现：
 * 引擎返回结构以后要变，改 useEngine 就够了，组件不用跟着动。
 */

/** 图层种类：栅格底图 / 矢量要素层 */
export type LayerKind = 'raster' | 'vector';

/* ───────── 栅格编辑 ───────── */

/** 画布上的编辑工具：查看 / 画笔 / 框选 / 调色（四者互斥） */
export type EditTool = 'view' | 'brush' | 'box' | 'levels';

/** 屏幕点：地图容器内的 CSS 像素 */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** 带地理坐标的屏幕点（地图自己算好的 4326 经纬度） */
export interface GeoScreenPoint extends ScreenPoint {
  readonly lng: number;
  readonly lat: number;
}

/** 当前视口快照：笔迹的屏幕宽度 → 原生像元宽度要用它换算 */
export interface ViewportSnapshot {
  /** EPSG:4326 的 [minX, minY, maxX, maxY] */
  readonly bbox: readonly [number, number, number, number];
  /** 地图画布的 CSS 像素尺寸 */
  readonly width: number;
  readonly height: number;
}

/** 编辑手势：地图把原始指针事件交给上层 */
export interface EditGesture {
  readonly phase: 'down' | 'move' | 'up';
  readonly x: number;
  readonly y: number;
  readonly lng: number;
  readonly lat: number;
}

/** 画布上正在进行的编辑预览（只用于画在覆盖层上） */
export interface EditPreview {
  readonly kind: 'brush' | 'box';
  readonly points: readonly ScreenPoint[];
  /** 画笔笔宽（屏幕像素） */
  readonly brushWidth?: number;
}

/**
 * 栅格坐标系的判定结果（引擎给的结论）。
 *
 * `is4326` 是**引擎判定的**，前端直接采信：
 * GDAL 对同一个文件有时只给 WKT 不给 EPSG 代码，
 * 按字符串在前端猜会漏判（漏判 = 把经纬度当成米去换算 = 画到天边去）。
 */
export interface RasterCrs {
  /** 有没有坐标系信息 */
  readonly present: boolean;
  readonly epsg: number | null;
  /** 如 EPSG:4326 */
  readonly authority: string | null;
  /** embedded / sidecar / none */
  readonly source: string;
  readonly wkt: string | null;
  /** 坐标能不能直接当经纬度用 */
  readonly is4326: boolean;
}

/** 目标栅格的原生像元网格（引擎按 GDAL 给出） */
export interface RasterGrid {
  readonly width: number;
  readonly height: number;
  /** 波段数（引擎给出，前端只用于展示与排错） */
  readonly bandCount?: number;
  /** GDAL 六元仿射：[originX, pixelWidth, rotX, originY, rotY, pixelHeight] */
  readonly geotransform: readonly [number, number, number, number, number, number];
  /** 坐标系的判定结果 */
  readonly crs: RasterCrs;
  /** 兼容字段（EPSG 码，可能为 null） */
  readonly epsg?: number | null;
}

/** 原生像元矩形（左上原点，maxX / maxY 不含） */
export interface PixelRegion {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** 画笔遮罩：width×height 的不透明度字节（0 不着色 / 255 完全着色），base64 */
export interface BrushMask {
  readonly width: number;
  readonly height: number;
  readonly data: string;
}

/** 一条待执行的编辑操作 */
export interface EditOp {
  /** 操作名（raster.paint / raster.erase / raster.adjustLevels） */
  readonly op: string;
  readonly params: Record<string, unknown>;
  /** 界面上的中文名（涂色 / 擦除 / 亮度对比度调整） */
  readonly label: string;
}

/** 预演结果：只算影响面，不落盘 */
export interface OpPreview {
  readonly op: string;
  readonly target: string;
  /**
   * 像元口径的 op 才有这三个数；非像元型 op（改属性那种）是 null。
   *
   * 为什么要可空：非像元型 op 本来就没有像元可言，硬塞一个 0 会被
   * 「一个像元都没改到」那道闸门当成"这次什么都没发生"——
   * 每一次矢量改动都被拦下来。null 才是"这条不适用"。
   */
  readonly affectedPixels: number | null;
  readonly totalPixels: number | null;
  readonly affectedRatio: number | null;
  readonly backupPath: string | null;
  /**
   * 备份文件名的样式（如 `底图.tff.bak.<yyyyMMdd-HHmmss>`）。
   *
   * 预演阶段还没有真的备份，但**叫什么名字是定死的**——
   * 提前说出来，用户改完就知道去哪儿找原件。
   */
  readonly backupNamePattern?: string | null;
  readonly verified: boolean;
  /**
   * raster = 像元口径；value = 非像元型 op（改属性、改编码那种）。
   *
   * 确认卡靠它决定报「将影响的像元」还是报 op 自己的结论。
   */
  readonly kind?: 'raster' | 'value' | undefined;
  /** 非像元型 op 自己的人话结论（如「给 12 条要素加上了字段「面积」」） */
  readonly summary?: string | null;
}

/** 单条操作的执行结果 */
export interface OpResult {
  readonly index: number;
  readonly op: string;
  readonly ok: boolean;
  readonly target?: string;
  readonly unimplemented?: boolean;
  readonly impact?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

/** 一次执行的整体结果 */
export interface OpExecuteResult {
  readonly ok: boolean;
  readonly results: readonly OpResult[];
  /** 成功条数 */
  readonly completed: number;
  /** 失败条目的下标 */
  readonly failedAt?: number;
}

/** 亮度 / 对比度参数 */
export interface LevelsParams {
  readonly method: 'linear-stretch' | 'gamma' | 'manual';
  /** -1 ~ 1 */
  readonly brightness: number;
  /** 0 ~ 4 */
  readonly contrast: number;
}

export interface MapLayer {
  /** 稳定 id：拼成 MapLibre 的 source / layer 名 */
  readonly id: string;
  /** 显示名（文件名） */
  readonly name: string;
  readonly kind: LayerKind;
  /**
   * 相对**项目根**的路径。
   *
   * 打开项目时画布里的一切路径都以**项目根**为基准
   * （`子目录/图.tff`），引擎请求靠 `root=<项目根绝对路径>` 把它定位回去。
   * 清单里存的也是同一个值——项目文件夹整体拷走，路径依然成立。
   */
  readonly path: string;
  /** 是否显示 */
  visible: boolean;
  /** 不透明度 0~1 */
  opacity: number;
}

/* ───────── 项目清单（`.cartouche/project.json`） ───────── */

/** 图面参数：图名、操作人、页幅与分辨率 */
export interface ProjectSheet {
  readonly title: string;
  readonly operator: string;
  readonly page: 'A4-landscape' | 'A4-portrait';
  readonly dpi: number;
}

/** 清单里的一个图层：只有恢复画布需要的信息，不含显示名（显示名从 path 推） */
export interface ProjectLayer {
  readonly id: string;
  readonly kind: LayerKind;
  /** 相对项目根的路径 */
  readonly path: string;
  readonly visible: boolean;
  readonly opacity: number;
}

/** 地图视角：中心点（经度、纬度）与缩放级别 */
export interface ProjectView {
  readonly center: readonly [number, number];
  readonly zoom: number;
}

/** 留痕里的一次操作 */
export interface ProjectOperation {
  readonly at: string;
  readonly op: string;
  readonly target: string;
  readonly ok: boolean;
  readonly impact?: Readonly<Record<string, unknown>>;
}

/** 项目清单本体（与引擎的 ProjectManifest 一一对应） */
export interface ProjectManifest {
  readonly version: number;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sheet: ProjectSheet;
  readonly layers: readonly ProjectLayer[];
  readonly view?: ProjectView;
  readonly operations: readonly ProjectOperation[];
}

/** 项目目录里的一份产出物（PDF / 报告） */
export interface ProjectOutput {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** 「最近打开的项目」列表里的一项 */
export interface ProjectSummary {
  /** 项目根的绝对路径 */
  readonly path: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly layerCount: number;
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
