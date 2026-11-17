'use client';

/**
 * 符号化与标注（最小切片）：单色 / 唯一值 / 分级色彩 + 一个字段的标注。
 *
 * 为什么先做这一块：出图用户最常见的两类诉求是「按类别上色」和「面上标名字」。
 * 全套符号化（渐变、点图案、复杂线型、3D）明确不做 —— 做一半不如不做。
 *
 * 数据从当前画布已加载的 GeoJSON 里取：类别与断点都基于**真实属性值**算，
 * 不编示例数据。分块图层只加载了视口内数据时，面板会明确提示。
 */
import { useEffect, useMemo, useState } from 'react';
import { XIcon } from '@phosphor-icons/react';
import type { LayerStyle, Symbology } from './symbology';
import {
  COLOR_RAMPS,
  DEFAULT_FALLBACK_COLOR,
  DEFAULT_RAMP,
  DEFAULT_VECTOR_COLOR,
  distinctCategories,
  isNumericField,
  makeGraduatedSymbology,
  makeUniqueSymbology,
  collectFields,
  numericValues,
  type GraduatedMethod,
  type SymbologyKind,
} from './symbology';
import { ActionButton } from './ui';

export interface SymbologyPanelProps {
  readonly open: boolean;
  readonly layerName: string;
  readonly style: LayerStyle | undefined;
  /** 当前图层已加载的 GeoJSON（可能只是视口内的一部分） */
  readonly data: unknown;
  readonly onSave: (style: LayerStyle) => void;
  readonly onClose: () => void;
}

const KIND_LABELS: Record<SymbologyKind, string> = {
  single: '单色',
  unique: '唯一值',
  graduated: '分级色彩',
};

const METHOD_LABELS: Record<GraduatedMethod, string> = {
  equal: '等间隔',
  quantile: '分位数',
};

const LABEL_SIZES = [10, 12, 14, 16, 18, 22];

const SELECT_CLASS =
  'h-9 rounded-md border border-studio-line bg-studio-3 px-2 text-[12.5px] text-studio-ink outline-none focus:border-accent';

export default function SymbologyPanel({
  open,
  layerName,
  style,
  data,
  onSave,
  onClose,
}: SymbologyPanelProps) {
  const fields = useMemo(() => collectFields(data), [data]);
  const numericFields = useMemo(
    () => fields.filter((f) => isNumericField(data, f)),
    [fields, data],
  );

  const [kind, setKind] = useState<SymbologyKind>('single');
  const [singleColor, setSingleColor] = useState(DEFAULT_VECTOR_COLOR);
  const [field, setField] = useState('');
  const [rampId, setRampId] = useState(DEFAULT_RAMP.id);
  const [uniqueColors, setUniqueColors] = useState<Record<string, string>>({});
  const [method, setMethod] = useState<GraduatedMethod>('equal');
  const [classCount, setClassCount] = useState(5);
  const [breaks, setBreaks] = useState<number[]>([]);
  const [gradColors, setGradColors] = useState<string[]>([DEFAULT_VECTOR_COLOR]);
  const [labelOn, setLabelOn] = useState(false);
  const [labelField, setLabelField] = useState('');
  const [labelSize, setLabelSize] = useState(14);
  const [labelColor, setLabelColor] = useState('#1f2937');
  const [labelHalo, setLabelHalo] = useState('#ffffff');

  // 打开时按已有样式回填；没有样式就从当前数据里挑第一个可用字段
  useEffect(() => {
    if (!open) return;
    const sym = style?.symbology;
    const initialKind: SymbologyKind = sym?.kind ?? 'single';
    setKind(initialKind);
    setSingleColor(sym?.kind === 'single' ? sym.color : DEFAULT_VECTOR_COLOR);
    const preferredField =
      sym && sym.kind !== 'single'
        ? sym.field
        : (fields[0] ?? '');
    setField(preferredField);
    setRampId(DEFAULT_RAMP.id);
    if (sym?.kind === 'unique') {
      setUniqueColors({ ...sym.colors });
      setMethod('equal');
      setClassCount(5);
      setBreaks([]);
      setGradColors([DEFAULT_VECTOR_COLOR]);
    } else if (sym?.kind === 'graduated') {
      setUniqueColors({});
      setMethod(sym.method);
      setClassCount(Math.max(2, sym.breaks.length + 1));
      setBreaks([...sym.breaks]);
      setGradColors([...sym.colors]);
    } else {
      setUniqueColors(
        preferredField ? makeUniqueSymbology(data, preferredField).colors : {},
      );
      setMethod('equal');
      setClassCount(5);
      const gen = preferredField
        ? makeGraduatedSymbology(data, preferredField, 'equal', 5)
        : { breaks: [], colors: [DEFAULT_VECTOR_COLOR] };
      setBreaks([...gen.breaks]);
      setGradColors([...gen.colors]);
    }

    const labels = style?.labels;
    setLabelOn(Boolean(labels));
    setLabelField(labels?.field ?? fields[0] ?? '');
    setLabelSize(labels?.size ?? 14);
    setLabelColor(labels?.color ?? '#1f2937');
    setLabelHalo(labels?.halo ?? '#ffffff');
    // fields/data 只是回填的候选来源；用户改样式时不该被它们重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, style, layerName]);

  /* 改字段 / 改色带 / 改分级方法 → 重新生成颜色与断点 */
  const regenerate = (next: {
    kind?: SymbologyKind;
    field?: string;
    rampId?: string;
    method?: GraduatedMethod;
    classCount?: number;
  }): void => {
    const k = next.kind ?? kind;
    const f = next.field ?? field;
    const r = next.rampId ?? rampId;
    const m = next.method ?? method;
    const c = next.classCount ?? classCount;
    if (k === 'unique') {
      setUniqueColors(f ? makeUniqueSymbology(data, f, r).colors : {});
    } else if (k === 'graduated') {
      const gen = f ? makeGraduatedSymbology(data, f, m, c, r) : { breaks: [], colors: [DEFAULT_VECTOR_COLOR] };
      setBreaks([...gen.breaks]);
      setGradColors([...gen.colors]);
    }
  };

  if (!open) return null;

  const allCategories = field ? distinctCategories(data, field, 200) : [];
  const categories = allCategories.slice(0, 12);
  const totalCategories = allCategories.length;
  const numericCount = field ? numericValues(data, field).length : 0;

  const save = (): void => {
    let symbology: Symbology;
    if (kind === 'single') {
      symbology = { kind: 'single', color: singleColor };
    } else if (kind === 'unique') {
      if (!field) return;
      symbology = {
        kind: 'unique',
        field,
        colors: uniqueColors,
        fallback: DEFAULT_FALLBACK_COLOR,
      };
    } else {
      if (!field) return;
      symbology = { kind: 'graduated', field, method, breaks, colors: gradColors };
    }
    const labels =
      labelOn && labelField
        ? { field: labelField, size: labelSize, color: labelColor, halo: labelHalo }
        : undefined;
    onSave({ symbology, ...(labels ? { labels } : {}) });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${layerName} 的样式`}
      className="fixed inset-0 z-[60] flex items-start justify-center bg-studio/60 px-4 pt-[8vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-[560px] flex-col border border-studio-line bg-studio-2 shadow-[var(--studio-panel-shadow)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-studio-line px-4 py-3">
          <strong className="truncate font-display text-[14px] font-semibold text-studio-ink">
            样式 · {layerName}
          </strong>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭样式面板"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-studio-ink-3 transition-colors hover:bg-studio-3 hover:text-studio-ink"
          >
            <XIcon size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {fields.length === 0 ? (
            <p className="rounded-md border border-warn/35 bg-warn/10 px-3 py-2 text-[12px] leading-relaxed text-warn">
              这个图层还没有属性字段（或数据还没加载完），暂时只能改单色。
            </p>
          ) : null}

          {/* 渲染方式 */}
          <div className="text-[13px] font-medium text-studio-ink">渲染方式</div>
          <div className="mt-2 inline-flex overflow-hidden rounded-md border border-studio-line">
            {(['single', 'unique', 'graduated'] as const).map((k, i) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => {
                  setKind(k);
                  regenerate({ kind: k });
                }}
                className={`px-3 py-1.5 font-mono text-[11.5px] transition-colors ${
                  kind === k
                    ? 'bg-accent text-paper'
                    : 'text-studio-ink-2 hover:bg-studio-3 hover:text-studio-ink'
                } ${i === 0 ? '' : 'border-l border-studio-line'}`}
              >
                {KIND_LABELS[k]}
              </button>
            ))}
          </div>

          {kind === 'single' ? (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[12px] text-studio-ink-2">颜色</span>
              <input
                type="color"
                value={singleColor}
                onChange={(event) => setSingleColor(event.target.value)}
                aria-label="单色颜色"
                className="h-8 w-12 cursor-pointer rounded border border-studio-line bg-transparent"
              />
            </div>
          ) : (
            <>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-[12px] text-studio-ink-2">
                  {kind === 'unique' ? '类别字段' : '数值字段'}
                  <select
                    value={field}
                    onChange={(event) => {
                      setField(event.target.value);
                      regenerate({ field: event.target.value });
                    }}
                    className={SELECT_CLASS}
                  >
                    <option value="">请选择字段</option>
                    {(kind === 'graduated' ? numericFields : fields).map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[12px] text-studio-ink-2">
                  色带
                  <select
                    value={rampId}
                    onChange={(event) => {
                      setRampId(event.target.value);
                      regenerate({ rampId: event.target.value });
                    }}
                    className={SELECT_CLASS}
                  >
                    {COLOR_RAMPS.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {kind === 'graduated' ? (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1 text-[12px] text-studio-ink-2">
                    分级方法
                    <select
                      value={method}
                      onChange={(event) => {
                        const m = event.target.value as GraduatedMethod;
                        setMethod(m);
                        regenerate({ method: m });
                      }}
                      className={SELECT_CLASS}
                    >
                      {(['equal', 'quantile'] as const).map((m) => (
                        <option key={m} value={m}>
                          {METHOD_LABELS[m]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] text-studio-ink-2">
                    分级数
                    <select
                      value={classCount}
                      onChange={(event) => {
                        const c = Number(event.target.value);
                        setClassCount(c);
                        regenerate({ classCount: c });
                      }}
                      className={SELECT_CLASS}
                    >
                      {[3, 5, 7].map((c) => (
                        <option key={c} value={c}>
                          {c} 级
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}

              {/* 唯一值：类别色 */}
              {kind === 'unique' ? (
                <div className="mt-3">
                  <div className="text-[12px] text-studio-ink-2">
                    类别
                    {totalCategories > 12 ? (
                      <span className="ml-1 text-studio-ink-3">
                        （共 {totalCategories} 类，这里只显示前 12 类；其余用兜底色）
                      </span>
                    ) : null}
                  </div>
                  {categories.length === 0 ? (
                    <p className="mt-1 text-[12px] text-studio-ink-3">这个字段还没有可用的类别值。</p>
                  ) : (
                    <ul className="mt-1.5 flex max-h-[210px] flex-col gap-1 overflow-y-auto pr-1">
                      {categories.map((c) => (
                        <li key={c.key} className="flex items-center gap-2 text-[12px]">
                          <input
                            type="color"
                            value={uniqueColors[c.key] ?? DEFAULT_VECTOR_COLOR}
                            onChange={(event) =>
                              setUniqueColors((prev) => ({ ...prev, [c.key]: event.target.value }))
                            }
                            aria-label={`${c.label} 的颜色`}
                            className="h-6 w-8 cursor-pointer rounded border border-studio-line bg-transparent"
                          />
                          <span className="min-w-0 flex-1 truncate text-studio-ink" title={c.label}>
                            {c.label}
                          </span>
                          <span className="font-mono text-[11px] text-studio-ink-3">{c.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}

              {/* 分级：区间预览 */}
              {kind === 'graduated' ? (
                <div className="mt-3">
                  <div className="text-[12px] text-studio-ink-2">
                    分级
                    {numericCount === 0 ? (
                      <span className="ml-1 text-warn">（这个字段没有数值，暂时只能用单色）</span>
                    ) : null}
                  </div>
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {gradColors.map((color, i) => (
                      <li key={`${color}-${i}`} className="flex items-center gap-2 text-[12px]">
                        <span
                          className="h-3.5 w-6 shrink-0 rounded-sm border border-studio-line"
                          style={{ background: color }}
                        />
                        <span className="text-studio-ink">
                          {breaks.length === 0
                            ? '全部'
                            : i === 0
                              ? `< ${fmtBreak(breaks[0]!)}`
                              : i >= breaks.length
                                ? `≥ ${fmtBreak(breaks[breaks.length - 1]!)}`
                                : `${fmtBreak(breaks[i - 1]!)} – ${fmtBreak(breaks[i]!)}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}

          {/* 标注 */}
          <div className="mt-5 border-t border-studio-line pt-4">
            <label className="flex items-center gap-2 text-[13px] font-medium text-studio-ink">
              <input
                type="checkbox"
                checked={labelOn}
                onChange={(event) => setLabelOn(event.target.checked)}
                className="h-3.5 w-3.5 accent-[#2f6f5e]"
              />
              显示标注
            </label>
            {labelOn ? (
              <div className="mt-2 grid grid-cols-2 gap-3">
                <label className="col-span-2 flex flex-col gap-1 text-[12px] text-studio-ink-2">
                  标注字段
                  <select
                    value={labelField}
                    onChange={(event) => setLabelField(event.target.value)}
                    className={SELECT_CLASS}
                  >
                    <option value="">请选择字段</option>
                    {fields.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[12px] text-studio-ink-2">
                  字号
                  <select
                    value={labelSize}
                    onChange={(event) => setLabelSize(Number(event.target.value))}
                    className={SELECT_CLASS}
                  >
                    {LABEL_SIZES.map((s) => (
                      <option key={s} value={s}>
                        {s} px
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-end gap-3">
                  <label className="flex flex-col gap-1 text-[12px] text-studio-ink-2">
                    文字色
                    <input
                      type="color"
                      value={labelColor}
                      onChange={(event) => setLabelColor(event.target.value)}
                      aria-label="标注文字颜色"
                      className="h-8 w-12 cursor-pointer rounded border border-studio-line bg-transparent"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] text-studio-ink-2">
                    描边色
                    <input
                      type="color"
                      value={labelHalo}
                      onChange={(event) => setLabelHalo(event.target.value)}
                      aria-label="标注描边颜色"
                      className="h-8 w-12 cursor-pointer rounded border border-studio-line bg-transparent"
                    />
                  </label>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-studio-line px-4 py-3">
          <ActionButton variant="quiet" onClick={onClose}>
            取消
          </ActionButton>
          <ActionButton
            onClick={save}
            disabled={kind !== 'single' && (!field || fields.length === 0)}
          >
            保存样式
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

/** 断点数字的展示（大数不带小数）。 */
function fmtBreak(n: number): string {
  if (Math.abs(n) >= 10000) return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
