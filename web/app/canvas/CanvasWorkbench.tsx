'use client';

/**
 * 地图画布工作台：把引擎调用、图层状态、图面要素、导出与报告串起来。
 *
 * 分工：
 *   - useEngine    负责所有与引擎的网络往返（唯一的调用点）
 *   - useProjects  负责项目本身（登记根、读写清单、产出物落盘）
 *   - MapCanvas    负责地图本身与图面要素的绘制
 *   - 本组件      负责状态与编排：图层清单、当前选中、抽屉、导出、报告
 *
 * 状态都收在这里，是为了让"屏幕上看到的"和"导出的 PDF 里的"必然一致——
 * 两边各存一份状态，是这类工具最容易出现的 bug 来源。
 *
 * **两态**。
 *   - 没打开项目（projectPath === null）：只显示项目列表，不列文件、不请求路径接口；
 *   - 打开了项目：画布里的一切路径都相对**项目根**，清单自动保存，关掉再开能恢复。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AttributeTable from './AttributeTable';
import { CanvasBoot, ExportDevelop, LayerArrival, SelectionShutter } from './CanvasMotion';
import ConfirmCard, { type ExecOutcome } from './ConfirmCard';
import EditToolbar from './EditToolbar';
import LayerPanel from './LayerPanel';
import MapCanvas, { type MapCanvasHandle } from './MapCanvas';
import ProjectPicker from './ProjectPicker';
import Toolbar from './Toolbar';
import { MarkdownView } from './markdown';
import { ThemeToggle } from './ThemeToggle';
import { ActionButton, TextField } from './ui';
import { useEditTools } from './useEditTools';
import { useEngine, type CompatReportPayload } from './useEngine';
import { useProjects } from './useProjects';
import {
  type EditOp,
  type LayerKind,
  type LevelsParams,
  type MapLayer,
  type OpPreview,
  type ProjectManifest,
  type SelectedFeature,
} from './types';

/** 确认卡的状态：一次预演 + 一次执行的全过程 */
interface ConfirmState {
  readonly op: EditOp;
  readonly preview: OpPreview | null;
  readonly previewing: boolean;
  readonly error: string | null;
  readonly executing: boolean;
  readonly outcome: ExecOutcome | null;
}

/** 本地时间戳：出图时间与导出文件名都用它 */
function formatNow(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

/**
 * 回首页的链接。理由与 app/page.tsx 的 CANVAS_HREF 相同：
 * 静态产物里 canvas.html 与 index.html 同目录，相对路径在 file:// 下才能解析；
 * `next dev` 不认 .html 后缀，用绝对路由。NODE_ENV 由构建期内联。
 */
const HOME_HREF = process.env.NODE_ENV === 'development' ? '/' : 'index.html';

/** 文件名里的时间戳（20261021-153000） */
function fileStamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** 触发浏览器下载 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让部分浏览器来不及取数据，延后一拍
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function CanvasWorkbench() {
  // 项目根。
  // **必须声明在 useEngine 之前**——useEngine 要拿它当 root（hook 调用顺序不能变）。
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);

  const engine = useEngine(projectPath);
  const projects = useProjects();
  // 这几个是 useCallback 包出来的稳定引用：放进 useEffect 的依赖数组里不会每次渲染都重置
  const { createProject: createProjectRequest, openProject: openProjectRequest } = projects;
  const { saveManifest, writeOutput, remember: rememberProject } = projects;

  const mapHandleRef = useRef<MapCanvasHandle | null>(null);
  const idRef = useRef(0);
  /**
   * 当前项目根的"代号"。
   *
   * 图层数据是异步回来的：用户可能在数据回来之前就换项目了。
   * 不做这个校验的话，旧项目的数据会落进新项目的数据表
   * （两个项目都叫 layer-1 时，地图上会出现另一个项目的图层）。
   */
  const projectPathRef = useRef<string | null>(null);
  projectPathRef.current = projectPath;

  const [layers, setLayers] = useState<MapLayer[]>([]);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);

  // 动效用的 ref：面板滑入 + 图纸显影
  const leftRef = useRef<HTMLElement | null>(null);
  const rightRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const [vectorData, setVectorData] = useState<Map<string, unknown>>(() => new Map());
  const [extents, setExtents] = useState<Map<string, readonly [number, number, number, number]>>(
    () => new Map(),
  );
  const [selected, setSelected] = useState<SelectedFeature[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const [dir, setDir] = useState('');
  const [files, setFiles] = useState<string[]>([]);

  const [title, setTitle] = useState('图签 Cartouche 出图');
  const [operator, setOperator] = useState('');
  const [producedAt, setProducedAt] = useState(formatNow());

  /**
   * 栅格显示的拉伸档位。
   *
   * undefined = 自动（不发参数，引擎按源类型决定：8 位按原样、16 位按实际亮度）。
   * 用户手动切过之后才显式发出去 —— 直接默认发 'auto' 会把 8 位影像的显示行为也改掉，
   * 那是既有行为，不该被这个开关顺手改掉。
   */
  const [stretch, setStretch] = useState<'auto' | 'none' | undefined>(undefined);

  const [report, setReport] = useState<CompatReportPayload | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  /** 正在打开/新建项目：项目列表上的按钮要置灰 */
  const [projectBusy, setProjectBusy] = useState(false);
  /**
   * file:// 下打开会出不来地图。
   *
   * Chrome 禁止从 origin=null 的页面构造 Web Worker，MapLibre 的 worker 起不来，
   * 底图与矢量都不会渲染（控制台只有一行 "Worker failed to load"）。
   * 所以必须走 http：`npm run serve:web`。
   */
  const [fileProtocol, setFileProtocol] = useState(false);

  const engineReady = engine.health.status === 'ready';

  useEffect(() => {
    setFileProtocol(window.location.protocol === 'file:');
  }, []);

  /* ───────── 打开 / 新建 / 退回项目列表 ───────── */

  const openProject = useCallback(
    async (path: string) => {
      setProjectBusy(true);
      try {
        const m = await openProjectRequest(path);
        if (!m) {
          setBanner('这个文件夹里还没有项目清单。用「登记并新建」建一个。');
          return;
        }
        // 两个 state 一起设：React 会批处理，
        // 所以第一帧就同时有 projectPath 和 manifest（MapCanvas 建图时就能拿到 initialView）
        setProjectPath(path);
        setManifest(m);
        setBanner(null);
      } catch (err) {
        setBanner(`打开项目失败：${(err as Error).message}`);
      } finally {
        setProjectBusy(false);
      }
    },
    [openProjectRequest],
  );

  const createProject = useCallback(
    async (path: string) => {
      setProjectBusy(true);
      try {
        const m = await createProjectRequest(path);
        setProjectPath(path);
        setManifest(m);
        setBanner(null);
      } catch (err) {
        setBanner(`新建项目失败：${(err as Error).message}`);
      } finally {
        setProjectBusy(false);
      }
    },
    [createProjectRequest],
  );

  /* ───────── 工作区文件列表 ───────── */

  const listDir = engine.listDir;
  useEffect(() => {
    // 没打开项目时不该去列默认工作区：那时候用户还没选项目
    if (!engineReady || !projectPath) return;
    let cancelled = false;
    void listDir(dir).then((res) => {
      if (cancelled) return;
      setFiles(res.ok ? res.data : []);
    });
    return () => {
      cancelled = true;
    };
  }, [engineReady, projectPath, dir, listDir]);

  // 换项目时把浏览位置清回项目根（上一个项目的子目录在新项目里多半不存在）
  useEffect(() => {
    setDir('');
  }, [projectPath]);

  /* ───────── 图层数据 ───────── */

  /**
   * 把图层的数据拉回来：矢量的 GeoJSON + 各自的地理范围。
   *
   * 新增图层和恢复项目**共用这一份** —— 恢复时只回填图层列表是不够的，
   * 那样地图上还是一片空白（列表有了、数据没回来，用户以为没恢复成功）。
   *
   * 返回是否全部成功：新增图层失败时不要顺手把错误提示清掉。
   */
  const loadLayerData = useCallback(
    async (target: readonly MapLayer[]): Promise<boolean> => {
      let ok = true;
      // 记下这次请求属于哪个项目：中途换了项目就不要再往回写数据了
      const owner = projectPathRef.current;
      const stillMine = (): boolean => projectPathRef.current === owner;
      for (const layer of target) {
        if (layer.kind === 'vector') {
          const res = await engine.fetchGeoJson(layer.path);
          if (!res.ok) {
            setBanner(`读取 ${layer.path} 失败：${res.error}`);
            ok = false;
            continue;
          }
          if (!stillMine()) return ok;
          setVectorData((prev) => {
            const next = new Map(prev);
            next.set(layer.id, res.data.geojson);
            return next;
          });
        }
        const extentRes = await engine.fetchExtent(layer.path);
        if (extentRes.ok) {
          if (!stillMine()) return ok;
          const bbox = extentRes.data.bbox;
          setExtents((prev) => {
            const next = new Map(prev);
            next.set(layer.id, [bbox[0], bbox[1], bbox[2], bbox[3]]);
            return next;
          });
        }
      }
      return ok;
    },
    [engine.fetchGeoJson, engine.fetchExtent],
  );

  /* ───────── 图层操作 ───────── */

  const addLayer = useCallback(
    async (name: string, kind: LayerKind) => {
      const path = dir ? `${dir}/${name}` : name;
      const id = `layer-${(idRef.current += 1)}`;

      const layer: MapLayer = { id, name, kind, path, visible: true, opacity: 1 };
      const ok = await loadLayerData([layer]);
      setLayers((prev) => {
        // 叠放次序 = 数组顺序（末尾在最上），和面板里的上移/下移一致。
        //
        // 栅格默认插到**第一个矢量图层之前**——也就是底图约定：
        // 栅格是底，矢量是上面的作业层。反过来的话，加载一个栅格会把
        // 已经画出来的矢量整个盖住（非 GIS 专业用户看不出为什么东西"不见了"）。
        // 用户之后仍可用上移/下移自由调整。
        if (kind !== 'raster') return [...prev, layer];
        const firstVector = prev.findIndex((l) => l.kind === 'vector');
        if (firstVector < 0) return [...prev, layer];
        return [...prev.slice(0, firstVector), layer, ...prev.slice(firstVector)];
      });
      setActiveLayerId(id);
      if (ok) setBanner(null);
    },
    [dir, loadLayerData],
  );

  const removeLayer = useCallback((id: string) => {
    setLayers((prev) => prev.filter((layer) => layer.id !== id));
    setVectorData((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setExtents((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setSelected((prev) => prev.filter((feature) => feature.layerId !== id));
    setActiveLayerId((prev) => (prev === id ? null : prev));
  }, []);

  const toggleVisibility = useCallback((id: string) => {
    setLayers((prev) =>
      prev.map((layer) => (layer.id === id ? { ...layer, visible: !layer.visible } : layer)),
    );
  }, []);

  const changeOpacity = useCallback((id: string, opacity: number) => {
    setLayers((prev) => prev.map((layer) => (layer.id === id ? { ...layer, opacity } : layer)));
  }, []);

  /** direction: 1 = 上移（更靠前/更上），-1 = 下移 */
  const moveLayer = useCallback((id: string, direction: 1 | -1) => {
    setLayers((prev) => {
      const index = prev.findIndex((layer) => layer.id === id);
      if (index < 0) return prev;
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      if (!item) return prev;
      next.splice(target, 0, item);
      return next;
    });
  }, []);

  /* ───────── 恢复项目 ───────── */

  useEffect(() => {
    if (!manifest) return;
    const restored: MapLayer[] = manifest.layers.map((l) => ({
      id: l.id,
      name: l.path.split('/').pop() ?? l.path,
      kind: l.kind,
      path: l.path,
      visible: l.visible,
      opacity: l.opacity,
    }));
    // 先清空上一个项目留下的数据：两个项目都可能有 layer-1，
    // 不清的话旧项目的 GeoJSON 会灌进新项目的图层里
    setVectorData(new Map());
    setExtents(new Map());
    setLayers(restored);
    setTitle(manifest.sheet.title);
    setOperator(manifest.sheet.operator);

    // id 计数器要跳过已用过的编号：否则新加的图层会和恢复出来的撞 id
    // （MapLibre 的 source/layer 名是拿 id 拼的，撞了就是两个图层互相覆盖）
    const maxN = restored.reduce((acc, l) => {
      const m = /(\d+)$/.exec(l.id);
      const n = m?.[1];
      return n ? Math.max(acc, Number(n)) : acc;
    }, 0);
    idRef.current = Math.max(idRef.current, maxN);

    // 数据也要拉回来 —— 只回填列表的话地图上是空的
    void loadLayerData(restored);
  }, [manifest, loadLayerData]);

  /* ───────── 自动保存清单 ───────── */

  /** 把当前画布状态组装成一份项目清单（视角从地图 handle 现取） */
  const buildManifest = useCallback((): ProjectManifest | null => {
    if (!manifest) return null;
    const v = mapHandleRef.current?.getView() ?? null;
    return {
      ...manifest,
      updatedAt: new Date().toISOString(),
      sheet: { ...manifest.sheet, title, operator },
      layers: layers.map((l) => ({
        id: l.id,
        kind: l.kind,
        path: l.path,
        visible: l.visible,
        opacity: l.opacity,
      })),
      ...(v ? { view: { center: v.center, zoom: v.zoom } } : {}),
    };
  }, [manifest, title, operator, layers]);

  useEffect(() => {
    if (!projectPath || !manifest) return;
    // 防抖 800ms：改一次顺序、拖一次透明度不该写一次盘
    const t = setTimeout(() => {
      const next = buildManifest();
      if (!next) return;
      void saveManifest(projectPath, next)
        .then(() => {
          // 存好了就把"最近项目"里的摘要也刷新一下：
          // 否则列表里显示的还是打开那一刻的图层数，用户会以为改动没存上
          rememberProject(projectPath, next);
        })
        .catch((err) => {
          setBanner(`项目清单未保存：${(err as Error).message}`);
        });
    }, 800);
    return () => clearTimeout(t);
  }, [projectPath, manifest, buildManifest, saveManifest, rememberProject]);

  /** 回到项目列表：先把当前状态存下去（否则最后 800ms 的防抖会被清掉） */
  const leaveProject = useCallback(() => {
    const next = buildManifest();
    if (projectPath && next) {
      void saveManifest(projectPath, next)
        .then(() => {
          rememberProject(projectPath, next);
        })
        .catch((err) => {
          setBanner(`项目清单未保存：${(err as Error).message}`);
        });
    }
    setProjectPath(null);
    setManifest(null);
    setLayers([]);
    setVectorData(new Map());
    setExtents(new Map());
    setActiveLayerId(null);
    setSelected([]);
    setDir('');
    setFiles([]);
    setBanner(null);
  }, [buildManifest, projectPath, saveManifest, rememberProject]);

  /* ───────── 导出 PDF ───────── */

  const exportPdf = engine.exportPdf;

  /**
   * 把当前视口封成 PDF 并触发下载。
   *
   * 导出 PDF 与"改动后重新出图"是同一条链路（取画面 → 交引擎封 PDF → 下载），
   * 所以抽成一个函数：工具栏的「导出 PDF」和"改完栅格自动出新版"共用它，
   * 免得两处各写一遍、以后改标题栏口径时漏改一处。
   */
  const exportView = useCallback(async (): Promise<
    { readonly ok: true; readonly filename: string } | { readonly ok: false; readonly error: string }
  > => {
    // 出图时间要在取画面**之前**定下来：它要写进这一张图的标题栏
    const stamp = formatNow();
    const shot = mapHandleRef.current?.exportJpeg({ quality: 0.92, producedAt: stamp });
    if (!shot) return { ok: false, error: '地图还没准备好，稍后再试一次。' };
    const res = await exportPdf({
      jpeg: shot.jpeg,
      width: shot.width,
      height: shot.height,
      title,
      operator,
    });
    if (!res.ok) return { ok: false, error: res.error };
    setProducedAt(stamp);
    const filename = `cartouche-${fileStamp()}.pdf`;
    downloadBlob(res.data, filename);
    // 既存进项目目录（.cartouche/outputs/），再触发下载 —— 交差时能直接找到上一版
    if (projectPath) {
      void writeOutput(projectPath, filename, res.data).catch((err) => {
        setBanner(`PDF 已下载，但没存进项目目录：${(err as Error).message}`);
      });
    }
    return { ok: true, filename };
  }, [exportPdf, title, operator, projectPath, writeOutput]);

  const handleExportPdf = useCallback(async () => {
    const res = await exportView();
    if (!res.ok) {
      setBanner(`导出失败：${res.error}`);
      return;
    }
    setBanner(null);
  }, [exportView]);

  /* ───────── 兼容性报告 ───────── */

  const activeLayer = useMemo(
    () => layers.find((layer) => layer.id === activeLayerId) ?? layers[layers.length - 1] ?? null,
    [layers, activeLayerId],
  );

  const fetchCompatReport = engine.fetchCompatReport;
  const handleCompatReport = useCallback(async () => {
    if (!activeLayer) return;
    const res = await fetchCompatReport(activeLayer.path);
    if (!res.ok) {
      setBanner(`生成报告失败：${res.error}`);
      return;
    }
    setReport(res.data);
    setReportOpen(true);
    setBanner(null);
  }, [activeLayer, fetchCompatReport]);

  /* ───────── 栅格编辑 ───────── */

  /**
   * 被编辑的那张栅格。
   *
   * 只认**用户明确选中**的那一层（activeLayerId），不做"退回最后一层"的兜底：
   * 改错文件是这件工具里唯一不可逆的事，宁可让人多点一下。
   */
  const editTarget = useMemo(
    () => layers.find((layer) => layer.id === activeLayerId && layer.kind === 'raster') ?? null,
    [layers, activeLayerId],
  );

  const [editColor, setEditColor] = useState('#d9480f');
  const [brushWidth, setBrushWidth] = useState(6);
  const [levels, setLevels] = useState<LevelsParams>({
    method: 'linear-stretch',
    brightness: 0,
    contrast: 1,
  });
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  /**
   * 预演一条操作：确认卡的数据全部来自引擎的预演，不是前端自己估的。
   *
   * 预演失败就把服务端的中文错误原样带进确认卡，并且**不给执行按钮**——
   * 影响面都算不出来，这次就不该执行。
   */
  const previewOp = useCallback(
    async (op: EditOp) => {
      setConfirmState({
        op,
        preview: null,
        previewing: true,
        error: null,
        executing: false,
        outcome: null,
      });
      const res = await engine.previewOp(op);
      setConfirmState((prev) => {
        // 预演期间用户可能已经关掉了卡，这时不要把结果塞回一个已经不存在的状态
        if (!prev || prev.op !== op) return prev;
        if (!res.ok) return { ...prev, previewing: false, error: res.error };
        return { ...prev, previewing: false, preview: res.data, error: null };
      });
    },
    [engine.previewOp],
  );

  const editTools = useEditTools({
    targetPath: editTarget?.path ?? null,
    fetchGrid: engine.fetchRasterGrid,
    getViewport: () => mapHandleRef.current?.getViewport() ?? null,
    brushWidth,
    onBrushEnd: () => {
      const built = editToolsRef.current?.buildBrushOp(editColorRef.current);
      if (!built) return;
      if (!built.ok) {
        setBanner(built.message);
        return;
      }
      setBanner(null);
      void previewOp(built.op);
    },
  });

  // 笔迹抬手时要立刻用当前颜色去预演，而那一刻 React 的 state 还没更新，
  // 所以把这两个值放进 ref 供回调读取（和 useEditTools 里的处理同一个道理）。
  const editToolsRef = useRef(editTools);
  editToolsRef.current = editTools;
  const editColorRef = useRef(editColor);
  editColorRef.current = editColor;

  /** 框选之后：涂色 or 擦除 */
  const handleBoxAction = useCallback(
    (kind: 'paint' | 'erase') => {
      const built = editTools.buildRegionOp(kind, editColor);
      if (!built.ok) {
        setBanner(built.message);
        return;
      }
      setBanner(null);
      void previewOp(built.op);
    },
    [editTools.buildRegionOp, editColor, previewOp],
  );

  /** 调色：按当前参数预演一次 */
  const handlePreviewLevels = useCallback(() => {
    if (!editTarget) {
      setBanner('先选一个栅格图层');
      return;
    }
    const op: EditOp = {
      op: 'raster.adjustLevels',
      params: {
        target: editTarget.path,
        method: levels.method,
        brightness: levels.brightness,
        contrast: levels.contrast,
      },
      label: '亮度对比度调整',
    };
    setBanner(null);
    void previewOp(op);
  }, [editTarget, levels, previewOp]);

  /**
   * 执行：确认卡上点「确认执行」。
   *
   * 顺序有讲究：先让地图重新出图（拿到改动后的画面），再导 PDF——
   * 反过来的话导出来的是改动前的图，等于白导一次。
   */
  const handleConfirmExecute = useCallback(async () => {
    const current = confirmState;
    if (!current || current.executing) return;
    setConfirmState((prev) => (prev ? { ...prev, executing: true, outcome: null } : prev));
    const res = await engine.executeOp(current.op);
    if (!res.ok) {
      setConfirmState((prev) =>
        prev ? { ...prev, executing: false, error: res.error } : prev,
      );
      return;
    }
    const data = res.data;
    const failed =
      data.failedAt !== undefined ? data.results[data.failedAt] : data.results.find((r) => !r.ok);
    if (!data.ok || failed) {
      // 前面成功的条目已经落盘了，不会回滚——这句话必须说清楚，
      // 否则用户会以为"什么都没发生"而重复操作，把文件改得更乱。
      const parts: string[] = [];
      if (failed?.unimplemented) parts.push('该操作尚未支持');
      if (failed?.error) parts.push(failed.error);
      if (data.completed > 0) parts.push('已完成的条目已生效，失败的条目没有回滚');
      setConfirmState((prev) =>
        prev
          ? {
              ...prev,
              executing: false,
              outcome: {
                tone: 'error',
                message: parts.join('。') || '操作没有完成',
              },
            }
          : prev,
      );
      return;
    }

    // 成功：刷新地图 → 导出新版 → 刷新"最近项目"摘要
    await mapHandleRef.current?.refresh();
    const exported = await exportView();
    const next = buildManifest();
    if (projectPath && next) rememberProject(projectPath, next);
    editToolsRef.current.resetGesture();
    setConfirmState((prev) =>
      prev
        ? {
            ...prev,
            executing: false,
            outcome: {
              tone: exported.ok ? 'ok' : 'warn',
              message: exported.ok
                ? `已完成「${current.op.label}」。地图已刷新，改动后的图已导出为 ${exported.filename}。`
                : `已完成「${current.op.label}」。地图已刷新，但导出 PDF 失败：${exported.error}`,
            },
          }
        : prev,
    );
  }, [confirmState, engine.executeOp, exportView, projectPath, rememberProject]);

  const closeConfirm = useCallback(() => {
    setConfirmState(null);
  }, []);

  /* ───────── 渲染 ───────── */

  const engineError = engine.health.status === 'offline' ? engine.health.error : null;

  /**
   * 两态分叉。
   *
   * 放在**所有 hook 之后**：hook 的调用顺序不能变，
   * 少写一个 useState 在早退之后，下一次渲染就会炸。
   */
  if (!projectPath) {
    return (
      <ProjectPicker
        recent={projects.recent}
        error={banner ?? projects.error}
        busy={projectBusy}
        onOpenExisting={(p) => {
          void openProject(p);
        }}
        onCreateFromFolder={(p) => {
          void createProject(p);
        }}
      />
    );
  }

  return (
    <>
      <CanvasBoot leftRef={leftRef} rightRef={rightRef} stageRef={stageRef} />
      <div className="flex h-[100dvh] flex-col overflow-hidden bg-studio text-studio-ink">
      <header className="flex items-center gap-3 border-b border-studio-line bg-studio-2/80 px-4 py-2.5 backdrop-blur">
        <a
          href={HOME_HREF}
          className="rounded-md px-1.5 py-1 text-[12.5px] text-studio-ink-2 transition-colors hover:bg-studio-3 hover:text-studio-ink"
        >
          ← 返回首页
        </a>
        <span className="h-4 w-px bg-studio-line" />
        <strong className="font-display text-[14px] font-semibold tracking-tight text-studio-ink">
          地图画布
        </strong>
        <span className="font-mono text-[11.5px] text-studio-ink-3">图签 Cartouche</span>

        <span className="h-4 w-px bg-studio-line" />
        <button
          type="button"
          onClick={leaveProject}
          title="回到项目列表"
          className="max-w-[280px] truncate rounded-md px-1.5 py-1 font-mono text-[11.5px] text-studio-ink-2 transition-colors hover:bg-studio-3 hover:text-studio-ink"
        >
          {manifest?.name ?? '项目'} ▾
        </button>

        <span className="flex-1" />

        <ThemeToggle />

        <span className="h-4 w-px bg-studio-line" />

        <label className="flex items-center gap-2 text-[11.5px] text-studio-ink-3">
          图名
          <TextField
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-52"
          />
        </label>
        <label className="flex items-center gap-2 text-[11.5px] text-studio-ink-3">
          操作人
          <TextField
            value={operator}
            onChange={(event) => setOperator(event.target.value)}
            placeholder="姓名"
            className="w-28"
          />
        </label>
      </header>

      <Toolbar
        onExportPdf={() => {
          void handleExportPdf();
        }}
        onCompatReport={() => {
          void handleCompatReport();
        }}
        exporting={engine.isPending('export')}
        reporting={engine.isPending('report')}
        canReport={Boolean(activeLayer)}
        health={engine.health.status}
        onReloadHealth={engine.reloadHealth}
        stretch={stretch}
        onStretchChange={setStretch}
      />

      <EditToolbar
        tool={editTools.tool}
        onToolChange={editTools.setTool}
        blocked={editTools.blocked}
        color={editColor}
        onColorChange={setEditColor}
        brushWidth={brushWidth}
        onBrushWidthChange={setBrushWidth}
        hasBox={editTools.hasBox}
        onBoxAction={(kind) => {
          handleBoxAction(kind);
        }}
        levels={levels}
        onLevelsChange={setLevels}
        onPreviewLevels={() => {
          handlePreviewLevels();
        }}
        busy={
          engine.isPending('preview') ||
          engine.isPending('execute') ||
          (confirmState?.previewing ?? false) ||
          (confirmState?.executing ?? false)
        }
      />

      {fileProtocol ? (
        <div className="border-b border-amber/35 bg-amber/10 px-4 py-2.5 text-[12.5px] leading-relaxed text-studio-ink-2">
          <strong className="text-studio-ink">当前是用 file:// 直接打开的，地图画不出来。</strong>
          Chrome 不允许从本地文件构造 Web Worker，MapLibre 的 worker 起不来。
          请在仓库根目录运行 <code className="rounded bg-studio-3 px-1 font-mono">npm run serve:web</code>，
          然后访问 <code className="rounded bg-studio-3 px-1 font-mono">http://127.0.0.1:8080/canvas.html</code>。
        </div>
      ) : null}

      {banner || engine.error ? (
        <div className="border-b border-warn/30 bg-warn/12 px-4 py-2 text-[12.5px] text-warn">
          {banner ?? engine.error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside
          ref={leftRef}
          className="w-[300px] shrink-0 overflow-y-auto border-r border-studio-line bg-studio-2/70 p-4"
        >
          <LayerPanel
            layers={layers}
            files={files}
            dir={dir}
            filesLoading={engine.isPending('list')}
            activeLayerId={activeLayerId}
            onAddLayer={(name, kind) => {
              void addLayer(name, kind);
            }}
            onRemoveLayer={removeLayer}
            onToggleVisibility={toggleVisibility}
            onOpacityChange={changeOpacity}
            onMoveLayer={moveLayer}
            onSelectLayer={setActiveLayerId}
            onEnterDirectory={(name) => setDir((prev) => (prev ? `${prev}/${name}` : name))}
            onGoUp={() => setDir((prev) => (prev.includes('/') ? prev.slice(0, prev.lastIndexOf('/')) : ''))}
          />
        </aside>

        <main className="relative min-w-0 flex-1 p-3">
          <div
            ref={stageRef}
            className="film-grain vignette crop-marks relative h-full w-full overflow-hidden rounded-xl bg-studio-3"
            style={{ boxShadow: 'var(--studio-stage-shadow)' }}
          >
            <MapCanvas
              ref={mapHandleRef}
              engineBase={engine.base}
              buildRasterUrl={engine.rasterUrl}
              layers={layers}
              engineError={engineError}
              sheetMeta={{ title, operator, producedAt }}
              selectedFeatures={selected}
              vectorData={vectorData}
              extents={extents}
              initialView={
                manifest?.view ? { center: [manifest.view.center[0], manifest.view.center[1]], zoom: manifest.view.zoom } : undefined
              }
              preserveViewLayerIds={manifest?.layers.map((l) => l.id)}
              onSelectFeatures={(features) => {
                setSelected(features);
                setSelectedIndex(0);
              }}
              editTool={editTools.tool}
              editPreview={editTools.preview}
              stretch={stretch}
              onEditGesture={editTools.onGesture}
            />
            <LayerArrival stageRef={stageRef} layerCount={layers.length} />
            <SelectionShutter stageRef={stageRef} selectedCount={selected.length} />
            <ExportDevelop stageRef={stageRef} active={engine.isPending('export')} />
          </div>
        </main>

        <aside
          ref={rightRef}
          className="w-[320px] shrink-0 overflow-y-auto border-l border-studio-line bg-studio-2/70"
        >
          <AttributeTable
            features={selected}
            activeIndex={selectedIndex}
            onSelect={setSelectedIndex}
            onClose={() => setSelected([])}
          />
        </aside>
      </div>

      {reportOpen && report ? (
        <aside
          className="fixed inset-y-0 right-0 z-50 flex w-[560px] max-w-[92vw] flex-col border-l border-studio-line bg-studio-2/95 backdrop-blur-xl"
          style={{ boxShadow: 'var(--studio-panel-shadow)' }}
        >
          <div className="flex items-center gap-2.5 border-b border-studio-line px-4 py-3">
            <strong className="font-display text-[14px] font-semibold text-studio-ink">
              兼容性自检报告
            </strong>
            {report.hasBlocker ? (
              <span className="rounded border border-warn/40 bg-warn/12 px-1.5 py-0.5 font-mono text-[11px] text-warn">
                有阻断问题
              </span>
            ) : (
              <span className="rounded border border-accent/40 bg-accent/12 px-1.5 py-0.5 font-mono text-[11px] text-accent">
                未发现阻断问题
              </span>
            )}
            <span className="flex-1" />
            <ActionButton variant="quiet" onClick={() => setReportOpen(false)} className="!px-2 !py-1">
              关闭
            </ActionButton>
          </div>
          <div className="overflow-y-auto px-4 pt-3 pb-7">
            {report.manualChecks.length > 0 ? (
              <div className="mt-2 mb-3 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-studio-ink-2">
                <strong className="text-studio-ink">需要人工确认</strong>
                <ul className="mt-1 list-disc pl-5">
                  {report.manualChecks.map((check) => (
                    <li key={check}>{check}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <MarkdownView source={report.markdown} />
          </div>
        </aside>
      ) : null}

      {confirmState ? (
        <ConfirmCard
          op={confirmState.op}
          preview={confirmState.preview}
          previewing={confirmState.previewing}
          previewError={confirmState.error}
          executing={confirmState.executing}
          outcome={confirmState.outcome}
          onConfirm={() => {
            void handleConfirmExecute();
          }}
          onCancel={closeConfirm}
        />
      ) : null}
      </div>
    </>
  );
}
