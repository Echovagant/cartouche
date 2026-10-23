'use client';

/**
 * 画布上的编辑工具状态机。
 *
 * 工具条、画布手势、确认卡三样东西要共用同一份状态：
 * 选了什么工具、正在画什么、能不能画、最后变成哪条操作。
 * 状态收在这个 hook 里，是因为它们**必须是一致的**——
 * 屏幕上的笔迹、发给引擎的像元矩形、确认卡上写的目标文件，
 * 三者一旦各存一份，出现"看着画在 A、实际改在 B"这类 bug 时极难定位。
 *
 * 坐标换算的分工（2026-10-23 改）：
 *   屏幕点（像素） → 经纬度 → **引擎换算** → 原生像元 → 像元矩形/遮罩。
 *   中间那一步必须由引擎做：浏览器里没有投影能力，
 *   而 CGCS2000 3 度带这类底图的原生坐标是**米**，
 *   拿经纬度去按 geotransform 反算（度当米用）会画到天边去，
 *   而且"看着像画过一笔"，用户根本发现不了。
 *   所以前端只负责发经纬度、收像元，不自己反算。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeBlockedReasons, type ToolBlockedReasons } from './editAvailability';
import {
  encodeBase64,
  isWgs84Grid,
  nativeScaleFromCorners,
  rasterizeStroke,
  regionFromPoints,
  viewportCorners,
  type PixelPoint,
} from './editGeometry';
import { ENGINE_BASE } from './useEngine';
import type {
  BrushMask,
  EditGesture,
  EditOp,
  EditPreview,
  EditTool,
  GeoScreenPoint,
  RasterGrid,
  ViewportSnapshot,
} from './types';
import type { Result } from './useEngine';

/**
 * 遮罩的像元数上限。
 *
 * 遮罩是 base64 的字节图，区域一大请求体就撑爆了。
 * 超过这个量级就不该用画笔，应该改用框选（框选只传四个角）。
 */
const MAX_MASK_PIXELS = 4_194_304;

/** 构造一条操作的结果 */
export type BuildResult =
  | { readonly ok: true; readonly op: EditOp }
  | { readonly ok: false; readonly message: string };

/**
 * 一次换算（经纬度 → 原生像元）的结果。
 *
 * `key` 是请求点的签名：只有签名与当前笔迹/框完全一致，
 * 缓存里的像元坐标才作数（换算在途时用户可能又画了一笔）。
 */
interface Conversion {
  readonly key: string;
  readonly status: 'pending' | 'ready' | 'error';
  /** 视窗四角的像元坐标（笔宽换算用） */
  readonly cornerPixels: readonly PixelPoint[];
  /** 笔迹/框的点的像元坐标 */
  readonly pointPixels: readonly PixelPoint[];
  readonly error: string | null;
}

/** 换算请求：视窗四角（可空）+ 笔迹/框的点 */
interface ConversionRequest {
  readonly key: string;
  readonly corners: readonly (readonly [number, number])[];
  readonly points: readonly (readonly [number, number])[];
}

/**
 * 请求点的签名。
 *
 * 用 JSON 而不是自己拼字符串：坐标是浮点数，拼字符串容易出现
 * "看起来一样、其实差一个 ulp"的情况（那样缓存会莫名其妙地不命中）。
 */
function signatureOf(
  path: string | null,
  corners: readonly (readonly [number, number])[],
  points: readonly (readonly [number, number])[],
): string {
  return JSON.stringify([path, corners, points]);
}

export interface UseEditToolsOptions {
  /** 被编辑的栅格（相对项目根的路径）；null = 还没选栅格 */
  readonly targetPath: string | null;
  /** 取栅格的原生像元网格 */
  readonly fetchGrid: (path: string) => Promise<Result<RasterGrid>>;
  /** 当前视口（笔宽换算要用） */
  readonly getViewport: () => ViewportSnapshot | null;
  /** 笔宽（屏幕像素） */
  readonly brushWidth: number;
  /** 画笔抬手时回调（这一刻就该把这一笔变成一条操作去预演） */
  readonly onBrushEnd?: () => void;
}

export interface EditToolsApi {
  readonly tool: EditTool;
  readonly setTool: (tool: EditTool) => void;
  /** 已经拿到的栅格网格 */
  readonly grid: RasterGrid | null;
  /**
   * 每个工具各自的不可用原因（null = 可用）。
   *
   * 不是一个全局字符串：画笔/框选受"栅格有没有坐标系"限制
   * （**不是**"是不是 4326"——投影坐标系的底图照样能画），
   * 调色不受（引擎侧的调色是整幅逐像元算的，跟坐标系无关）。
   */
  readonly blockedByTool: ToolBlockedReasons;
  /** 画在覆盖层上的编辑预览 */
  readonly preview: EditPreview | null;
  /** 框选是否已经画出来（且它的像元坐标已经换算好） */
  readonly hasBox: boolean;
  /** 地图把指针事件交过来 */
  readonly onGesture: (gesture: EditGesture) => void;
  /** 清掉当前笔迹 / 框选 */
  readonly resetGesture: () => void;
  /** 框选 → 涂色 / 擦除 */
  readonly buildRegionOp: (kind: 'paint' | 'erase', color: string) => BuildResult;
  /** 笔迹 → 带遮罩的涂色 */
  readonly buildBrushOp: (color: string) => BuildResult;
}

export function useEditTools({
  targetPath,
  fetchGrid,
  getViewport,
  brushWidth,
  onBrushEnd,
}: UseEditToolsOptions): EditToolsApi {
  const [tool, setTool] = useState<EditTool>('view');
  const [grid, setGrid] = useState<RasterGrid | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const [gridLoading, setGridLoading] = useState(false);
  const [stroke, setStroke] = useState<readonly GeoScreenPoint[]>([]);
  const [box, setBox] = useState<readonly [GeoScreenPoint, GeoScreenPoint] | null>(null);
  /** 最近一次换算的状态（给界面用：框选按钮什么时候可以点） */
  const [conversion, setConversion] = useState<Conversion | null>(null);

  // 手势进行中：mousemove 只有按住时才记点
  const downRef = useRef(false);
  const gridRef = useRef<RasterGrid | null>(null);
  gridRef.current = grid;
  /**
   * 笔迹与框选各留一份 ref。
   *
   * 抬手那一刻要立刻拿笔迹去预演，而 React 的 setState 还没生效——
   * 读 state 会拿到上一帧的笔迹（最后一小段丢失）。
   * 读 ref 拿到的永远是"刚刚记下的那一笔"。
   */
  const strokeRef = useRef<readonly GeoScreenPoint[]>([]);
  const boxRef = useRef<readonly [GeoScreenPoint, GeoScreenPoint] | null>(null);
  const viewportRef = useRef<ViewportSnapshot | null>(null);
  const brushWidthRef = useRef(brushWidth);
  brushWidthRef.current = brushWidth;
  const getViewportRef = useRef(getViewport);
  getViewportRef.current = getViewport;
  const onBrushEndRef = useRef(onBrushEnd);
  onBrushEndRef.current = onBrushEnd;
  const targetPathRef = useRef(targetPath);
  targetPathRef.current = targetPath;
  /**
   * 换算结果的 ref（与 state 同源）。
   *
   * 为什么两份：换算完成的那一刻要把这一笔交给上层（预演），
   * 而那一刻 setState 还没生效——读 state 会拿到"还没算好"的旧值。
   */
  const conversionRef = useRef<Conversion | null>(null);

  /** 同时更新 ref 与 state（换算是异步的，两处都要跟上） */
  const publishConversion = useCallback((next: Conversion | null) => {
    conversionRef.current = next;
    setConversion(next);
  }, []);

  /* ───────── 栅格网格 ───────── */

  useEffect(() => {
    if (!targetPath) {
      setGrid(null);
      setGridError(null);
      return;
    }
    let cancelled = false;
    setGridLoading(true);
    void fetchGrid(targetPath).then((res) => {
      if (cancelled) return;
      setGridLoading(false);
      if (!res.ok) {
        setGrid(null);
        setGridError(res.error);
        return;
      }
      setGrid(res.data);
      setGridError(null);
    });
    return () => {
      cancelled = true;
    };
  }, [targetPath, fetchGrid]);

  /* ───────── 手势 ───────── */

  const resetGesture = useCallback(() => {
    downRef.current = false;
    strokeRef.current = [];
    boxRef.current = null;
    setStroke([]);
    setBox(null);
    publishConversion(null);
  }, [publishConversion]);

  // 换工具时把上一个工具留下的笔迹清掉：
  // 留着的话，切到框选时屏幕上还挂着上一条笔迹，看起来像选区
  const changeTool = useCallback(
    (next: EditTool) => {
      resetGesture();
      setTool(next);
    },
    [resetGesture],
  );

  /* ───────── 坐标换算（经纬度 → 原生像元，引擎做） ───────── */

  /**
   * 发起一次换算。
   *
   * 一次请求把**视窗四角**与**笔迹/框的点**一起发过去：
   *   - 笔迹/框的点 → 画在哪几个像元上；
   *   - 视窗四角 → 笔宽换算（"一个屏幕像素值多少原生像元"）。
   * 一次请求、一次投影换算，省得每个点都跑一遍。
   */
  const requestConversion = useCallback(
    async (req: ConversionRequest): Promise<void> => {
      publishConversion({
        key: req.key,
        status: 'pending',
        cornerPixels: [],
        pointPixels: [],
        error: null,
      });
      const all = [...req.corners, ...req.points];
      try {
        const res = await fetch(`${ENGINE_BASE}/api/raster/pixels`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: targetPathRef.current,
            points: all,
            // 视窗四角常常落在影像之外（地图视野比影像大），
            // 笔迹也可能画到图外：这两种都要照常换算，
            // 越界的部分由 regionFromPoints 夹回影像内（与老行为一致）。
            allowOutside: true,
          }),
        });
        const body = (await res.json().catch(() => null)) as {
          pixels?: { col: number; row: number }[];
          message?: string;
        } | null;
        if (!res.ok) {
          throw new Error(body?.message ?? `HTTP ${res.status}`);
        }
        const pixels = body?.pixels ?? [];
        if (pixels.length !== all.length) {
          throw new Error(
            `引擎换回来的像元坐标数量不对（期望 ${all.length} 个，收到 ${pixels.length} 个）`,
          );
        }
        publishConversion({
          key: req.key,
          status: 'ready',
          cornerPixels: pixels.slice(0, req.corners.length),
          pointPixels: pixels.slice(req.corners.length),
          error: null,
        });
      } catch (err) {
        publishConversion({
          key: req.key,
          status: 'error',
          cornerPixels: [],
          pointPixels: [],
          error: `换算原生像元坐标失败：${(err as Error).message}`,
        });
      }
    },
    [publishConversion],
  );

  /** 笔迹的换算请求：视窗四角 + 这一笔的所有点 */
  const brushRequest = useCallback(
    (points: readonly GeoScreenPoint[]): ConversionRequest | null => {
      const vp = viewportRef.current;
      if (!vp) return null;
      const corners = viewportCorners(vp.bbox);
      const pts = points.map((p) => [p.lng, p.lat] as const);
      return { key: signatureOf(targetPathRef.current, corners, pts), corners, points: pts };
    },
    [],
  );

  /** 框选的换算请求：只要两个角（框选与视窗无关，拖完地图也不该失效） */
  const boxRequest = useCallback(
    (current: readonly [GeoScreenPoint, GeoScreenPoint]): ConversionRequest => {
      const pts = [
        [current[0].lng, current[0].lat] as const,
        [current[1].lng, current[1].lat] as const,
      ];
      return { key: signatureOf(targetPathRef.current, [], pts), corners: [], points: pts };
    },
    [],
  );

  const onGesture = useCallback(
    (gesture: EditGesture) => {
      if (tool === 'view' || tool === 'levels') return;
      const point: GeoScreenPoint = { x: gesture.x, y: gesture.y, lng: gesture.lng, lat: gesture.lat };
      if (gesture.phase === 'down') {
        downRef.current = true;
        // 视口在按住的那一刻定下来：笔迹的屏幕长度要按它换算成原生像元
        viewportRef.current = getViewportRef.current();
        if (tool === 'brush') {
          strokeRef.current = [point];
          setStroke([point]);
          return;
        }
        boxRef.current = [point, point];
        setBox([point, point]);
        return;
      }
      if (!downRef.current) return;
      if (gesture.phase === 'move') {
        if (tool === 'brush') {
          const last = strokeRef.current[strokeRef.current.length - 1];
          // 隔太近的点不记：只是徒增遮罩体积，画出来没区别
          if (last && Math.abs(last.x - point.x) < 1 && Math.abs(last.y - point.y) < 1) {
            return;
          }
          const next = [...strokeRef.current, point];
          strokeRef.current = next;
          setStroke(next);
          return;
        }
        const next: [GeoScreenPoint, GeoScreenPoint] = boxRef.current
          ? [boxRef.current[0], point]
          : [point, point];
        boxRef.current = next;
        setBox(next);
        return;
      }
      // up
      downRef.current = false;
      if (tool === 'brush') {
        // 这一笔的点已经齐了 → 去换算；换算好了再交给上层预演
        // （换算是网络往返，同步的回调拿不到像元坐标）
        const req = brushRequest(strokeRef.current);
        if (!req) {
          onBrushEndRef.current?.();
          return;
        }
        void requestConversion(req).then(() => onBrushEndRef.current?.());
        return;
      }
      const next: [GeoScreenPoint, GeoScreenPoint] = boxRef.current
        ? [boxRef.current[0], point]
        : [point, point];
      boxRef.current = next;
      setBox(next);
      // 框选的两个角换算成像元：工具条上的「涂色/擦除」要等这个结果
      void requestConversion(boxRequest(next));
    },
    [tool, brushRequest, boxRequest, requestConversion],
  );

  /* ───────── 能不能用 ───────── */

  /**
   * 四个工具各自的不可用原因。
   *
   * 判定规则见 editAvailability.ts：这里只负责把状态喂进去。
   * 「什么算 4326」只有 editGeometry.isWgs84Grid 一个判据（引擎给的 crs.is4326）。
   */
  const blockedByTool = useMemo(
    () =>
      computeBlockedReasons({
        hasTarget: targetPath !== null,
        gridLoading,
        gridError,
        hasGrid: grid !== null,
        gridIsWgs84: grid !== null && isWgs84Grid(grid),
        gridHasCrs: grid?.crs.present === true,
      }),
    [targetPath, gridLoading, gridError, grid],
  );

  /* ───────── 生成操作 ───────── */

  /**
   * 取当前笔迹/框对应的换算结果。
   *
   * 签名不一致 = 换算还没回来（或回来的是上一笔）→ 不能用。
   */
  const conversionFor = useCallback((key: string): Conversion | null => {
    const c = conversionRef.current;
    return c && c.key === key ? c : null;
  }, []);

  const buildRegionOp = useCallback(
    (kind: 'paint' | 'erase', color: string): BuildResult => {
      const g = gridRef.current;
      if (!g || !targetPath) return { ok: false, message: '先选一个栅格图层' };
      const current = boxRef.current;
      if (!current) return { ok: false, message: '先在地图上框出一个矩形' };
      const req = boxRequest(current);
      const conv = conversionFor(req.key);
      if (!conv) return { ok: false, message: '正在换算原生像元坐标，请稍候' };
      if (conv.status === 'error') return { ok: false, message: conv.error ?? '换算原生像元坐标失败' };
      const pixels = conv.pointPixels;
      if (pixels.length < 2) return { ok: false, message: '这个框没有落在栅格范围内' };
      const region = regionFromPoints(g, pixels);
      if (!region) return { ok: false, message: '这个框没有落在栅格范围内' };
      if (kind === 'erase') {
        return {
          ok: true,
          op: { op: 'raster.erase', params: { target: targetPath, region }, label: '擦除' },
        };
      }
      return {
        ok: true,
        op: {
          op: 'raster.paint',
          params: { target: targetPath, region, color },
          label: '涂色',
        },
      };
    },
    [targetPath, boxRequest, conversionFor],
  );

  const buildBrushOp = useCallback(
    (color: string): BuildResult => {
      const g = gridRef.current;
      if (!g || !targetPath) return { ok: false, message: '先选一个栅格图层' };
      const points = strokeRef.current;
      if (points.length === 0) return { ok: false, message: '先在地图上画一笔' };
      const req = brushRequest(points);
      if (!req) return { ok: false, message: '取不到当前视口，先在地图上画一笔' };
      const conv = conversionFor(req.key);
      if (!conv) return { ok: false, message: '正在换算原生像元坐标，请稍候' };
      if (conv.status === 'error') return { ok: false, message: conv.error ?? '换算原生像元坐标失败' };
      const pixels = conv.pointPixels;
      if (pixels.length === 0) return { ok: false, message: '这一笔没有落在栅格范围内' };
      const vp = viewportRef.current;
      const scale = vp ? nativeScaleFromCorners(conv.cornerPixels, vp) : null;
      // 笔宽（屏幕像素）→ 原生像元：靠视窗两对角线在原生坐标里的跨度算，
      // 与坐标系无关（4326 的栅格也走这一条路）。
      const radius = Math.max(1, brushWidthRef.current * (scale ?? 1));
      const region = regionFromPoints(g, pixels, radius);
      if (!region) return { ok: false, message: '这一笔没有落在栅格范围内' };
      const width = region.maxX - region.minX;
      const height = region.maxY - region.minY;
      if (width * height > MAX_MASK_PIXELS) {
        return {
          ok: false,
          message: `这一笔覆盖了 ${width * height} 个像元，遮罩太大；请缩小笔宽或改用框选`,
        };
      }
      const bytes = rasterizeStroke(pixels, region, radius);
      const mask: BrushMask = { width, height, data: encodeBase64(bytes) };
      return {
        ok: true,
        op: {
          op: 'raster.paint',
          params: { target: targetPath, region, color, mask },
          label: '涂色',
        },
      };
    },
    [targetPath, brushRequest, conversionFor],
  );

  /* ───────── 预览 ───────── */

  const preview = useMemo<EditPreview | null>(() => {
    if (tool === 'brush' && stroke.length > 0) {
      return {
        kind: 'brush',
        points: stroke.map((p) => ({ x: p.x, y: p.y })),
        brushWidth: brushWidth,
      };
    }
    if (tool === 'box' && box) {
      return {
        kind: 'box',
        points: [
          { x: box[0].x, y: box[0].y },
          { x: box[1].x, y: box[1].y },
        ],
      };
    }
    return null;
  }, [tool, stroke, box, brushWidth]);

  /**
   * 框选能不能点「涂色/擦除」。
   *
   * 换算还没回来的那一小会儿是禁用的（点了也只会得到"请稍候"）；
   * 换算失败的也要能点——点了才能把失败原因显示出来，而不是悄悄没反应。
   */
  const hasBox = useMemo(() => {
    if (!box) return false;
    const conv = conversionFor(boxRequest(box).key);
    return conv !== null && conv.status !== 'pending';
  }, [box, boxRequest, conversionFor, conversion]);

  return {
    tool,
    setTool: changeTool,
    grid,
    blockedByTool,
    preview,
    hasBox,
    onGesture,
    resetGesture,
    buildRegionOp,
    buildBrushOp,
  };
}
