'use client';

/**
 * 底部面板（Ctrl+J）：VS Code 的「面板」位。
 *
 * 两个标签页：
 *   - 属性表：选中要素的属性（选中要素时自动切过来）；
 *   - 改图记录：这个项目的全部操作留痕（按时间倒序）——
 *     它是「事后查」的东西，不占改图时的画布（用户裁定 2026-11-14）。
 *
 * 高度固定 200px，拖拽调高暂不做（YAGNI）；关闭按钮与 Ctrl+J 都能收起。
 */
import { ListChecksIcon, TableIcon, XIcon } from '@phosphor-icons/react';
import AttributeTable from '../AttributeTable';
import type { ProjectOperation, SelectedFeature } from '../types';

export type PanelTab = 'attributes' | 'history';

export interface BottomPanelProps {
  readonly tab: PanelTab;
  readonly onTabChange: (tab: PanelTab) => void;
  readonly onClose: () => void;
  readonly features: readonly SelectedFeature[];
  readonly activeIndex: number;
  readonly onSelect: (index: number) => void;
  readonly operations: readonly ProjectOperation[];
}

/** 一条留痕的人话时间：ISO → 本地「MM-DD HH:mm:ss」 */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function BottomPanel({
  tab,
  onTabChange,
  onClose,
  features,
  activeIndex,
  onSelect,
  operations,
}: BottomPanelProps) {
  return (
    <div className="flex h-[200px] shrink-0 flex-col border-t border-studio-line bg-studio-2/70">
      <div className="flex h-8 shrink-0 items-stretch border-b border-studio-line px-1.5">
        {(
          [
            { id: 'attributes', label: '属性表', icon: TableIcon, count: features.length },
            { id: 'history', label: '改图记录', icon: ListChecksIcon, count: operations.length },
          ] as const
        ).map(({ id, label, icon: Icon, count }) => (
          <button
            key={id}
            type="button"
            onClick={() => onTabChange(id)}
            aria-pressed={tab === id}
            className={`flex items-center gap-1.5 border-b-2 px-3 text-[12px] transition-colors ${
              tab === id
                ? 'border-accent text-studio-ink'
                : 'border-transparent text-studio-ink-3 hover:text-studio-ink-2'
            }`}
          >
            <Icon size={13} aria-hidden="true" />
            {label}
            {count > 0 ? <span className="tnum font-mono text-[10.5px]">{count}</span> : null}
          </button>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="收起面板"
          title="收起面板（Ctrl+J）"
          className="flex w-8 items-center justify-center text-studio-ink-3 transition-colors hover:text-studio-ink"
        >
          <XIcon size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'attributes' ? (
          features.length === 0 ? (
            <p className="px-4 py-4 text-[12.5px] text-studio-ink-3">
              在地图上点一个要素，它的属性表会出现在这里。
            </p>
          ) : (
            <AttributeTable
              features={features}
              activeIndex={activeIndex}
              onSelect={onSelect}
              onClose={onClose}
            />
          )
        ) : operations.length === 0 ? (
          <p className="px-4 py-4 text-[12.5px] leading-relaxed text-studio-ink-3">
            还没有改过图。每次执行的操作（改了什么、动了多少、备份在哪）都会记在这里，
            交差时可以直接对着说清楚。
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-studio-line">
            {[...operations].reverse().map((op, index) => (
              <li key={`${op.at}-${op.op}-${op.target}-${index}`} className="flex items-baseline gap-3 px-4 py-1.5 text-[12px]">
                <span className="tnum shrink-0 font-mono text-[11px] text-studio-ink-3">
                  {formatWhen(op.at)}
                </span>
                <span className={`shrink-0 font-medium ${op.ok ? 'text-accent' : 'text-warn'}`}>
                  {op.ok ? '✓' : '✗'}
                </span>
                <span className="min-w-0 flex-1 truncate text-studio-ink-2">
                  {op.target.split('/').pop() ?? op.target}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-studio-ink-3">{op.op}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
