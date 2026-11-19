'use client';

/**
 * MapLibre 地图容器。
 *
 * 图层的两条链路完全不同，不能合并：
 *
 *  1. 栅格底图 —— 走 MapLibre 的 **image source**。
 *     引擎没有瓦片金字塔（/api/render/raster.png 每次按视口重新渲染整幅），
 *     所以底图是一张"随视口变化的整图"：moveend 时拿当前 bbox 重新请求 PNG，
 *     再用 updateImage + setCoordinates 换掉旧图与新的地理配准。
 *     加时间戳是必须的——同一 bbox 反复出图时浏览器会拿缓存，导致平移后图像不更新。
 *
 *  2. 矢量要素 —— 走 **geojson source**。
 *     这里把 GeoJSON **对象**直接塞进 source，而不是给 source 一个 URL：
 *     对象形式由我们自己 fetch，跨域、缓存、并发都自己可控；
 *     URL 形式则交给 MapLibre 去取，失败时只有一个看不懂的网络错误。
 *
 * 关于导出：MapLibre 的画布是 WebGL 画布，**拿不到 2D 上下文**，
 * 所以图面要素（图框/标题栏/比例尺/图例/指北针）画在一张独立的 2D 覆盖层上，
 * 导出时把地图画布与覆盖层合成为一张 JPEG 再交给引擎封装 PDF。
 */

import 'maplibre-gl/dist/maplibre-gl.css';

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import {
  Map as MlMap,
  NavigationControl,
  setWorkerUrl,
  type Coordinates,
  type GeoJSONSource,
  type ImageSource,
  type MapMouseEvent,
  type MapOptions,
} from 'maplibre-gl';
import { drawSheet, metersPerPixelAt, pdfScaleDenominator, type SheetLegendItem } from './sheet';
import { LegendPanel } from './LegendPanel';
import { placeLabelBoxes, type LabelBox } from './label-layout';
import {
  featuresOf,
  labelAnchor,
  labelText,
  legendItemsForLayer,
  symbologyColorExpression,
  type LabelStyle,
} from './symbology';
import type {
  EditGesture,
  EditPreview,
  EditTool,
  MapLayer,
  SelectedFeature,
  ViewportSnapshot,
} from './types';

/**
 * 空底图样式。
 *
 * 不引任何在线底图：本工具是**离线**的，地图数据来自用户自己的工作区；
 * 引在线瓦片服务会让"图件不出本机"这条底线破掉，也让离线环境直接白屏。
 *
 * 类型从 MapOptions 里取：maplibre-gl 6.x 不再导出 StyleSpecification
 * （它下沉到 @maplibre/maplibre-gl-style-spec 包），从 map 的入参反推更稳，
 * 也不会让本项目多一个直接依赖。
 */
type StyleSpec = Exclude<MapOptions['style'], string>;

const BASE_STYLE: StyleSpec = {
  version: 8,
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      // 底图留白用纸色：这是"图幅"而不是"屏幕底色"，
      // 与导出的 PDF 图面要素（图框、标题栏）是同一套纸面语言。
      paint: { 'background-color': '#f1ede3' },
    },
  ],
};

/** 导出 PDF 时引擎按 150 DPI 贴图 */
const EXPORT_DPI = 150;

/** 栅格出图的最大边长（像素）：再大只是徒增 GDAL 的渲染开销 */
const MAX_RASTER_PX = 2048;

const HIGHLIGHT_SOURCE = 'src-selected';
const HIGHLIGHT_FILL_LAYER = 'lyr-selected-fill';
const HIGHLIGHT_LINE_LAYER = 'lyr-selected-line';

/**
 * 载入一张图片（带 CORS）。
 *
 * 必须带 crossOrigin：不带的话画布会被污染，
 * 随后导出时的 toDataURL 会抛 SecurityError——而且报错发生在导出那一刻，
 * 离真正的原因（这里少了 crossOrigin）十万八千里。
 */
function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('栅格重新出图失败'));
    image.src = url;
  });
}

/**
 * 等地图画完这一帧。
 *
 * 超时兜底：地图已经空闲时不会再触发 idle，等下去就是白等。
 */
function waitForIdle(map: MlMap, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      map.off('idle', finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    map.on('idle', finish);
    map.triggerRepaint();
  });
}

/**
 * 地图画布对外暴露的能力句柄（父组件通过 ref 拿到它）。
 *
 * 父组件（CanvasWorkbench）不直接碰 MapLibre 的内部状态——
 * 需要地图回答的每件事（导出画面、当前视角、重出图、视口快照）
 * 都收敛成这里的一个方法，由 MapCanvas 内部翻译成 MapLibre 调用。
 */
export interface MapCanvasHandle {
  /**
   * 把当前视口导出为 JPEG（data URL）。
   * 返回 null 表示地图还没建好。
   *
   * producedAt 单独传进来：标题栏上的"出图时间"必须是**这一次**出图的时间，
   * 不能沿用上一次渲染画面的时间戳。
   */
  exportJpeg: (options?: {
    quality?: number;
    producedAt?: string;
  }) => { jpeg: string; width: number; height: number } | null;
  /**
   * 当前视角（经度、纬度、缩放）。
   * 地图没建好时返回 null。
   *
   * 存在的理由：项目清单里要存"用户最后看到的那个视角"，
   * 而视角只有地图自己知道（前端拿不到 MapLibre 的内部状态）。
   */
  getView: () => { center: [number, number]; zoom: number } | null;
  /**
   * 重新出图：重新请求当前视口的栅格 PNG 并等它贴到画布上。
   *
   * 改完栅格后必须调它，否则地图上还是旧图——用户会以为操作没生效。
   * resolve 的时机是"新图已经画上去了"，这样紧接着导出的 PDF 才是改后的画面。
   */
  refresh: () => Promise<void>;
  /**
   * 当前视口快照（4326 的 bbox + 画布尺寸）。
   *
   * 笔迹的屏幕宽度要靠它换算成原生像元宽度——
   * 前端不知道栅格的分辨率，只能从"这一屏多大"倒推。
   */
  getViewport: () => ViewportSnapshot | null;
}

export interface MapCanvasProps {
  ref?: Ref<MapCanvasHandle>;
  /** 引擎服务地址（只在"引擎不可用"的提示里显示） */
  engineBase: string;
  /**
   * 拼栅格出图 URL（由 useEngine 提供）。
   * 引擎调用的 URL 拼法只留一份，免得前后端约定在两处走样。
   */
  buildRasterUrl: (
    path: string,
    options: {
      width: number;
      height: number;
      bbox: [number, number, number, number];
      cacheBust?: number;
      /**
       * 栅格显示的拉伸档位。
       * 不给 = 自动（引擎按源类型决定：8 位按原样、16 位按实际亮度）。
       */
      stretch?: 'auto' | 'none';
    },
  ) => string;
  /** 当前图层列表（数组顺序即叠放次序，末尾在最上） */
  layers: readonly MapLayer[];
  /**
   * 拼按需 MVT 瓦片模板 URL（由 useEngine 提供）。
   * 只给 `tiled` 图层用：MapLibre 按 z/x/y 自己拉瓦片。
   */
  buildVectorTileUrl: (path: string) => string;
  /** 引擎不可用时的提示文案；非空时地图上盖一层可读提示，不白屏 */
  engineError: string | null;
  /** 标题栏信息（图名 / 操作人 / 出图时间） */
  sheetMeta: { readonly title: string; readonly operator: string; readonly producedAt: string };
  /** 当前选中的要素（用于高亮） */
  selectedFeatures: readonly SelectedFeature[];
  /**
   * 矢量图层的 GeoJSON 数据（图层 id → FeatureCollection）。
   * 由上层取好后传进来——矢量 source 用**对象**而不是 URL，
   * 这样跨域、缓存、失败提示都由我们自己掌控。
   */
  vectorData: ReadonlyMap<string, unknown>;
  /**
   * 各图层的地理范围（EPSG:4326 的 [minX, minY, maxX, maxY]）。
   *
   * 栅格的范围只有引擎知道（栅格底图是"按视口实时出图"的，
   * 前端不先知道范围就没法把视野挪过去），所以统一由引擎给。
   * 拿到范围后画布会自动把视野移到该图层——不挪的话用户看到的是一张空白图。
   */
  extents: ReadonlyMap<string, readonly [number, number, number, number]>;
  /**
   * 建图时的初始视角（经度、纬度、缩放）。
   * 不给就用默认视角（[116.4, 39.9] / zoom 3）。
   *
   * 恢复项目时传清单里的 `view`——用户上次看到的画面要原样回来。
   */
  initialView?: { center: [number, number]; zoom: number };
  /**
   * 恢复项目时传这些图层 id：它们的视角已经由 `initialView` 定好了，
   * 不要再被"视野自动挪到数据上"覆盖掉。
   *
   * 不给就没有这层保护：加载图层后视野会照常挪到数据范围。
   */
  preserveViewLayerIds?: readonly string[];
  /** 点击地图上的要素时回调 */
  onSelectFeatures: (features: SelectedFeature[]) => void;
  /**
   * 视口变化（moveend）派发：把当前 EPSG:4326 bbox 交给上层。
   *
   * 分块（chunked）图层的"按视口重裁补数据"由上层决定做不做 —— 这里只管
   * 每次视口停下来时喊一声，防抖与包含判定都在上层。
   */
  onViewportChange?: (bbox: readonly [number, number, number, number]) => void;
  /**
   * 地图空闲（这一屏瓦片都落图了）时派发。
   *
   * 上层用它把"低倍瓦片预热"放到首屏之后：预热要整幅扫一遍源数据，
   * 和用户正在等的那屏瓦片抢磁盘只会让两边都变慢。
   */
  onIdle?: () => void;
  /**
   * 当前编辑工具。
   *
   * 不是「查看」时，地图的拖拽手势交给工具（画笔 / 框选），
   * 地图本身的平移、框选缩放、双击缩放都要让出来。
   */
  editTool?: EditTool;
  /** 编辑手势回调（屏幕坐标 + 地图算好的经纬度） */
  onEditGesture?: (gesture: EditGesture) => void;
  /** 正在进行的编辑预览（画在覆盖层上，让用户看得见自己画到哪了） */
  editPreview?: EditPreview | null;
  /**
   * 栅格显示的拉伸档位。
   *
   * undefined = 自动（不发参数，引擎按源类型决定）。
   * 变了必须立刻重新出图 —— 否则用户切了档却要等平移一下才看到变化。
   */
  stretch?: 'auto' | 'none';
}

/**
 * 把范围夹进合法的经纬度区间；夹不回来就返回 null（这次就不挪视野）。
 *
 * 为什么必须夹：引擎给的世界级栅格范围是
 * `[-180, -90.000000000036, 180, 90.00000000000001]`——浮点误差把纬度顶到了 -90 之外。
 * MapLibre 的 `fitBounds` 碰到越界的纬度会**抛异常**
 * （"Invalid LngLat latitude value: must be between -90 and 90"），
 * 而这个异常发生在 effect 里 → React 整个页面被卸载 → 画布直接白掉。
 * 夹一下就没事，视野差这一丁点看不出来。
 */
function clampBounds(
  bounds: readonly [number, number, number, number],
): [number, number, number, number] | null {
  const [minX, minY, maxX, maxY] = bounds;
  if (![minX, minY, maxX, maxY].every((n) => Number.isFinite(n))) return null;
  const lon = (n: number) => Math.min(180, Math.max(-180, n));
  const lat = (n: number) => Math.min(90, Math.max(-90, n));
  return [lon(minX), lat(minY), lon(maxX), lat(maxY)];
}

/**
 * 从 GeoJSON 里算出外接矩形。
 *
 * 用途：矢量图层加载完自动把视野挪到数据范围。
 * 栅格做不到这件事——引擎没有暴露"读取范围"的接口，客户端无从得知影像在哪。
 */
function geoJsonBounds(data: unknown): [number, number, number, number] | null {
  const features = (data as { features?: { geometry?: { coordinates?: unknown } }[] } | undefined)?.features;
  if (!Array.isArray(features)) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number') {
      const x = coords[0] as number;
      const y = coords[1] as number;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      return;
    }
    for (const child of coords) visit(child);
  };
  for (const feature of features) visit(feature.geometry?.coordinates);
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return [minX, minY, maxX, maxY];
}

/**
 * 告诉 MapLibre 去哪找它的 worker。
 *
 * MapLibre v6 自己拼 worker 地址的方式是
 *   `new URL(\`./maplibre-gl-worker.mjs\`, import.meta.url)`
 * —— 文件名在模板字符串里是**动态**的，打包器无法做静态资源改写，
 * 拼出来的地址必然 404 → worker 起不来 → 地图一片空白（控制台只有一行
 * "Worker failed to load"）。
 *
 * 所以改用官方开关 `setWorkerUrl` 指向一个**稳定地址**：
 * 构建时 scripts/copy-maplibre-worker.mjs 把 worker 复制到 web/public/，
 * 静态导出后它与 canvas.html 同级；这里用 document.baseURI 解析，
 * http:// 与 file:// 下都指向正确的兄弟文件。
 *
 * ⚠️ file:// 下仍起不来 worker：Chrome 禁止从 origin=null 的页面构造 Worker。
 *    所以画布必须用 http 打开（scripts/serve-static.mjs 提供了零依赖的静态服务器）。
 */
function configureWorkerUrl(): void {
  if (typeof document === 'undefined') return;
  try {
    setWorkerUrl(new URL('maplibre-gl-worker.mjs', document.baseURI).href);
  } catch {
    // 设不上就沿用 MapLibre 的默认推导（至少不会让整页崩掉）
  }
}

export default function MapCanvas({
  ref,
  engineBase,
  buildRasterUrl,
  buildVectorTileUrl,
  layers,
  engineError,
  sheetMeta,
  selectedFeatures,
  vectorData,
  extents,
  initialView,
  preserveViewLayerIds,
  onSelectFeatures,
  onViewportChange,
  onIdle,
  editTool = 'view',
  onEditGesture,
  editPreview = null,
  stretch,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  /** 画布容器（图例面板的定位参照） */
  const stageRootRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [styleReady, setStyleReady] = useState(false);

  /**
   * 初始视角与"别动我的视角"的图层集合。
   *
   * 用 ref 留住：地图只建一次，建图时要读的是**那一刻**的值；
   * 用 props 直接读会把建图 effect 的依赖变成 initialView，
   * 换个项目就重建整张地图（白闪一次，图层重来）。
   */
  const initialViewRef = useRef(initialView);
  initialViewRef.current = initialView;
  const preserveIdsRef = useRef<ReadonlySet<string>>(new Set());
  preserveIdsRef.current = new Set(preserveViewLayerIds ?? []);

  // 用 ref 留住最新的 props，避免把回调重建进 map 的事件监听里
  const layersRef = useRef<readonly MapLayer[]>(layers);
  layersRef.current = layers;
  const vectorDataRef = useRef(vectorData);
  vectorDataRef.current = vectorData;
  /**
   * 瓦片图层的标注条目（图层 id → 文本 + 经纬度锚点）。
   *
   * 瓦片层没有整份 GeoJSON 在手，标注只能从 MapLibre **当前渲染出来的要素**里取；
   * 取一次缓存起来，地图平移时按经纬度重投影，等地图空闲再刷新。
   */
  const tileLabelsRef = useRef<Map<string, ReadonlyArray<{ text: string; lngLat: [number, number] }>>>(
    new Map(),
  );
  /**
   * 标注文本的宽度缓存（键 = 字号|文本）。
   *
   * 平移时每帧都要重画标注，measureText 是其中最贵的一步；
   * 文本与字号不变时直接复用，600 条标注的平移重绘不再反复量字。
   */
  const labelWidthCacheRef = useRef<Map<string, number>>(new Map());
  /** 瓦片标注的延迟刷新定时器：idle 常成串出现，合并成一次查询 */
  const labelRefreshTimerRef = useRef<number>(0);
  const labelRef = useRef<HTMLCanvasElement | null>(null);
  const sheetMetaRef = useRef(sheetMeta);
  sheetMetaRef.current = sheetMeta;
  const onSelectRef = useRef(onSelectFeatures);
  onSelectRef.current = onSelectFeatures;
  /** 视口变化派发（moveend）：分块图层的父层在这里补拉数据，ref 挡住回调重建 */
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;
  /** 地图空闲派发（父层用它延后低倍预热） */
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  /**
   * 编辑相关的最新值。
   *
   * 地图只建一次，事件回调要读的是**那一刻**的 props，
   * 直接用 props 会把回调重建进 map 的监听里（每次渲染都重新解绑重绑）。
   */
  const editToolRef = useRef(editTool);
  editToolRef.current = editTool;
  const onEditGestureRef = useRef(onEditGesture);
  onEditGestureRef.current = onEditGesture;
  const editPreviewRef = useRef(editPreview);
  editPreviewRef.current = editPreview;

  /**
   * 拉伸档位的最新值。
   *
   * 为什么用 ref 而不是直接进 refreshRaster 的依赖数组：
   * refreshRaster 被**建图 effect**依赖着，它的身份一变，那张地图就会被拆掉重建
   * （白闪一次、图层重来）。档位切换必须只是换一张底图，不能动地图本身。
   */
  const stretchRef = useRef(stretch);
  stretchRef.current = stretch;

  /** 当前视口对应的 EPSG:4326 bbox（[minX, minY, maxX, maxY]） */
  const currentBBox = useCallback((map: MlMap): [number, number, number, number] => {
    const bounds = map.getBounds();
    return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
  }, []);
  /**
   * 图面要素的图例：图层名 + 色块。
   *
   * 名字**去掉扩展名**：图例是给人读的说明（"陆地与海洋"），
   * 而不是文件列表（"陆地与海洋.tif"）。文件列表在侧栏，那里才该带扩展名。
   */
  const legend = useCallback((): SheetLegendItem[] => {
    return layersRef.current
      .filter((layer) => layer.visible)
      .flatMap((layer) =>
        layer.kind === 'raster'
          ? [{ name: layer.name.replace(/\.[^./\\]+$/, ''), color: '#b08d57' }]
          : legendItemsForLayer(layer.name, layer.style?.symbology),
      );
  }, []);

  /**
   * 从瓦片图层**当前渲染出的要素**里收集标注锚点。
   *
   * 为什么不用 MapLibre 的 symbol 层：它要 glyphs（SDF 字形），本工具是离线的，
   * 自己托管中文字形是另一整套构建链。这里继续用 2D 覆盖层，样式与普通图层
   * 完全一致，导出 PDF 也走同一套绘制逻辑。
   *
   * 只在**地图空闲**（瓦片都已落图）或图层样式变化时调用：
   * queryRenderedFeatures 是同步调用，拖动过程中每帧都查会把主线程拖住。
   */
  const refreshTileLabels = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    // 没有任何带标注的瓦片层时直接清空，省掉一次全屏要素查询
    const hasTiledLabels = layersRef.current.some(
      (layer) => layer.kind === 'vector' && layer.tiled && layer.visible && layer.style?.labels,
    );
    if (!hasTiledLabels) {
      if (tileLabelsRef.current.size > 0) tileLabelsRef.current = new Map();
      return;
    }
    const next = new Map<string, Array<{ text: string; lngLat: [number, number] }>>();
    for (const layer of layersRef.current) {
      if (layer.kind !== 'vector' || !layer.tiled || !layer.visible) continue;
      const labels = layer.style?.labels;
      if (!labels) continue;
      const targets = [`lyr-${layer.id}`, `lyr-${layer.id}-line`, `lyr-${layer.id}-point`].filter(
        (id) => Boolean(map.getLayer(id)),
      );
      if (targets.length === 0) continue;
      let rendered: ReturnType<MlMap['queryRenderedFeatures']>;
      try {
        rendered = map.queryRenderedFeatures(undefined, { layers: targets });
      } catch {
        continue;
      }
      const seen = new Set<string>();
      const entries: Array<{ text: string; lngLat: [number, number] }> = [];
      let scanned = 0;
      for (const feature of rendered) {
        // 单层最多扫 4000 条、留 600 条：查询本身已是同步的，别为标注拖住主线程
        if ((scanned += 1) > 4000) break;
        if (entries.length >= 600) break;
        const text = labelText(feature.properties ?? undefined, labels.field);
        if (!text) continue;
        // 同一要素被瓦片边界切成几块时 properties / id 相同 —— 只标一次，
        // 否则交界处会出现两个一模一样的标注。
        const key = String(
          feature.id ?? feature.properties?.id ?? feature.properties?.mvt_id ?? text,
        );
        if (seen.has(key)) continue;
        seen.add(key);
        const anchor = labelAnchor(feature.geometry);
        if (!anchor) continue;
        entries.push({ text, lngLat: anchor });
      }
      if (entries.length > 0) next.set(layer.id, entries);
    }
    tileLabelsRef.current = next;
  }, []);

  /** 当前所有要画的标注（上层优先；超过 600 条就不画了，避免卡死）。 */
  const collectLabelEntries = useCallback((): Array<{
    text: string;
    lngLat: [number, number];
    style: LabelStyle;
  }> => {
    const out: Array<{ text: string; lngLat: [number, number]; style: LabelStyle }> = [];
    // 上层先画，碰撞时上层优先
    for (let i = layersRef.current.length - 1; i >= 0; i -= 1) {
      const layer = layersRef.current[i]!;
      const labels = layer.style?.labels;
      if (layer.kind !== 'vector' || !layer.visible || !labels) continue;
      // 瓦片层：锚点来自当前渲染要素的缓存（refreshTileLabels 维护）
      if (layer.tiled) {
        for (const entry of tileLabelsRef.current.get(layer.id) ?? []) {
          out.push({ text: entry.text, lngLat: entry.lngLat, style: labels });
          if (out.length >= 600) return out;
        }
        continue;
      }
      let scanned = 0;
      for (const feature of featuresOf(vectorDataRef.current.get(layer.id))) {
        // 单层最多扫 5000 条：标注是屏幕上的即时叠加，不能为它把主线程拖住
        if ((scanned += 1) > 5000) break;
        const text = labelText(feature.properties, labels.field);
        if (!text) continue;
        const anchor = labelAnchor(feature.geometry);
        if (!anchor) continue;
        out.push({ text, lngLat: anchor, style: labels });
        if (out.length >= 600) return out;
      }
    }
    return out;
  }, []);

  /**
   * 把标注画到 2D 上下文。
   *
   * 走覆盖层而不是 MapLibre 的 symbol 层：symbol 层要配 glyphs（SDF 字体），
   * 本工具是离线的，引在线 glyphs 会破坏「图件不出本机」；自己托管中文
   * SDF 字体是另一整套构建链。最小切片先用 2D 画，导出时同一套逻辑重画。
   *
   * @param scale 设备像素 / CSS 像素；屏幕覆盖层用 1（ctx 已按 dpr 缩放），导出用 devicePixelRatio
   */
  const paintLabelEntries = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      entries: ReturnType<typeof collectLabelEntries>,
      project: (lngLat: [number, number]) => { x: number; y: number },
      scale: number,
      cssWidth: number,
      cssHeight: number,
    ) => {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';

      // 第一遍：投影、视口裁剪、量字（带缓存），得到候选框
      const candidates: Array<{
        text: string;
        x: number;
        y: number;
        size: number;
        style: LabelStyle;
        box: LabelBox;
      }> = [];
      const cache = labelWidthCacheRef.current;
      for (const entry of entries) {
        const p = project(entry.lngLat);
        const x = p.x * scale;
        const y = p.y * scale;
        if (
          x < -80 * scale ||
          y < -80 * scale ||
          x > cssWidth * scale + 80 * scale ||
          y > cssHeight * scale + 80 * scale
        ) {
          continue;
        }
        const size = entry.style.size * scale;
        const key = `${size}|${entry.text}`;
        let width = cache.get(key);
        if (width === undefined) {
          ctx.font = `600 ${size}px "Noto Sans SC","Microsoft YaHei",sans-serif`;
          width = ctx.measureText(entry.text).width;
          // 样式换来换去时别让缓存无限长
          if (cache.size > 4000) cache.clear();
          cache.set(key, width);
        }
        const height = size * 1.2;
        const pad = 2 * scale;
        candidates.push({
          text: entry.text,
          x,
          y,
          size,
          style: entry.style,
          box: {
            x1: x - width / 2 - pad,
            y1: y - height / 2 - pad,
            x2: x + width / 2 + pad,
            y2: y + height / 2 + pad,
          },
        });
      }

      // 第二遍：网格索引避让（先到先得，上层图层排在前面）
      const accepted = placeLabelBoxes(candidates.map((c) => c.box));

      // 第三遍：只画放得下的
      for (let i = 0; i < candidates.length; i += 1) {
        if (!accepted[i]) continue;
        const c = candidates[i]!;
        ctx.font = `600 ${c.size}px "Noto Sans SC","Microsoft YaHei",sans-serif`;
        ctx.lineWidth = Math.max(2 * scale, c.size / 5);
        ctx.strokeStyle = c.style.halo;
        ctx.strokeText(c.text, c.x, c.y);
        ctx.fillStyle = c.style.color;
        ctx.fillText(c.text, c.x, c.y);
      }
      ctx.restore();
    },
    [],
  );

  /** 屏幕覆盖层上的标注（地图移动时重画）。 */
  const drawLabelsOverlay = useCallback(() => {
    const map = mapRef.current;
    const canvas = labelRef.current;
    if (!map || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.width / dpr;
    const cssHeight = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    paintLabelEntries(
      ctx,
      collectLabelEntries(),
      (lngLat) => map.project(lngLat),
      1,
      cssWidth,
      cssHeight,
    );
  }, [collectLabelEntries, paintLabelEntries]);

  /** 把图面要素画到覆盖层（屏幕坐标，按 CSS 像素绘制） */
  const drawSheetOverlay = useCallback(() => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    if (!map || !overlay) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = overlay.width / dpr;
    const cssHeight = overlay.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const center = map.getCenter();
    drawSheet(ctx, {
      width: cssWidth,
      height: cssHeight,
      dpi: 96,
      title: sheetMetaRef.current.title,
      operator: sheetMetaRef.current.operator,
      producedAt: sheetMetaRef.current.producedAt,
      metersPerPixel: metersPerPixelAt(map.getZoom(), center.lat),
      // 屏幕预览**不画图例**：图例是界面（独立 DOM 面板，可拖动/可调透明度），
      // 不该当成像素压在编辑画布上（2026-11-16 用户裁定）。
      legend: [],
      // 屏幕预览形态：标题栏不上屏（导出 PDF 仍是完整版式）
      preview: true,
    });
  }, [legend]);

  /**
   * 把编辑预览画到覆盖层（笔迹 / 框选）。
   *
   * 画在覆盖层而不是画布里：覆盖层本来就是"贴在地图上的图面要素"，
   * 编辑预览和它是同一类东西（临时叠加，不进数据）。
   * 而且覆盖层是 2D 画布，画笔预览可以随手改，不必等地图重新出图。
   */
  const drawEditOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    const preview = editPreviewRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    if (!preview || preview.points.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.strokeStyle = '#d9480f';
    ctx.fillStyle = 'rgba(217, 72, 15, 0.16)';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (preview.kind === 'box') {
      const a = preview.points[0];
      const b = preview.points[preview.points.length - 1];
      if (!a || !b) {
        ctx.restore();
        return;
      }
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(a.x - b.x);
      const h = Math.abs(a.y - b.y);
      ctx.lineWidth = 1.5;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    } else {
      // 笔迹：线宽就是笔宽，所见即所得
      ctx.lineWidth = Math.max(1, preview.brushWidth ?? 6);
      ctx.beginPath();
      const first = preview.points[0];
      if (!first) {
        ctx.restore();
        return;
      }
      ctx.moveTo(first.x, first.y);
      for (const p of preview.points.slice(1)) ctx.lineTo(p.x, p.y);
      if (preview.points.length === 1) ctx.lineTo(first.x + 0.01, first.y);
      ctx.stroke();
    }
    ctx.restore();
  }, []);

  /**
   * 覆盖层的统一入口：先画图面要素，再画编辑预览。
   *
   * 顺序不能反：图面要素会清空整块画布，画在它后面的编辑预览会被抹掉。
   */
  const paintOverlay = useCallback(() => {
    drawSheetOverlay();
    drawEditOverlay();
  }, [drawSheetOverlay, drawEditOverlay]);

  /** 覆盖层尺寸跟随地图容器（含设备像素比） */
  const syncOverlaySize = useCallback(() => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    if (!map || !overlay) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = map.getCanvas().getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (overlay.width !== width || overlay.height !== height) {
      overlay.width = width;
      overlay.height = height;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
    }
    // 标注层与图面要素覆盖层同尺寸（标注在下、图框在上）
    const labels = labelRef.current;
    if (labels && (labels.width !== width || labels.height !== height)) {
      labels.width = width;
      labels.height = height;
      labels.style.width = `${rect.width}px`;
      labels.style.height = `${rect.height}px`;
    }
  }, []);

  /**
   * 出图尺寸：按画布像素给，但整体等比缩到 MAX_RASTER_PX 以内。
   *
   * 必须等比——image source 会把 PNG 的四角钉到视口四角上，
   * 宽高比一旦对不上，整幅影像就被拉伸变形了。
   */
  const rasterSize = useCallback((map: MlMap): { width: number; height: number } => {
    const canvas = map.getCanvas();
    const scale = Math.min(1, MAX_RASTER_PX / Math.max(canvas.width, canvas.height, 1));
    return {
      width: Math.max(1, Math.round(canvas.width * scale)),
      height: Math.max(1, Math.round(canvas.height * scale)),
    };
  }, []);

  /**
   * 重新出图：按当前视口重新请求 PNG 并刷新 image source。
   *
   * 坐标与图像要一起换：coordinates 负责地理配准（图像四角对应哪块地面），
   * url 负责换掉像素内容；只做其中一个就会出现"图变了位"或"位对了图是旧的"。
   */
  const refreshRaster = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const bbox = currentBBox(map);
    const { width, height } = rasterSize(map);

    for (const layer of layersRef.current) {
      if (layer.kind !== 'raster') continue;
      const source = map.getSource(`src-${layer.id}`);
      if (!source) continue;
      const url = buildRasterUrl(layer.path, {
        width,
        height,
        bbox,
        cacheBust: Date.now(),
        stretch: stretchRef.current,
      });
      const imageSource = source as ImageSource;
      // image source 的坐标约定：**从左上角开始、顺时针**（NW → NE → SE → SW）。
      // 写成 SW 开头会变成逆时针，图像会被上下颠倒。
      const coordinates: Coordinates = [
        [bbox[0], bbox[3]],
        [bbox[2], bbox[3]],
        [bbox[2], bbox[1]],
        [bbox[0], bbox[1]],
      ];
      // 6.x 的推荐用法：url 与坐标一起换。
      // 分两次调用（先 setCoordinates 再 updateImage）会出现中间态——
      // 旧图配新位置或新图配旧位置，视觉上就是"图跳了一下"。
      imageSource.updateImage({ url, coordinates });
    }
  }, [buildRasterUrl, currentBBox, rasterSize]);

  /** 按图层顺序同步 MapLibre 的 source / layer */
  const syncLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const current = layersRef.current;

    // 新增
    for (const layer of current) {
      const sourceId = `src-${layer.id}`;
      const layerId = `lyr-${layer.id}`;
      const desiredSourceType =
        layer.kind === 'raster' ? 'image' : layer.tiled ? 'vector' : 'geojson';
      // 类型从样式 JSON 里读（source 实例上的 type 不在公开类型里）
      const existingType = map.getStyle().sources?.[sourceId]?.type;
      if (existingType) {
        // 源类型没变就跳过；变了（例如中途从 GeoJSON 切到瓦片）必须拆掉重建，
        // 否则新样式挂到旧 source 上，地图上什么都不会出现。
        if (existingType === desiredSourceType) continue;
        for (const suffix of ['-point', '-line']) {
          if (map.getLayer(`${layerId}${suffix}`)) map.removeLayer(`${layerId}${suffix}`);
        }
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        map.removeSource(sourceId);
      }

      if (layer.kind === 'raster') {
        const bbox = currentBBox(map);
        const { width, height } = rasterSize(map);
        const url = buildRasterUrl(layer.path, {
          width,
          height,
          bbox,
          cacheBust: Date.now(),
          stretch: stretchRef.current,
        });
        const coordinates: Coordinates = [
          [bbox[0], bbox[3]],
          [bbox[2], bbox[3]],
          [bbox[2], bbox[1]],
          [bbox[0], bbox[1]],
        ];
        map.addSource(sourceId, {
          type: 'image',
          url,
          coordinates,
        });
        map.addLayer({
          id: layerId,
          type: 'raster',
          source: sourceId,
          paint: { 'raster-opacity': layer.opacity },
        });
      } else {
        const color = symbologyColorExpression(layer.style?.symbology) as never;
        if (layer.tiled) {
          // 按需瓦片：MapLibre 按 z/x/y 自己拉，引擎现场切片并落缓存。
          // maxzoom 给 20：再往下的层级由它拿 z20 的瓦片放大（overzoom）。
          map.addSource(sourceId, {
            type: 'vector',
            tiles: [buildVectorTileUrl(layer.path)],
            minzoom: 0,
            maxzoom: 20,
          });
        } else {
          map.addSource(sourceId, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          });
        }
        // 矢量瓦片必须显式指定 source-layer（瓦片内可能有多层）；
        // GeoJSON 源没有这个概念，带上反而报错。
        const sourceLayer = layer.tiled && layer.tileLayer
          ? { 'source-layer': layer.tileLayer }
          : {};
        map.addLayer({
          id: layerId,
          type: 'fill',
          source: sourceId,
          ...sourceLayer,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: {
            'fill-color': color,
            'fill-opacity': 0.25 * layer.opacity,
            'fill-outline-color': '#1f5347',
          },
        });
        // 线与面的边界都走线层；点用单独的圆点层
        map.addLayer({
          id: `${layerId}-line`,
          type: 'line',
          source: sourceId,
          ...sourceLayer,
          filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'LineString']],
          paint: {
            'line-color': color,
            'line-width': ['case', ['==', ['geometry-type'], 'Polygon'], 1.2, 1.8] as never,
            'line-opacity': layer.opacity,
          },
        });
        map.addLayer({
          id: `${layerId}-point`,
          type: 'circle',
          source: sourceId,
          ...sourceLayer,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-color': color,
            'circle-radius': 4,
            'circle-opacity': layer.opacity,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1,
          },
        });
      }
    }

    // 删除已移除的图层
    const known = new Set(current.map((layer) => `src-${layer.id}`));
    for (const sourceId of Object.keys(map.getStyle().sources ?? {})) {
      if (!sourceId.startsWith('src-') || known.has(sourceId)) continue;
      // 高亮 source 是常驻的，不属于任何图层，不能跟着清理掉
      if (sourceId === HIGHLIGHT_SOURCE) continue;
      const layerId = sourceId.replace('src-', 'lyr-');
      if (map.getLayer(`${layerId}-point`)) map.removeLayer(`${layerId}-point`);
      if (map.getLayer(`${layerId}-line`)) map.removeLayer(`${layerId}-line`);
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      map.removeSource(sourceId);
    }

    // 可见性与透明度
    for (const layer of current) {
      const layerId = `lyr-${layer.id}`;
      if (!map.getLayer(layerId)) continue;
      const visibility = layer.visible ? 'visible' : 'none';
      map.setLayoutProperty(layerId, 'visibility', visibility);
      if (layer.kind === 'raster') {
        map.setPaintProperty(layerId, 'raster-opacity', layer.opacity);
      } else {
        const color = symbologyColorExpression(layer.style?.symbology) as never;
        map.setPaintProperty(layerId, 'fill-color', color);
        map.setPaintProperty(layerId, 'fill-opacity', 0.25 * layer.opacity);
        // 线层是独立的 layer，隐藏时必须一起隐藏，否则会剩下一条"幽灵线"
        if (map.getLayer(`${layerId}-line`)) {
          map.setLayoutProperty(`${layerId}-line`, 'visibility', visibility);
          map.setPaintProperty(`${layerId}-line`, 'line-color', color);
          map.setPaintProperty(`${layerId}-line`, 'line-opacity', layer.opacity);
        }
        if (map.getLayer(`${layerId}-point`)) {
          map.setLayoutProperty(`${layerId}-point`, 'visibility', visibility);
          map.setPaintProperty(`${layerId}-point`, 'circle-color', color);
          map.setPaintProperty(`${layerId}-point`, 'circle-opacity', layer.opacity);
        }
      }
    }

    // 叠放次序：数组末尾在最上，用 moveLayer 逐个压到前一个之后
    const order: string[] = [];
    for (const layer of current) {
      order.push(`lyr-${layer.id}`);
      if (layer.kind === 'vector') {
        order.push(`lyr-${layer.id}-line`, `lyr-${layer.id}-point`);
      }
    }
    order.forEach((layerId, index) => {
      if (!map.getLayer(layerId)) return;
      const before = order[index + 1];
      map.moveLayer(layerId, before && map.getLayer(before) ? before : undefined);
    });
    if (map.getLayer(HIGHLIGHT_LINE_LAYER)) map.moveLayer(HIGHLIGHT_LINE_LAYER);
    if (map.getLayer(HIGHLIGHT_FILL_LAYER)) map.moveLayer(HIGHLIGHT_FILL_LAYER);
  }, [buildRasterUrl, buildVectorTileUrl, currentBBox, rasterSize]);

  // 建图：只做一次
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    configureWorkerUrl();

    // 恢复项目时用清单里的视角；没有就回默认视角
    const init = initialViewRef.current ?? { center: [116.4, 39.9] as [number, number], zoom: 3 };
    const map = new MlMap({
      container,
      style: BASE_STYLE,
      center: init.center,
      zoom: init.zoom,
      // 不引在线底图，也就没有在线数据的署名义务；保持图面干净
      attributionControl: false,
      maplibreLogo: false,
      canvasContextAttributes: {
        // 默认 false 时渲染完一帧缓冲就被丢弃，drawImage/toDataURL 会拿到空白
        preserveDrawingBuffer: true,
      },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-left');

    /**
     * 地图自身的错误必须显式接住。
     *
     * 不接的后果实测过：MapLibre 的 worker 回错时，它内部的错误派发路径会先抛一个
     * `TypeError: Cannot read properties of undefined (reading '_classRegistryKey')`，
     * **把真正的错误信息整个盖掉**——控制台只看得到这个二次异常，看不到根因。
     * 接上之后，worker 到底为什么拒绝这次 setData 就能直接看见。
     */
    map.on('error', (event) => {
      const message =
        (event as { error?: { message?: string } }).error?.message ?? String(event);
      console.warn('[maplibre]', message);
    });

    map.on('load', () => {
      setStyleReady(true);
      // 选中高亮层：常驻最上
      map.addSource(HIGHLIGHT_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: HIGHLIGHT_FILL_LAYER,
        type: 'fill',
        source: HIGHLIGHT_SOURCE,
        paint: { 'fill-color': '#d9480f', 'fill-opacity': 0.28 },
      });
      map.addLayer({
        id: HIGHLIGHT_LINE_LAYER,
        type: 'line',
        source: HIGHLIGHT_SOURCE,
        paint: { 'line-color': '#d9480f', 'line-width': 2.2 },
      });
    });

    const onMoveEnd = () => {
      refreshRaster();
      syncOverlaySize();
      paintOverlay();
      drawLabelsOverlay();
      // 视口 bbox 派发给上层：分块（chunked）图层的重裁由它决定要不要做
      onViewportChangeRef.current?.(currentBBox(map));
    };
    map.on('moveend', onMoveEnd);

    /**
     * 地图空闲（瓦片全部落图）→ 刷新瓦片图层的标注锚点并重画覆盖层。
     *
     * 放在 idle 而不是 move：拖动过程中查渲染要素太重；idle 时该有的瓦片
     * 都已经在画面上，收集到的标注才对得上。
     */
    const onIdle = (): void => {
      // 成串出现的 idle 合并成一次：120ms 内只查一次渲染要素
      window.clearTimeout(labelRefreshTimerRef.current);
      labelRefreshTimerRef.current = window.setTimeout(() => {
        labelRefreshTimerRef.current = 0;
        refreshTileLabels();
        drawLabelsOverlay();
      }, 120);
      // 首屏瓦片落图之后，父层才允许开始低倍预热
      onIdleRef.current?.();
    };
    map.on('idle', onIdle);

    // 拖动过程中只重画标注（不重画图框/编辑预览），用 rAF 合并高频事件
    let labelRaf = 0;
    const onMove = (): void => {
      if (labelRaf) return;
      labelRaf = requestAnimationFrame(() => {
        labelRaf = 0;
        drawLabelsOverlay();
      });
    };
    map.on('move', onMove);

    const onClick = (event: MapMouseEvent) => {
      const targets = layersRef.current
        .filter((layer) => layer.visible && layer.kind === 'vector')
        .flatMap((layer) => [`lyr-${layer.id}`, `lyr-${layer.id}-line`, `lyr-${layer.id}-point`])
        .filter((id) => Boolean(map.getLayer(id)));
      if (targets.length === 0) {
        onSelectRef.current([]);
        return;
      }
      const features = map.queryRenderedFeatures(event.point, { layers: targets });
      onSelectRef.current(
        features.map((feature, index) => {
          const sourceId = typeof feature.source === 'string' ? feature.source : '';
          const layerId = sourceId.replace('src-', '');
          const layer = layersRef.current.find((item) => item.id === layerId);
          return {
            layerId,
            layerName: layer?.name ?? layerId,
            index,
            properties: (feature.properties ?? {}) as Record<string, unknown>,
            geometry: feature.geometry,
          };
        }),
      );
    };
    map.on('click', onClick);

    /**
     * 编辑手势：画笔 / 框选要用。
     *
     * 事件里已经带着地图算好的经纬度（event.lngLat），
     * 前端不用再自己反投影——自己算的话，缩放级别、投影细节都要重新对一遍，
     * 差一点点就会画到隔壁格子去。
     *
     * 「查看」工具下完全不上报：地图的拖拽、点选行为必须和今天一模一样。
     */
    const onMouseDown = (event: MapMouseEvent) => {
      if (editToolRef.current === 'view') return;
      onEditGestureRef.current?.({
        phase: 'down',
        x: event.point.x,
        y: event.point.y,
        lng: event.lngLat.lng,
        lat: event.lngLat.lat,
      });
    };
    const onMouseMove = (event: MapMouseEvent) => {
      if (editToolRef.current === 'view') return;
      onEditGestureRef.current?.({
        phase: 'move',
        x: event.point.x,
        y: event.point.y,
        lng: event.lngLat.lng,
        lat: event.lngLat.lat,
      });
    };
    const onMouseUp = (event: MapMouseEvent) => {
      if (editToolRef.current === 'view') return;
      onEditGestureRef.current?.({
        phase: 'up',
        x: event.point.x,
        y: event.point.y,
        lng: event.lngLat.lng,
        lat: event.lngLat.lat,
      });
    };
    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);

    const observer = new ResizeObserver(() => {
      syncOverlaySize();
      paintOverlay();
      drawLabelsOverlay();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(labelRaf);
      window.clearTimeout(labelRefreshTimerRef.current);
      map.off('idle', onIdle);
      map.off('move', onMove);
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', onMouseUp);
      map.remove();
      mapRef.current = null;
    };
  }, [paintOverlay, refreshRaster, syncOverlaySize, drawLabelsOverlay, refreshTileLabels]);

  // 图层变化 → 同步 source / layer
  useEffect(() => {
    if (!styleReady) return;
    syncLayers();
    syncOverlaySize();
    paintOverlay();
    // 样式（含标注字段）可能刚变：瓦片层的锚点要按新配置重取一次
    refreshTileLabels();
    drawLabelsOverlay();
  }, [styleReady, layers, syncLayers, syncOverlaySize, paintOverlay, refreshTileLabels, drawLabelsOverlay]);

  /**
   * 拉伸档位变了 → 重新出图。
   *
   * 为什么必须在这里主动重出：栅格底图是按视口缓存成 image source 的，
   * 不重新请求的话，用户切了档却什么都没变 —— 得平移一下才看得出差别，
   * 很容易被当成"这个开关没用"。
   */
  useEffect(() => {
    refreshRaster();
  }, [stretch, refreshRaster]);

  /**
   * 编辑工具接管地图手势。
   *
   * 平移、框选缩放（Shift + 拖）、双击缩放这三个都要让出来：
   * 不让的话，画笔一按下去地图就在动，笔迹会画到别的地方去。
   *
   * 滚轮缩放保留——用户常常要先把地图放大到能看清再动手。
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const editing = editTool !== 'view';
    if (editing) {
      map.dragPan.disable();
      map.boxZoom.disable();
      map.doubleClickZoom.disable();
    } else {
      map.dragPan.enable();
      map.boxZoom.enable();
      map.doubleClickZoom.enable();
    }
  }, [editTool]);

  // 编辑预览变了 → 重画覆盖层
  useEffect(() => {
    drawEditOverlay();
  }, [editPreview, drawEditOverlay]);

  // 矢量数据到货 → 灌进 geojson source
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    for (const [layerId, data] of vectorData) {
      const source = map.getSource(`src-${layerId}`) as GeoJSONSource | undefined;
      if (!source) continue;
      // 6.x 的 setData 返回 Promise：挂上 catch，免得图层已删时的拒绝变成未处理异常
      void source.setData(data as never).catch(() => undefined);
    }
    // 数据变了，标注的锚点与文本也要跟着变
    drawLabelsOverlay();
  }, [vectorData, styleReady, layers, drawLabelsOverlay]);

  /**
   * 矢量图层加载完 → 把视野挪到数据范围。
   *
   * 只做一次（每个图层记一次），否则用户手动缩放后会被拽回去。
   *
   * 恢复项目时例外：视角已经由清单里的 `view` 定好了，
   * 再自动挪一次就等于"恢复了个寂寞"——用户看到的还是数据范围，
   * 不是他上次走到的那个位置。
   */
  const shouldKeepView = useCallback((layerId: string): boolean => {
    return Boolean(initialViewRef.current) && preserveIdsRef.current.has(layerId);
  }, []);

  const fittedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    for (const [layerId, data] of vectorData) {
      if (fittedRef.current.has(layerId)) continue;
      if (shouldKeepView(layerId)) continue;
      // 分块（chunked）层：手里这份只是视口裁剪出的一小块，按它 fit 等于没动；
      // 视野交给 extents effect 按全量范围定 —— 别在这里抢先 fitted 掉
      if (layersRef.current.find((layer) => layer.id === layerId)?.chunked) continue;
      const bounds = geoJsonBounds(data);
      if (!bounds) continue;
      const safe = clampBounds(bounds);
      if (!safe) continue;
      fittedRef.current.add(layerId);
      map.fitBounds(
        [
          [safe[0], safe[1]],
          [safe[2], safe[3]],
        ],
        { padding: 48, duration: 0 },
      );
    }
  }, [vectorData, styleReady, shouldKeepView]);

  /**
   * 栅格图层 → 同样把视野挪到它的范围。
   *
   * 栅格底图是"按当前视口实时出图"的（引擎没有瓦片金字塔），
   * 所以视野不动的话，引擎会按旧视口出图，图与位置对不上。
   * 范围由引擎给（前端算不出栅格的范围）。
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    for (const [layerId, bbox] of extents) {
      if (fittedRef.current.has(layerId)) continue;
      if (shouldKeepView(layerId)) continue;
      if (!Array.isArray(bbox) || bbox.length !== 4) continue;
      const safe = clampBounds(bbox);
      if (!safe) continue;
      fittedRef.current.add(layerId);
      map.fitBounds(
        [
          [safe[0], safe[1]],
          [safe[2], safe[3]],
        ],
        { padding: 48, duration: 0 },
      );
    }
  }, [extents, styleReady, shouldKeepView]);

  // 选中的要素 → 高亮
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    const source = map.getSource(HIGHLIGHT_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    // 6.x 的 setData 返回 Promise：挂上 catch，免得图层已删时的拒绝变成未处理异常
    void source
      .setData({
        type: 'FeatureCollection',
        features: selectedFeatures.map((feature) => ({
          type: 'Feature',
          geometry: feature.geometry as never,
          // ⚠️ 必须**摊成普通对象**再交回去。
          //    MapLibre 的 queryRenderedFeatures 返回的 properties 是**无原型对象**
          //    （Object.create(null)），它的序列化器读 `e.constructor._classRegistryKey`
          //    时会炸："Cannot read properties of undefined (reading '_classRegistryKey')"。
          //    后果是**高亮图层整个不显示**，控制台还只报一个看不懂的二次异常。
          properties: { ...feature.properties },
        })),
      })
      .catch(() => undefined);
  }, [selectedFeatures, styleReady]);

  // 标题栏信息变了，图面要素要重画
  useEffect(() => {
    paintOverlay();
  }, [sheetMeta, paintOverlay]);

  /**
   * 导出当前视口。
   *
   * 合成顺序：白底 → 地图画面 → 图面要素。
   * 图面要素在这里**重画一遍**（而不是直接贴屏幕上的覆盖层），
   * 因为覆盖层是按 96 DPI 的屏幕尺寸画的，PDF 是 150 DPI 的纸张，
   * 直接贴会让标题栏在纸面上偏小；重画时按 150×设备像素比 给 DPI，
   * 于是图面要素在纸上的物理尺寸与屏幕上基本一致。
   */
  useImperativeHandle(
    ref,
    () => ({
      exportJpeg: (options) => {
        const quality = options?.quality ?? 0.92;
        const map = mapRef.current;
        if (!map) return null;
        const source = map.getCanvas();
        const width = source.width;
        const height = source.height;
        if (width <= 0 || height <= 0) return null;

        const out = document.createElement('canvas');
        out.width = width;
        out.height = height;
        const ctx = out.getContext('2d');
        if (!ctx) return null;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(source, 0, 0);

        // 标注：屏幕上是 2D 覆盖层，导出时用同一套逻辑重画到纸面上。
        // 瓦片层先按当前渲染要素刷新一次锚点，保证导出这一刻的标注是全的。
        refreshTileLabels();
        const cssWidth = map.getCanvas().clientWidth || width;
        const labelScale = width / cssWidth;
        paintLabelEntries(
          ctx,
          collectLabelEntries(),
          (lngLat) => map.project(lngLat),
          labelScale,
          cssWidth,
          height / labelScale,
        );

        const dpr = window.devicePixelRatio || 1;
        const center = map.getCenter();
        // 每设备像素对应的地面米数：MapLibre 的比例尺是按 CSS 像素算的
        const metersPerDevicePixel = metersPerPixelAt(map.getZoom(), center.lat) / dpr;
        drawSheet(ctx, {
          width,
          height,
          dpi: EXPORT_DPI * dpr,
          title: sheetMetaRef.current.title,
          operator: sheetMetaRef.current.operator,
          producedAt: options?.producedAt ?? sheetMetaRef.current.producedAt,
          metersPerPixel: metersPerDevicePixel,
          // 引擎会把图缩放到 A4 页面里，比例尺必须按缩放后的真实情况标
          scaleDenominator: pdfScaleDenominator(width, height, metersPerDevicePixel),
          legend: legend(),
        });

        return { jpeg: out.toDataURL('image/jpeg', quality), width, height };
      },
      getView: () => {
        const map = mapRef.current;
        if (!map) return null;
        const center = map.getCenter();
        return { center: [center.lng, center.lat], zoom: map.getZoom() };
      },
      refresh: async () => {
        const map = mapRef.current;
        if (!map) return;
        const bbox = currentBBox(map);
        const { width, height } = rasterSize(map);
        const rasters = layersRef.current.filter((layer) => layer.kind === 'raster' && layer.visible);
        await Promise.all(
          rasters.map(async (layer) => {
            const source = map.getSource(`src-${layer.id}`);
            if (!source) return;
            // 时间戳绕开浏览器缓存：不加的话拿到的还是改动前那张图
            const url = buildRasterUrl(layer.path, {
              width,
              height,
              bbox,
              cacheBust: Date.now(),
              stretch: stretchRef.current,
            });
            const image = await loadImageElement(url);
            const coordinates: Coordinates = [
              [bbox[0], bbox[3]],
              [bbox[2], bbox[3]],
              [bbox[2], bbox[1]],
              [bbox[0], bbox[1]],
            ];
            (source as ImageSource).updateImage({ image, coordinates });
          }),
        );
        await waitForIdle(map);
      },
      getViewport: () => {
        const map = mapRef.current;
        if (!map) return null;
        const bounds = map.getBounds();
        const canvas = map.getCanvas();
        return {
          bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] as const,
          width: canvas.clientWidth,
          height: canvas.clientHeight,
        };
      },
    }),
    [legend, buildRasterUrl, currentBBox, rasterSize, collectLabelEntries, paintLabelEntries, refreshTileLabels],
  );

  return (
    <div className="relative h-full w-full" ref={stageRootRef}>
      {/*
        容器要**套一层**：MapLibre 会给自己的容器加上 .maplibregl-map，
        而 maplibre-gl.css 是**无层级**样式（Tailwind 的类在 @layer utilities 里）——
        无层级永远压过有层级，所以 `.maplibregl-map{position:relative}`
        会盖掉我们写在容器上的 `absolute`，容器高度塌成 0，地图一片空白。
        套一层由 Tailwind 掌控的 wrapper，MapLibre 的容器只负责 `h-full w-full`。
      */}
      <div className="absolute inset-0">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      <canvas
        ref={labelRef}
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
      />
      <canvas
        ref={overlayRef}
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
      />
      {/*
        图例：独立的界面层（z-20，高于画布），可拖动、可调透明度、可折叠。
        刻意**不**画进上面的 canvas —— 画布是"直接编辑图像"的地方，
        压在上面的说明会挡事（2026-11-16 用户裁定）。
      */}
      <LegendPanel items={legend()} containerRef={stageRootRef} />
      {engineError ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-studio/92 p-6">
          <div
            className="max-w-[520px] rounded-panel border border-studio-line bg-studio-2 p-5"
            style={{ boxShadow: 'var(--studio-stage-shadow)' }}
          >
            <h2 className="font-display mb-2 text-[16px] font-semibold text-studio-ink">引擎服务未启动</h2>
            <p className="mb-2.5 text-[13.5px] leading-relaxed text-studio-ink-2">
              请在仓库根目录运行{' '}
              <code className="rounded bg-studio-3 px-1 font-mono text-studio-ink">npm run dev:server</code>
              ，启动后再点右上角的「重新体检」。
            </p>
            <p className="text-[12.5px] leading-relaxed text-studio-ink-3">
              引擎地址：
              <code className="rounded bg-studio-3 px-1 font-mono text-studio-ink-2">{engineBase}</code>
              <br />
              详情：{engineError}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
