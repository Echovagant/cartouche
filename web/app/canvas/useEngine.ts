/**
 * 引擎服务调用的统一封装。
 *
 * 为什么单独抽一个 hook：
 *   - 画布上每个动作（出图、查矢量、出报告、导 PDF）都要打同一个引擎，
 *     URL 拼接、错误翻译、加载态散在各组件里必然走样；
 *   - 引擎的失败形态有四种：进程没起、GDAL 缺失、路径越界、文件打不开，
 *     返回的都是 JSON 错误体，这里统一翻成能直接显示的中文。
 *
 * 跨域前提（重要）：
 *   引擎只监听 127.0.0.1，且所有响应带 `Access-Control-Allow-Origin: null`。
 *   浏览器直连能通的前提是**页面自身的 Origin 就是 null**（桌面壳用 file:// 加载静态产物），
 *   此时 null 与 null 相等，跨域校验通过。
 *   若把页面挂在 http://localhost:3000 上跑，Origin 是 http://localhost:3000，
 *   与引擎放行的 null 不匹配，请求会被浏览器拦掉——这属于部署形态的限制，
 *   不是前端能绕过去的（改引擎的 CORS 头超出本目录的边界）。
 *
 * `root`：
 *   打开项目后，画布里的一切路径都相对**项目根**，引擎靠 `root=<项目根绝对路径>`
 *   把它定位回去。给了这个参数，所有请求都带上它；不给就保持今天的行为
 *   （相对默认工作区根）。根变了，下面的回调身份也跟着变（依赖数组里有 root），
 *   否则会出现"换了项目还在用旧根发请求"。
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  EditOp,
  OpExecuteResult,
  OpPreview,
  RasterGrid,
} from './types';
import { ENGINE_BASE } from '../engine-base';
import { engineFetch, engineToken, withEngineToken } from '../engine-auth';

/** 引擎健康检查的返回体：画布据此判断"引擎在不在、能不能干活" */
export interface EngineInfo {
  readonly ok: boolean;
  readonly name: string;
  readonly version: string;
  readonly ops: number;
  readonly workspaceRoot: string;
}

/** 矢量图层加载请求的返回体：GeoJSON 本体 + 口径说明 */
export interface GeoJsonPayload {
  readonly geojson: unknown;
  readonly featureCount: number;
  readonly truncated: boolean;
  /** 多图层源的加载说明（只装了第一层、有几层没装之类）。服务端一直有，前端原先没接 */
  readonly note?: string;
  /** 多图层源里没能转换出来的图层名 */
  readonly skippedLayers?: readonly string[];
  /** 实际装进来的图层名（多图层源或明确选层时才有） */
  readonly layers?: readonly string[];
}

/** 多图层容器的图层清单（图层选择器的数据源） */
export interface VectorLayersPayload {
  readonly path: string;
  readonly layerNames: readonly string[];
}

export interface CompatReportPayload {
  readonly markdown: string;
  readonly hasBlocker: boolean;
  readonly manualChecks: readonly string[];
}

/** 视口金字塔（构建/缓存查询）的返回体 */
export interface PyramidPayload {
  readonly hash: string;
  /** 建成的层级（粗→细）；空数组 = 该源不适合建塔（点层/太小/多图层容器） */
  readonly levels: readonly {
    readonly name: string;
    readonly tolerance: number;
    readonly bytes: number;
    readonly zoomMax: number;
  }[];
  /** levels 为空时的说明 */
  readonly note?: string;
  /** 未建成的级别与原因 */
  readonly skipped?: readonly string[];
  /** true = 缓存已存在，没有重新构建 */
  readonly cached?: boolean;
}

/** 低倍瓦片预热结果（disabled = 引擎侧关闭了预热） */
export interface MvtWarmPayload {
  readonly disabled?: boolean;
  readonly tiles?: number;
  readonly generated?: number;
  readonly cached?: number;
  readonly bytes?: number;
  readonly ms?: number;
  readonly maxZoom?: number;
}

/** 数据集的地理范围（EPSG:4326，lon/lat 序） */
export interface ExtentPayload {
  /** [minX, minY, maxX, maxY] */
  readonly bbox: readonly [number, number, number, number];
  readonly kind: 'raster' | 'vector';
  readonly sourceEpsg: number | null;
  readonly reprojected: boolean;
  /** 源文件字节数（目录型数据源为 null） */
  readonly bytes: number | null;
  /** 矢量源的图层名（矢量才有，保持文件内顺序） */
  readonly layerNames?: readonly string[];
}

/** 所有引擎调用统一返回这个形状：调用点不用写 try/catch，也不会漏掉错误分支 */
export type Result<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: string;
      /**
       * 机器可读错误码（如 payload_too_large / aborted），没有就不带。
       * 调用点要**区分处理**的失败靠它，不靠解析 message 字符串。
       */
      readonly code?: string;
    };

export type HealthStatus = 'checking' | 'ready' | 'offline';

export interface HealthState {
  readonly status: HealthStatus;
  readonly info: EngineInfo | null;
  readonly error: string | null;
}

export interface RasterUrlOptions {
  readonly width: number;
  readonly height: number;
  /** EPSG:4326 的 [minX, minY, maxX, maxY]（不是 GDAL 的 ulx/uly/lrx/lry） */
  readonly bbox?: readonly [number, number, number, number];
  /** 传时间戳绕开浏览器缓存（同一视口重复出图时用） */
  readonly cacheBust?: number;
  /**
   * 栅格显示的拉伸档位。
   *
   * 不给（undefined）= 自动：引擎按源类型决定 —— 8 位按原样、16 位按实际亮度。
   * 必须是 undefined 而不是 'auto'：直接发 auto 会把 8 位影像的显示行为也改掉
   * （8 位现在是不拉伸的，那是既有行为，不该被这个开关顺手改掉）。
   */
  readonly stretch?: 'auto' | 'none';
}

export interface PdfPayload {
  /** data:image/jpeg;base64,... */
  readonly jpeg: string;
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly operator: string;
  /**
   * 页面尺寸（点；1 点 = 1/72 英寸）。
   *
   * 不给就用引擎默认的 A4 横向 —— 出图版式里选了 A3 或竖版时，
   * 不传这两个值，出来的 PDF 还是 A4 横向：**版式与图纸对不上**。
   */
  readonly pageWidthPt?: number;
  readonly pageHeightPt?: number;
}

export interface EngineApi {
  readonly base: string;
  readonly health: HealthState;
  /** 正在执行的操作（键 → 是否进行中） */
  readonly pending: Readonly<Record<string, boolean>>;
  /** 最近一次错误，供全局提示条显示 */
  readonly error: string | null;
  readonly isPending: (key: string) => boolean;
  readonly reloadHealth: () => void;
  readonly listDir: (path?: string) => Promise<Result<string[]>>;
  readonly fetchGeoJson: (
    path: string,
    options?: {
      /** 要素数上限 */
      limit?: number;
      /**
       * 视口裁剪（EPSG:4326 的 [minX, minY, maxX, maxY]）：只回与视口相交且裁剪到
       * 视口内的要素。大文件的分块加载靠它 —— 引擎侧 -clipdst 已就位（第一阶段）。
       */
      bbox?: readonly [number, number, number, number];
      /** pyramid=auto：引擎缓存里有视口金字塔就按 zoom 挑一级，从小缓存裁 */
      pyramid?: boolean;
      /** 当前地图 zoom（挑金字塔级用；不传引擎按中档处理） */
      zoom?: number;
      /** 图层选择器：只装这些图层（多图层容器）；不装就维持引擎默认语义 */
      layers?: readonly string[];
      /** 中止请求：moveend 连续触发时打断上一次还没回来的裁剪 */
      signal?: AbortSignal;
    },
  ) => Promise<Result<GeoJsonPayload>>;
  /** 预建视口金字塔（幂等；引擎对并发构建按 hash 去重，有缓存直接短路） */
  readonly buildPyramid: (path: string) => Promise<Result<PyramidPayload>>;
  /** 列多图层容器里的图层清单（图层选择器点开时才调；探测几百毫秒） */
  readonly fetchVectorLayers: (path: string) => Promise<Result<VectorLayersPayload>>;
  readonly fetchExtent: (path: string) => Promise<Result<ExtentPayload>>;
  /**
   * 拼 MVT 瓦片模板 URL（z/x/y 占位符原样保留，由 MapLibre 替换）。
   *
   * 令牌进查询串：瓦片是 MapLibre 自己发的 GET，加不了请求头。
   */
  readonly vectorTileUrl: (path: string) => string;
  /**
   * 后台预热低倍瓦片（z0–N 一次切好）。
   *
   * 大源第一次看低倍视图要几十秒；预热完成后低倍直接命中缓存。
   * 引擎按源去重、已有缓存时秒回；设 CARTOUCHE_MVT_WARM_MAXZOOM=0 可关闭。
   */
  readonly warmMvtTiles: (path: string, layerName?: string) => Promise<Result<MvtWarmPayload>>;
  readonly rasterUrl: (path: string, options: RasterUrlOptions) => string;
  readonly fetchCompatReport: (path: string) => Promise<Result<CompatReportPayload>>;
  readonly exportPdf: (payload: PdfPayload) => Promise<Result<Blob>>;
  /** 取栅格的原生像元网格（把屏幕坐标换算成像元坐标的唯一依据） */
  readonly fetchRasterGrid: (path: string) => Promise<Result<RasterGrid>>;
  /** 预演一条操作：只算影响面，不落盘 */
  readonly previewOp: (op: EditOp) => Promise<Result<OpPreview>>;
  /** 执行一条操作（真的改文件） */
  readonly executeOp: (op: EditOp) => Promise<Result<OpExecuteResult>>;
}

/** 统一的取 JSON：把"连不上"和"服务端报错"翻译成可读的中文 */
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await engineFetch(url, init);
  } catch (err) {
    throw new Error(
      `无法连接引擎服务 ${ENGINE_BASE}（请确认已运行 npm run dev:server）：${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      if (body?.message) detail = body.message;
      if (body?.error) code = body.error;
    } catch {
      /* 错误体不是 JSON（例如代理返回的 HTML），保留状态码 */
    }
    const err = new Error(detail);
    if (code) (err as { code?: string }).code = code;
    throw err;
  }
  return (await res.json()) as T;
}

/** 引擎服务列表接口的返回体 */
interface ListResponse {
  readonly entries: string[];
}

export function useEngine(root?: string | null): EngineApi {
  const [health, setHealth] = useState<HealthState>({ status: 'checking', info: null, error: null });
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  /**
   * 所有网络调用的统一包装：登记加载态、捕获错误、返回 Result。
   * 调用点只需判断 ok，不必各自写 try/catch —— 漏掉的错误分支正是"引擎没起
   * 之后白屏"这类问题的来源。
   */
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<Result<T>> => {
    setPending((prev) => ({ ...prev, [key]: true }));
    try {
      const data = await fn();
      setError(null);
      return { ok: true, data };
    } catch (err) {
      const message = (err as Error).message || String(err);
      setError(message);
      // 请求被中止（moveend 连续触发打断上一次）不是故障：带上 aborted 码让调用点静默处理
      const code =
        err instanceof DOMException && err.name === 'AbortError'
          ? 'aborted'
          : (err as { code?: string }).code;
      return code ? { ok: false, error: message, code } : { ok: false, error: message };
    } finally {
      setPending((prev) => ({ ...prev, [key]: false }));
    }
  }, []);

  const checkHealth = useCallback(async () => {
    setHealth((prev) => ({ ...prev, status: 'checking' }));
    const res = await run('health', () => requestJson<EngineInfo>(`${ENGINE_BASE}/api/health`));
    if (res.ok) {
      setHealth({ status: 'ready', info: res.data, error: null });
    } else {
      setHealth({ status: 'offline', info: null, error: res.error });
    }
  }, [run]);

  // 引擎是独立进程，可能在我们之后才启动；首检失败时定时重试，别让用户手动刷新
  const statusRef = useRef<HealthStatus>('checking');
  statusRef.current = health.status;
  useEffect(() => {
    void checkHealth();
    const timer = setInterval(() => {
      if (statusRef.current !== 'ready') void checkHealth();
    }, 5000);
    return () => clearInterval(timer);
  }, [checkHealth]);

  const listDir = useCallback(
    (path = '') =>
      run('list', async () => {
        // path 一律相对 root；不给 root 就是相对默认根（今天的行为）
        const params = new URLSearchParams();
        if (path) params.set('path', path);
        if (root) params.set('root', root);
        const data = await requestJson<ListResponse>(`${ENGINE_BASE}/api/fs/list?${params.toString()}`);
        return [...data.entries].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      }),
    [run, root],
  );

  const fetchGeoJson = useCallback(
    (
      path: string,
      options?: {
        limit?: number;
        bbox?: readonly [number, number, number, number];
        pyramid?: boolean;
        zoom?: number;
        layers?: readonly string[];
        signal?: AbortSignal;
      },
    ) =>
      run('geojson', async () => {
        const params = new URLSearchParams({ path });
        if (options?.limit !== undefined) params.set('limit', String(options.limit));
        if (options?.bbox) params.set('bbox', options.bbox.map((n) => n.toFixed(8)).join(','));
        if (options?.pyramid) params.set('pyramid', 'auto');
        if (options?.zoom !== undefined) params.set('zoom', String(options.zoom));
        // 图层名可能含逗号（KML 常见），所以一个图层一个 layer= 参数，不做逗号拼接
        for (const name of options?.layers ?? []) params.append('layer', name);
        if (root) params.set('root', root);
        return requestJson<GeoJsonPayload>(
          `${ENGINE_BASE}/api/data/geojson?${params.toString()}`,
          options?.signal ? { signal: options.signal } : undefined,
        );
      }),
    [run, root],
  );

  /** 预建视口金字塔：fire-and-forget 也能用（引擎并发去重 + 缓存短路） */
  const buildPyramid = useCallback(
    (path: string) =>
      run('pyramid', () =>
        requestJson<PyramidPayload>(`${ENGINE_BASE}/api/data/pyramid`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // root 为空时**不要**带这个键：不带才是"相对默认根"的语义
          body: JSON.stringify({ path, ...(root ? { root } : {}) }),
        }),
      ),
    [run, root],
  );

  /** 列多图层容器的图层清单（图层选择器数据源） */
  const fetchVectorLayers = useCallback(
    (path: string) =>
      run('layers', async () => {
        const params = new URLSearchParams({ path });
        if (root) params.set('root', root);
        return requestJson<VectorLayersPayload>(`${ENGINE_BASE}/api/data/layers?${params.toString()}`);
      }),
    [run, root],
  );

  /**
   * 查数据集的地理范围（统一换算到 EPSG:4326）。
   *
   * 画布靠它把视野移到数据上——不查就是一张空白图。
   * 栅格的范围只有 GDAL 知道，所以矢量、栅格统一走这个接口，不在前端各算各的。
   */
  const fetchExtent = useCallback(
    (path: string) =>
      run('extent', async () => {
        const query = new URLSearchParams({ path });
        if (root) query.set('root', root);
        return requestJson<ExtentPayload>(`${ENGINE_BASE}/api/data/extent?${query.toString()}`);
      }),
    [run, root],
  );

  /**
   * 拼 MVT 瓦片模板 URL。
   *
   * ⚠️ 不用 URLSearchParams / withEngineToken 拼：这两个都会把 `{z}` 编码成
   * `%7Bz%7D`，MapLibre 就找不到占位符、发不出瓦片请求。
   */
  const vectorTileUrl = useCallback(
    (path: string) => {
      const token = engineToken();
      const query =
        `path=${encodeURIComponent(path)}&z={z}&x={x}&y={y}` +
        (root ? `&root=${encodeURIComponent(root)}` : '') +
        (token ? `&token=${encodeURIComponent(token)}` : '');
      return `${ENGINE_BASE}/api/data/mvt?${query}`;
    },
    [root],
  );

  /** 后台预热低倍瓦片：请求可能持续几分钟，调用点应 fire-and-forget */
  const warmMvtTiles = useCallback(
    (path: string, layerName?: string) =>
      run('mvt-warm', () =>
        requestJson<MvtWarmPayload>(`${ENGINE_BASE}/api/data/mvt/warm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path,
            ...(root ? { root } : {}),
            ...(layerName ? { layer: layerName } : {}),
          }),
        }),
      ),
    [run, root],
  );

  /**
   * 只拼 URL，不发请求——栅格图交给 MapLibre 的 image source 去加载，
   * 由它管理并发与生命周期，前端不重复造轮子。
   */
  const rasterUrl = useCallback(
    (path: string, options: RasterUrlOptions) => {
      const params = new URLSearchParams({
        path,
        width: String(Math.max(1, Math.round(options.width))),
        height: String(Math.max(1, Math.round(options.height))),
      });
      if (options.bbox) {
        params.set('bbox', options.bbox.map((n) => n.toFixed(8)).join(','));
      }
      if (options.cacheBust !== undefined) params.set('t', String(options.cacheBust));
      // 只在用户手动切过档时才带这个参数：「自动」态不发，
      // 发 stretch=auto 会把 8 位影像的显示行为也改掉（既有的不拉伸）。
      if (options.stretch) params.set('stretch', options.stretch);
      // root 必须进查询串（不是 body）：这张图是 MapLibre 用 <img> 直接拉的
      if (root) params.set('root', root);
      return withEngineToken(`${ENGINE_BASE}/api/render/raster.png?${params.toString()}`);
    },
    [root],
  );

  const fetchCompatReport = useCallback(
    (path: string) =>
      run('report', async () => {
        const res = await engineFetch(`${ENGINE_BASE}/api/report/compat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // root 为空时**不要**带这个键：不带才是"相对默认根"的语义
          body: JSON.stringify({ path, ...(root ? { root } : {}) }),
        });
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const body = (await res.json()) as { message?: string };
            if (body?.message) detail = body.message;
          } catch {
            /* 错误体不是 JSON，保留状态码 */
          }
          throw new Error(detail);
        }
        return (await res.json()) as CompatReportPayload;
      }),
    [run, root],
  );

  const exportPdf = useCallback(
    (payload: PdfPayload) =>
      run('export', async () => {
        const res = await engineFetch(`${ENGINE_BASE}/api/export/pdf`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const body = (await res.json()) as { message?: string };
            if (body?.message) detail = body.message;
          } catch {
            /* 错误体不是 JSON，保留状态码 */
          }
          throw new Error(detail);
        }
        return await res.blob();
      }),
    [run],
  );

  /**
   * 取栅格的原生像元网格。
   *
   * 画笔/框选要把屏幕坐标换算成**目标栅格的像元坐标**，
   * 唯一可靠的依据是 GDAL 的仿射变换（geotransform）与栅格自身的坐标系（crs）。
   * 前端自己按经纬度"猜"像元位置一定会有偏差。
   */
  const fetchRasterGrid = useCallback(
    (path: string) =>
      run('grid', async () => {
        const params = new URLSearchParams({ path });
        if (root) params.set('root', root);
        const data = await requestJson<RasterGrid>(`${ENGINE_BASE}/api/raster/grid?${params.toString()}`);
        return {
          width: data.width,
          height: data.height,
          ...(data.bandCount === undefined ? {} : { bandCount: data.bandCount }),
          geotransform: [
            data.geotransform[0],
            data.geotransform[1],
            data.geotransform[2],
            data.geotransform[3],
            data.geotransform[4],
            data.geotransform[5],
          ] as [number, number, number, number, number, number],
          // 坐标系的判定整段透传：前端只认引擎给的 is4326 结论
          crs: {
            present: data.crs?.present === true,
            epsg: data.crs?.epsg ?? null,
            authority: data.crs?.authority ?? null,
            source: data.crs?.source ?? 'none',
            wkt: data.crs?.wkt ?? null,
            is4326: data.crs?.is4326 === true,
          },
          epsg: data.epsg ?? data.crs?.epsg ?? null,
        };
      }),
    [run, root],
  );

  /**
   * 预演一条操作：引擎算好影响面返回，**不落盘**。
   *
   * 这一步是"四道闸门"的第一道：用户看到的像元数、目标文件、备份文件名
   * 都来自这里，不是前端自己估的。
   */
  const previewOp = useCallback(
    (op: EditOp) =>
      run('preview', async () => {
        const res = await engineFetch(`${ENGINE_BASE}/api/op/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: op.op, params: op.params, ...(root ? { root } : {}) }),
        });
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const body = (await res.json()) as { message?: string };
            if (body?.message) detail = body.message;
          } catch {
            /* 错误体不是 JSON，保留状态码 */
          }
          throw new Error(detail);
        }
        return (await res.json()) as OpPreview;
      }),
    [run, root],
  );

  /**
   * 执行一条操作：真的改文件。
   *
   * `root` 与 `projectRoot` 都给成项目根：前者用来定位相对路径，
   * 后者决定留痕（history.jsonl）与清单写到哪里。
   *
   * `confirmed: true` 是"用户已经在确认卡上点过确认"的标记，
   * 引擎会把它记进留痕的 impact 里（审计用）——所以只能在确认之后才发。
   *
   * 注意语义：某条 op 失败时**前面已生效的条目不会回滚**，
   * 所以返回体里的 completed / failedAt 要如实转达，不能当成"整体失败"。
   */
  const executeOp = useCallback(
    (op: EditOp) =>
      run('execute', async () => {
        const res = await engineFetch(`${ENGINE_BASE}/api/op/execute`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            op: op.op,
            params: op.params,
            confirmed: true,
            ...(root ? { root, projectRoot: root } : {}),
          }),
        });
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const body = (await res.json()) as { message?: string };
            if (body?.message) detail = body.message;
          } catch {
            /* 错误体不是 JSON，保留状态码 */
          }
          throw new Error(detail);
        }
        return (await res.json()) as OpExecuteResult;
      }),
    [run, root],
  );

  const isPending = useCallback((key: string) => pending[key] === true, [pending]);
  return useMemo(
    () => ({
      base: ENGINE_BASE,
      health,
      pending,
      error,
      isPending,
      reloadHealth: () => {
        void checkHealth();
      },
      listDir,
      fetchGeoJson,
      fetchExtent,
      buildPyramid,
      fetchVectorLayers,
      vectorTileUrl,
      warmMvtTiles,
      rasterUrl,
      fetchCompatReport,
      exportPdf,
      fetchRasterGrid,
      previewOp,
      executeOp,
    }),
    [
      health,
      pending,
      error,
      isPending,
      checkHealth,
      listDir,
      fetchGeoJson,
      fetchExtent,
      buildPyramid,
      fetchVectorLayers,
      vectorTileUrl,
      warmMvtTiles,
      rasterUrl,
      fetchCompatReport,
      exportPdf,
      fetchRasterGrid,
      previewOp,
      executeOp,
    ],
  );
}
