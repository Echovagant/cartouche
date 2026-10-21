'use client';

/**
 * 地图画布工作台：把引擎调用、图层状态、图面要素、导出与报告串起来。
 *
 * 分工：
 *   - useEngine  负责所有与引擎的网络往返（唯一的调用点）
 *   - MapCanvas  负责地图本身与图面要素的绘制
 *   - 本组件    负责状态与编排：图层清单、当前选中、抽屉、导出、报告
 *
 * 状态都收在这里，是为了让"屏幕上看到的"和"导出的 PDF 里的"必然一致——
 * 两边各存一份状态，是这类工具最容易出现的 bug 来源。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AttributeTable from './AttributeTable';
import { CanvasBoot, ExportDevelop, LayerArrival, SelectionShutter } from './CanvasMotion';
import LayerPanel from './LayerPanel';
import MapCanvas, { type MapCanvasHandle } from './MapCanvas';
import Toolbar from './Toolbar';
import { MarkdownView } from './markdown';
import { ThemeToggle } from './ThemeToggle';
import { ActionButton, TextField } from './ui';
import { useEngine, type CompatReportPayload } from './useEngine';
import { type LayerKind, type MapLayer, type SelectedFeature } from './types';

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
  const engine = useEngine();
  const mapHandleRef = useRef<MapCanvasHandle | null>(null);
  const idRef = useRef(0);

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

  const [report, setReport] = useState<CompatReportPayload | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
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

  /* ───────── 工作区文件列表 ───────── */

  const listDir = engine.listDir;
  useEffect(() => {
    if (!engineReady) return;
    let cancelled = false;
    void listDir(dir).then((res) => {
      if (cancelled) return;
      setFiles(res.ok ? res.data : []);
    });
    return () => {
      cancelled = true;
    };
  }, [engineReady, dir, listDir]);

  /* ───────── 图层操作 ───────── */

  const addLayer = useCallback(
    async (name: string, kind: LayerKind) => {
      const path = dir ? `${dir}/${name}` : name;
      const id = `layer-${(idRef.current += 1)}`;

      if (kind === 'vector') {
        // 矢量：先把 GeoJSON 取回来。source 用对象形式，
        // 数据必须先到手上，不能让 MapLibre 自己去 fetch（跨域与失败提示都在自己手里）。
        const res = await engine.fetchGeoJson(path);
        if (!res.ok) {
          setBanner(`读取 ${path} 失败：${res.error}`);
          return;
        }
        setVectorData((prev) => {
          const next = new Map(prev);
          next.set(id, res.data.geojson);
          return next;
        });
      }

      // 取地理范围，让画布把视野挪到数据上。
      // 栅格尤其需要：底图是"按视口实时出图"的，视野不动就看不到东西。
      // 取不到也不阻断加载——只是视野留在原处，用户可以自己拖。
      const extentRes = await engine.fetchExtent(path);
      if (extentRes.ok) {
        const bbox = extentRes.data.bbox;
        setExtents((prev) => {
          const next = new Map(prev);
          next.set(id, [bbox[0], bbox[1], bbox[2], bbox[3]]);
          return next;
        });
      }

      const layer: MapLayer = { id, name, kind, path, visible: true, opacity: 1 };
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
      setBanner(null);
    },
    [dir, engine.fetchGeoJson, engine.fetchExtent],
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

  /* ───────── 导出 PDF ───────── */

  const exportPdf = engine.exportPdf;
  const handleExportPdf = useCallback(async () => {
    // 出图时间要在取画面**之前**定下来：它要写进这一张图的标题栏
    const stamp = formatNow();
    const shot = mapHandleRef.current?.exportJpeg({ quality: 0.92, producedAt: stamp });
    if (!shot) {
      setBanner('地图还没准备好，稍后再试一次。');
      return;
    }
    const res = await exportPdf({
      jpeg: shot.jpeg,
      width: shot.width,
      height: shot.height,
      title,
      operator,
    });
    if (!res.ok) {
      setBanner(`导出失败：${res.error}`);
      return;
    }
    setProducedAt(stamp);
    downloadBlob(res.data, `cartouche-${fileStamp()}.pdf`);
    setBanner(null);
  }, [exportPdf, title, operator]);

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

  /* ───────── 渲染 ───────── */

  const engineError = engine.health.status === 'offline' ? engine.health.error : null;

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
              onSelectFeatures={(features) => {
                setSelected(features);
                setSelectedIndex(0);
              }}
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
      </div>
    </>
  );
}
