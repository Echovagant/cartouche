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
 * 换算规则见 editGeometry.ts：屏幕点 → 经纬度 → 目标栅格的原生像元。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  encodeBase64,
  isWgs84Grid,
  pixelFromLngLat,
  rasterizeStroke,
  regionFromPoints,
  type PixelPoint,
} from './editGeometry';
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
  /** 工具当前不可用的原因（null = 可用） */
  readonly blocked: string | null;
  /** 画在覆盖层上的编辑预览 */
  readonly preview: EditPreview | null;
  /** 框选是否已经画出来 */
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
  }, []);

  // 换工具时把上一个工具留下的笔迹清掉：
  // 留着的话，切到框选时屏幕上还挂着上一条笔迹，看起来像选区
  const changeTool = useCallback(
    (next: EditTool) => {
      resetGesture();
      setTool(next);
    },
    [resetGesture],
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
        onBrushEndRef.current?.();
        return;
      }
      const next: [GeoScreenPoint, GeoScreenPoint] = boxRef.current
        ? [boxRef.current[0], point]
        : [point, point];
      boxRef.current = next;
      setBox(next);
    },
    [tool],
  );

  /* ───────── 能不能用 ───────── */

  const blocked = useMemo(() => {
    if (tool === 'view') return null;
    if (!targetPath) return '先选一个栅格图层';
    if (gridLoading) return '正在读取栅格网格…';
    if (gridError) return `读取栅格网格失败：${gridError}`;
    if (!grid) return '还没有拿到栅格网格';
    // 栅格不是 4326 就没法把屏幕坐标换算成它的原生像元——宁可明说，也不瞎算
    if (!isWgs84Grid(grid)) return '该图层坐标系不是 4326，画笔/框选暂不可用';
    return null;
  }, [tool, targetPath, gridLoading, gridError, grid]);

  /* ───────── 生成操作 ───────── */

  /** 一个屏幕像素相当于多少个原生像元 */
  const nativePerScreen = useCallback((): number => {
    const g = gridRef.current;
    const vp = viewportRef.current;
    if (!g || !vp) return 1;
    const pw = g.geotransform[1];
    const ph = g.geotransform[5];
    const degPerScreenX = (vp.bbox[2] - vp.bbox[0]) / Math.max(1, vp.width);
    const degPerScreenY = (vp.bbox[3] - vp.bbox[1]) / Math.max(1, vp.height);
    const sx = Math.abs(pw) / Math.max(1e-12, degPerScreenX);
    const sy = Math.abs(ph) / Math.max(1e-12, degPerScreenY);
    return Math.max(0.05, Math.min(sx, sy));
  }, []);

  /** 把一组经纬度点换算成原生像元点 */
  const toPixels = useCallback((points: readonly GeoScreenPoint[]): PixelPoint[] => {
    const g = gridRef.current;
    if (!g) return [];
    const out: PixelPoint[] = [];
    for (const p of points) {
      const q = pixelFromLngLat(g, p.lng, p.lat);
      if (q) out.push(q);
    }
    return out;
  }, []);

  const buildRegionOp = useCallback(
    (kind: 'paint' | 'erase', color: string): BuildResult => {
      const g = gridRef.current;
      if (!g || !targetPath) return { ok: false, message: '先选一个栅格图层' };
      const current = boxRef.current;
      if (!current) return { ok: false, message: '先在地图上框出一个矩形' };
      const pixels = toPixels([current[0], current[1]]);
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
    [targetPath, toPixels],
  );

  const buildBrushOp = useCallback(
    (color: string): BuildResult => {
      const g = gridRef.current;
      if (!g || !targetPath) return { ok: false, message: '先选一个栅格图层' };
      const points = strokeRef.current;
      if (points.length === 0) return { ok: false, message: '先在地图上画一笔' };
      const pixels = toPixels(points);
      if (pixels.length === 0) return { ok: false, message: '这一笔没有落在栅格范围内' };
      const radius = Math.max(1, brushWidthRef.current * nativePerScreen());
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
    [targetPath, toPixels, nativePerScreen],
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

  return {
    tool,
    setTool: changeTool,
    grid,
    blocked,
    preview,
    hasBox: box !== null,
    onGesture,
    resetGesture,
    buildRegionOp,
    buildBrushOp,
  };
}
