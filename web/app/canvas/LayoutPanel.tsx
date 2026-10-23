'use client';

/**
 * 出图排版面板：图幅、图廓、格网、图例、比例尺、标题栏，以及出图模板的存取。
 *
 * 设计上的三条约束：
 *   - **克制**：这是工作台侧栏里的一栏，不是营销页。左对齐的紧凑行、
 *     等宽数字、小字标签，与图层面板同一套分节与控件（ui.tsx）。
 *   - **所见即所得**：面板顶上有一张实时预览，用的是与画布**同一套**绘制代码
 *     （sheet.ts 的 drawSheet），所以面板里调出来的样子就是导出后的样子。
 *   - **不静默失败**：模板读不出来、字段不合法、引擎连不上，
 *     一律把原因显示出来，不拿默认值糊弄过去。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopySimpleIcon,
  PencilSimpleIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { drawSheet } from './sheet';
import {
  DEFAULT_LAYOUT,
  TITLE_FIELD_LABELS,
  TITLE_FIELD_ORDER,
  mergeLayout,
  pageSizeMm,
  type DeepPartial,
  type SheetExtent,
  type SheetLayout,
  type SheetLegendItem,
} from './layout/types.ts';
import { BUILTIN_TEMPLATES } from './layout/presets.ts';
import {
  deleteTemplate,
  listTemplates,
  loadTemplate,
  renameTemplate,
  saveTemplate,
} from './layout/template-store.ts';
import { ActionButton, EmptyHint, SectionLabel, TextField } from './ui';

/** 预览用的出图参数（由工作台提供） */
export interface LayoutPreviewInput {
  readonly metersPerPixel: number;
  readonly extent: SheetExtent;
  readonly title: string;
  readonly operator: string;
  readonly producedAt: string;
}

export interface LayoutPanelProps {
  readonly layout: SheetLayout;
  readonly onChange: (layout: SheetLayout) => void;
  /** 项目根（模板存在项目目录里；没有项目时模板功能不可用） */
  readonly projectRoot: string | null;
  /**
   * 取预览用的出图参数。
   *
   * 给的是**函数**而不是快照：地图一直在动，格网要按当下的范围画，
   * 快照会过期（预览上的格网会跟画布对不上）。
   */
  readonly getPreview: () => LayoutPreviewInput | null;
  /** 按当前图层生成的图例条目（面板里一键生成初始条目用） */
  readonly suggestedLegend: readonly SheetLegendItem[];
  /** 把面板里的错误交给上层显示 */
  readonly onError: (message: string | null) => void;
}

/* ── 小控件 ──────────────────────────────────────────────── */

function Segmented<T extends string>({
  value,
  options,
  onChange,
  title,
}: {
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onChange: (value: T) => void;
  title?: string;
}) {
  return (
    <div
      title={title}
      className="inline-flex overflow-hidden rounded-lg border border-studio-line bg-studio/60"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={`px-2 py-1 text-[11.5px] transition-colors ${
            value === option.value
              ? 'bg-accent text-paper'
              : 'text-studio-ink-2 hover:bg-studio-3 hover:text-studio-ink'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 数字输入：编辑期间保留草稿，失焦或回车才提交。
 *
 * 直接受控会导致用户没法把 "1." 打完 —— 每次输入都被格式化回数字。
 * 不合法的值不提交，也不悄悄改成 0：留在草稿里并给出提示。
 */
function NumberField({
  value,
  onCommit,
  min = 0,
  step = 1,
  suffix,
  className = '',
}: {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  step?: number;
  suffix?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const text = draft ?? String(value);

  const commit = useCallback(() => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed < min) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(null);
    onCommit(parsed);
  }, [text, min, onCommit]);

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <TextField
        value={text}
        inputMode="decimal"
        step={step}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
        className={`tnum w-16 text-right ${invalid ? '!border-warn' : ''}`}
      />
      {suffix ? (
        <span className="font-mono text-[10.5px] text-studio-ink-3">{suffix}</span>
      ) : null}
    </span>
  );
}

/** 一行：左边是标签，右边是控件 */
function Row({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="shrink-0 text-[12px] text-studio-ink-2">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        {children}
        {hint ? (
          <span className="font-mono text-[10.5px] text-studio-ink-3">{hint}</span>
        ) : null}
      </span>
    </div>
  );
}

/* ── 单位换算（版式里存的是 96 DPI 下的像素，界面给人看毫米） ── */

const MM_PER_PX96 = 25.4 / 96;

/** 96 DPI 像素 → 毫米（保留一位小数） */
function toMm(px: number): number {
  return Math.round(px * MM_PER_PX96 * 10) / 10;
}

/** 毫米 → 96 DPI 像素（保留一位小数） */
function fromMm(mm: number): number {
  return Math.round((mm / 25.4) * 96 * 10) / 10;
}

/* ── 面板 ────────────────────────────────────────────────── */

export default function LayoutPanel({
  layout,
  onChange,
  projectRoot,
  getPreview,
  suggestedLegend,
  onError,
}: LayoutPanelProps) {
  const patch = useCallback(
    (next: DeepPartial<SheetLayout>) => {
      try {
        onChange(mergeLayout(layout, next));
        onError(null);
      } catch (err) {
        // 改坏了就不改，并把原因说出来（不静默失败）
        onError(`版式参数不合法：${(err as Error).message}`);
      }
    },
    [layout, onChange, onError],
  );

  /* ── 模板 ── */
  const [stored, setStored] = useState<readonly string[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshTemplates = useCallback(async () => {
    if (!projectRoot) {
      setStored([]);
      return;
    }
    try {
      const names = await listTemplates(projectRoot);
      setStored(names);
    } catch (err) {
      setStored([]);
      onError(`读取模板列表失败：${(err as Error).message}`);
    }
  }, [projectRoot, onError]);

  useEffect(() => {
    void refreshTemplates();
  }, [refreshTemplates]);

  const applyTemplate = useCallback(
    async (name: string) => {
      if (!projectRoot) return;
      setBusy(true);
      try {
        const loaded = await loadTemplate(projectRoot, name);
        onChange(loaded);
        onError(null);
      } catch (err) {
        onError(`套用模板失败：${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [projectRoot, onChange, onError],
  );

  const saveAs = useCallback(async () => {
    if (!projectRoot) return;
    const name = templateName.trim();
    if (!name) {
      onError('先给模板起个名字再保存。');
      return;
    }
    setBusy(true);
    try {
      await saveTemplate(projectRoot, name, layout);
      setTemplateName('');
      await refreshTemplates();
      onError(null);
    } catch (err) {
      onError(`保存模板失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [projectRoot, layout, templateName, refreshTemplates, onError]);

  const removeTemplate = useCallback(
    async (name: string) => {
      if (!projectRoot) return;
      setBusy(true);
      try {
        await deleteTemplate(projectRoot, name);
        await refreshTemplates();
        onError(null);
      } catch (err) {
        onError(`删除模板失败：${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [projectRoot, refreshTemplates, onError],
  );

  const doRename = useCallback(
    async (from: string, to: string) => {
      if (!projectRoot) return;
      setBusy(true);
      try {
        await renameTemplate(projectRoot, from, to);
        await refreshTemplates();
        onError(null);
      } catch (err) {
        onError(`重命名模板失败：${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [projectRoot, refreshTemplates, onError],
  );

  /* ── 图例条目 ── */
  const legendItems = layout.legend.items;
  const setLegendItems = useCallback(
    (items: SheetLayout['legend']['items']) => {
      patch({ legend: { items } });
    },
    [patch],
  );

  const moveLegendItem = useCallback(
    (index: number, direction: -1 | 1) => {
      const next = [...legendItems];
      const target = index + direction;
      if (target < 0 || target >= next.length) return;
      const [item] = next.splice(index, 1);
      if (!item) return;
      next.splice(target, 0, item);
      setLegendItems(next);
    },
    [legendItems, setLegendItems],
  );

  /* ── 预览 ── */
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const preview = getPreview();
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = 288;
      const cssHeight = 176;
      if (canvas.width !== Math.round(cssWidth * dpr)) {
        canvas.width = Math.round(cssWidth * dpr);
        canvas.height = Math.round(cssHeight * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#e8e3d8';
      ctx.fillRect(0, 0, cssWidth, cssHeight);
      drawSheet(ctx, {
        width: cssWidth,
        height: cssHeight,
        dpi: 96,
        title: preview?.title ?? '图名',
        operator: preview?.operator ?? '操作人',
        producedAt: preview?.producedAt ?? '2026-01-01 00:00:00',
        metersPerPixel: preview?.metersPerPixel ?? 1,
        scaleDenominator: 500,
        legend: legendItems.length > 0 ? legendItems : [{ name: '图层', color: '#2f6f5e' }],
        layout,
        content: {
          metersPerPixel: preview?.metersPerPixel ?? 1,
          scaleDenominator: 500,
          extent:
            preview?.extent ?? { minX: 120.29, minY: 30.51, maxX: 120.31, maxY: 30.53 },
        },
      });
    };

    draw();
    // 地图平移缩放不会通知到这边（画布组件不往上抛视野事件），
    // 只能定期重画一次预览，免得格网停在旧范围上。
    const timer = setInterval(draw, 1000);
    return () => clearInterval(timer);
  }, [layout, legendItems, getPreview]);

  const pageMm = pageSizeMm(layout.page);
  const graticuleMissing = layout.graticule.enabled && !getPreview();

  return (
    <div className="flex flex-col gap-5 p-4">
      <section>
        <SectionLabel
          right={
            <span className="font-mono text-[10.5px] text-studio-ink-3">
              {pageMm.width}×{pageMm.height} mm
            </span>
          }
        >
          出图排版
        </SectionLabel>

        <div className="mb-3 overflow-hidden rounded-lg border border-studio-line bg-studio-3/40">
          <canvas
            ref={canvasRef}
            className="block h-[176px] w-full"
            style={{ width: '100%', height: 176 }}
          />
        </div>
        {graticuleMissing ? (
          <p className="mb-2 text-[11.5px] leading-relaxed text-warn">
            当前拿不到地图范围，格网画不出来。地图加载完成后会自己出来。
          </p>
        ) : null}

        {/* ── 图幅 ── */}
        <div className="mb-3">
          <Row label="图幅">
            <Segmented
              value={layout.page.kind}
              options={[
                { value: 'A4', label: 'A4' },
                { value: 'A3', label: 'A3' },
              ]}
              onChange={(kind) => patch({ page: { kind } })}
            />
            <Segmented
              value={layout.page.orientation}
              options={[
                { value: 'landscape', label: '横' },
                { value: 'portrait', label: '竖' },
              ]}
              onChange={(orientation) => patch({ page: { orientation } })}
            />
          </Row>
        </div>

        {/* ── 图廓 ── */}
        <div className="mb-3">
          <Row label="外线偏移">
            <NumberField
              value={toMm(layout.frame.outerGap)}
              min={0}
              step={0.5}
              suffix="mm"
              onCommit={(mm) => patch({ frame: { outerGap: fromMm(mm) } })}
            />
          </Row>
          <Row label="内外线间距">
            <NumberField
              value={toMm(layout.frame.innerGap)}
              min={0}
              step={0.5}
              suffix="mm"
              onCommit={(mm) => patch({ frame: { innerGap: fromMm(mm) } })}
            />
          </Row>
          <Row label="线宽 外/内">
            <NumberField
              value={layout.frame.outerWidth}
              min={0}
              step={0.1}
              suffix="px"
              onCommit={(v) => patch({ frame: { outerWidth: v } })}
            />
            <NumberField
              value={layout.frame.innerWidth}
              min={0}
              step={0.1}
              suffix="px"
              onCommit={(v) => patch({ frame: { innerWidth: v } })}
            />
          </Row>
        </div>

        {/* ── 格网 ── */}
        <div className="mb-3">
          <Row label="格网">
            <Segmented
              value={layout.graticule.enabled ? 'on' : 'off'}
              options={[
                { value: 'off', label: '无' },
                { value: 'on', label: '有' },
              ]}
              onChange={(v) => patch({ graticule: { enabled: v === 'on' } })}
            />
            <Segmented
              value={layout.graticule.kind}
              options={[
                { value: 'kilometer', label: '公里网' },
                { value: 'geographic', label: '经纬网' },
              ]}
              onChange={(kind) => patch({ graticule: { kind } })}
            />
          </Row>
          {layout.graticule.enabled ? (
            <>
              <Row label="间隔">
                <NumberField
                  value={layout.graticule.interval}
                  min={0.001}
                  step={layout.graticule.kind === 'kilometer' ? 1 : 0.001}
                  suffix={layout.graticule.kind === 'kilometer' ? 'cm（图上）' : '°（经度）'}
                  onCommit={(v) => patch({ graticule: { interval: v } })}
                />
              </Row>
              <Row label="标注">
                <Segmented
                  value={layout.graticule.showLabels ? 'on' : 'off'}
                  options={[
                    { value: 'on', label: '显示' },
                    { value: 'off', label: '不显示' },
                  ]}
                  onChange={(v) => patch({ graticule: { showLabels: v === 'on' } })}
                />
              </Row>
            </>
          ) : null}
        </div>

        {/* ── 图例 ── */}
        <div className="mb-3">
          <Row label="图例位置">
            <Segmented
              value={layout.legend.position}
              options={[
                { value: 'left', label: '左' },
                { value: 'right', label: '右' },
                { value: 'bottom', label: '底' },
              ]}
              onChange={(position) => patch({ legend: { position } })}
            />
          </Row>
          <Row label="图例底色">
            <input
              type="color"
              value={layout.legend.background ?? '#ffffff'}
              onChange={(event) => patch({ legend: { background: event.target.value } })}
              className="h-6 w-10 cursor-pointer rounded border border-studio-line bg-transparent"
              title="图例背景色"
            />
            <ActionButton
              variant="quiet"
              className="!px-1.5 !py-0.5 text-[11px]"
              onClick={() => patch({ legend: { background: undefined } })}
              title="恢复默认底色"
            >
              默认
            </ActionButton>
          </Row>
          <Row label="图例边框">
            <input
              type="color"
              value={layout.legend.border ?? '#1c1a16'}
              onChange={(event) => patch({ legend: { border: event.target.value } })}
              className="h-6 w-10 cursor-pointer rounded border border-studio-line bg-transparent"
              title="图例边框色"
            />
          </Row>

          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="shrink-0 text-[12px] text-studio-ink-2">图例条目</span>
            <span className="flex items-center gap-1">
              <ActionButton
                variant="quiet"
                className="!px-1.5 !py-0.5 text-[11px]"
                disabled={suggestedLegend.length === 0}
                onClick={() => setLegendItems(suggestedLegend.map((item) => ({ ...item })))}
                title="按当前图层生成条目"
              >
                按图层生成
              </ActionButton>
              <ActionButton
                variant="quiet"
                className="!px-1.5 !py-0.5 text-[11px]"
                onClick={() =>
                  setLegendItems([
                    ...legendItems,
                    { name: `条目 ${legendItems.length + 1}`, color: '#2f6f5e', visible: true },
                  ])
                }
              >
                加一条
              </ActionButton>
            </span>
          </div>
          {legendItems.length === 0 ? (
            <p className="mt-1 text-[11.5px] leading-relaxed text-studio-ink-3">
              还没有条目。留空时按图层自动生成（和以前一样）。
            </p>
          ) : (
            <ul className="mt-1 flex flex-col gap-1">
              {legendItems.map((item, index) => (
                <li key={`${item.name}-${index}`} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={item.visible !== false}
                    onChange={(event) =>
                      setLegendItems(
                        legendItems.map((it, i) =>
                          i === index ? { ...it, visible: event.target.checked } : it,
                        ),
                      )
                    }
                    className="h-3 w-3 shrink-0 accent-[#2f6f5e]"
                    title="显示 / 隐藏"
                  />
                  <input
                    type="color"
                    value={item.color}
                    onChange={(event) =>
                      setLegendItems(
                        legendItems.map((it, i) =>
                          i === index ? { ...it, color: event.target.value } : it,
                        ),
                      )
                    }
                    className="h-5 w-7 shrink-0 cursor-pointer rounded border border-studio-line bg-transparent"
                    title="颜色"
                  />
                  <TextField
                    value={item.name}
                    onChange={(event) =>
                      setLegendItems(
                        legendItems.map((it, i) =>
                          i === index ? { ...it, name: event.target.value } : it,
                        ),
                      )
                    }
                    className="min-w-0 flex-1 !py-0.5 text-[11.5px]"
                  />
                  <ActionButton
                    variant="quiet"
                    className="!px-1 !py-0.5"
                    disabled={index === 0}
                    onClick={() => moveLegendItem(index, -1)}
                    title="上移"
                  >
                    <ArrowUpIcon size={11} weight="bold" />
                  </ActionButton>
                  <ActionButton
                    variant="quiet"
                    className="!px-1 !py-0.5"
                    disabled={index === legendItems.length - 1}
                    onClick={() => moveLegendItem(index, 1)}
                    title="下移"
                  >
                    <ArrowDownIcon size={11} weight="bold" />
                  </ActionButton>
                  <ActionButton
                    variant="danger"
                    className="!px-1 !py-0.5"
                    onClick={() => setLegendItems(legendItems.filter((_, i) => i !== index))}
                    title="删除"
                  >
                    <TrashIcon size={11} weight="bold" />
                  </ActionButton>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── 比例尺 ── */}
        <div className="mb-3">
          <Row label="比例尺单位">
            <Segmented
              value={layout.scaleBar.unit}
              options={[
                { value: 'auto', label: '自动' },
                { value: 'm', label: '米' },
                { value: 'km', label: '千米' },
              ]}
              onChange={(unit) => patch({ scaleBar: { unit } })}
            />
          </Row>
          <Row label="比例尺样式">
            <Segmented
              value={layout.scaleBar.style}
              options={[
                { value: 'alternating', label: '分段' },
                { value: 'bar', label: '实心' },
                { value: 'line', label: '细线' },
              ]}
              onChange={(style) => patch({ scaleBar: { style } })}
            />
          </Row>
          <Row label="比例尺位置">
            <Segmented
              value={layout.scaleBar.position}
              options={[
                { value: 'left', label: '左' },
                { value: 'right', label: '右' },
                { value: 'bottom', label: '底' },
              ]}
              onChange={(position) => patch({ scaleBar: { position } })}
            />
          </Row>
        </div>

        {/* ── 标题栏 ── */}
        <div className="mb-3">
          <Row label="标题栏位置">
            <Segmented
              value={layout.titleBlock.position}
              options={[
                { value: 'bottom-right', label: '右下' },
                { value: 'bottom-left', label: '左下' },
              ]}
              onChange={(position) => patch({ titleBlock: { position } })}
            />
          </Row>
          <div className="mt-1 flex flex-col gap-1">
            {(['title', ...TITLE_FIELD_ORDER] as const).map((key) => {
              const on = key in layout.titleBlock.fields;
              const fixed = layout.titleBlock.fields[key] ?? '';
              return (
                <div key={key} className="flex items-center gap-1.5">
                  <label className="flex min-w-0 flex-1 items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(event) => {
                        const fields = { ...layout.titleBlock.fields };
                        if (event.target.checked) fields[key] = '';
                        else delete fields[key];
                        patch({ titleBlock: { fields } });
                      }}
                      className="h-3 w-3 shrink-0 accent-[#2f6f5e]"
                    />
                    <span className="shrink-0 text-[11.5px] text-studio-ink-2">
                      {key === 'title' ? '图名' : TITLE_FIELD_LABELS[key]}
                    </span>
                  </label>
                  <TextField
                    value={fixed}
                    disabled={!on}
                    placeholder={key === 'title' ? '用本次图名' : '不填=不显示'}
                    onChange={(event) => {
                      const fields = { ...layout.titleBlock.fields, [key]: event.target.value };
                      patch({ titleBlock: { fields } });
                    }}
                    className="min-w-0 flex-1 !py-0.5 text-[11.5px]"
                  />
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── 模板 ── */}
      <section>
        <SectionLabel
          right={
            <ActionButton
              variant="quiet"
              className="!px-1.5 !py-0.5 text-[11px]"
              onClick={() => {
                onChange(DEFAULT_LAYOUT);
                onError(null);
              }}
              title="恢复默认版式"
            >
              复位
            </ActionButton>
          }
        >
          出图模板
        </SectionLabel>

        {!projectRoot ? (
          <EmptyHint>打开一个项目后才能存取模板（模板存在项目目录里）。</EmptyHint>
        ) : (
          <>
            <ul className="mb-3 flex flex-col gap-1">
              {BUILTIN_TEMPLATES.map((preset) => (
                <li
                  key={preset.name}
                  className="flex items-center gap-1.5 rounded-lg border border-studio-line bg-studio-3/35 px-2 py-1.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-studio-ink">
                      {preset.name}
                    </span>
                    <span className="block truncate text-[10.5px] text-studio-ink-3">
                      {preset.description}
                    </span>
                  </span>
                  <ActionButton
                    variant="quiet"
                    className="!px-1.5 !py-0.5 text-[11px]"
                    disabled={busy}
                    onClick={() => {
                      onChange(preset.layout);
                      onError(null);
                    }}
                    title="套用"
                  >
                    <CheckIcon size={12} weight="bold" />
                  </ActionButton>
                </li>
              ))}
            </ul>

            {stored.length > 0 ? (
              <ul className="mb-3 flex flex-col gap-1">
                {stored.map((name) => (
                  <li
                    key={name}
                    className="flex items-center gap-1.5 rounded-lg border border-studio-line bg-studio-3/35 px-2 py-1.5"
                  >
                    {renaming === name ? (
                      <>
                        <TextField
                          value={templateName}
                          autoFocus
                          onChange={(event) => setTemplateName(event.target.value)}
                          className="min-w-0 flex-1 !py-0.5 text-[11.5px]"
                        />
                        <ActionButton
                          variant="primary"
                          className="!px-1.5 !py-0.5 text-[11px]"
                          disabled={busy || !templateName.trim()}
                          onClick={() => {
                            void doRename(name, templateName.trim());
                            setRenaming(null);
                            setTemplateName('');
                          }}
                        >
                          存
                        </ActionButton>
                        <ActionButton
                          variant="quiet"
                          className="!px-1.5 !py-0.5 text-[11px]"
                          onClick={() => {
                            setRenaming(null);
                            setTemplateName('');
                          }}
                        >
                          取消
                        </ActionButton>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-studio-ink">
                          {name}
                        </span>
                        <ActionButton
                          variant="quiet"
                          className="!px-1 !py-0.5"
                          disabled={busy}
                          onClick={() => {
                            void applyTemplate(name);
                          }}
                          title="套用"
                        >
                          <CheckIcon size={12} weight="bold" />
                        </ActionButton>
                        <ActionButton
                          variant="quiet"
                          className="!px-1 !py-0.5"
                          disabled={busy}
                          onClick={() => {
                            setRenaming(name);
                            setTemplateName(name);
                          }}
                          title="重命名"
                        >
                          <PencilSimpleIcon size={12} weight="bold" />
                        </ActionButton>
                        <ActionButton
                          variant="danger"
                          className="!px-1 !py-0.5"
                          disabled={busy}
                          onClick={() => {
                            void removeTemplate(name);
                          }}
                          title="删除"
                        >
                          <TrashIcon size={12} weight="bold" />
                        </ActionButton>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="flex items-center gap-1.5">
              <TextField
                value={templateName}
                placeholder="另存为…（模板名）"
                onChange={(event) => setTemplateName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveAs();
                }}
                className="min-w-0 flex-1"
              />
              <ActionButton
                variant="primary"
                disabled={busy || !templateName.trim()}
                onClick={() => {
                  void saveAs();
                }}
              >
                <CopySimpleIcon size={12} weight="bold" />
                另存为
              </ActionButton>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
