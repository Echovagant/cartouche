'use client';

/**
 * 图层选择器：多图层容器（GPKG / KML / KMZ）里的图层清单，勾选加载。
 *
 * 为什么要有它：>20 层的"文件夹汤"引擎默认只装第一个有内容的图层（3450 层的
 * 中国水系 kmz 实测教训：全合并等于数据爆炸）。这一屏把"其余图层"交还给用户 ——
 * 勾哪几个装哪几个，勾了文件里不存在的名字引擎会整体报错而不是静默跳过。
 *
 * 交互：Esc / 点遮罩关闭；全选 / 清空；至少勾一项才能"加载所选"。
 */
import { useEffect, useRef } from 'react';
import { StackIcon } from '@phosphor-icons/react';

export interface LayerPickerModalProps {
  readonly open: boolean;
  /** 所属文件名（标题里显示） */
  readonly name: string;
  /** 图层清单；null = 还在读取 */
  readonly options: readonly string[] | null;
  readonly selected: ReadonlySet<string>;
  readonly busy: boolean;
  readonly onToggle: (layerName: string) => void;
  readonly onApply: () => void;
  readonly onClose: () => void;
}

export function LayerPickerModal({
  open,
  name,
  options,
  selected,
  busy,
  onToggle,
  onApply,
  onClose,
}: LayerPickerModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="选择要加载的图层"
        className="w-full max-w-[440px] border border-studio-line bg-studio-2 shadow-[var(--studio-panel-shadow)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-studio-line px-4 py-3">
          <StackIcon size={14} aria-hidden="true" className="shrink-0 text-studio-ink-3" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-studio-ink">
            选择要加载的图层
            {name ? <span className="text-studio-ink-3"> · {name}</span> : null}
          </span>
          {options ? (
            <span className="shrink-0 font-mono text-[10.5px] text-studio-ink-3">
              {options.length} 层
            </span>
          ) : null}
        </div>

        <ul className="max-h-[46vh] overflow-y-auto py-1" role="listbox" aria-multiselectable="true">
          {options === null ? (
            <li className="px-4 py-3 text-[12.5px] text-studio-ink-3">
              {busy ? '正在读取图层清单…' : '没有可显示的图层。'}
            </li>
          ) : (
            options.map((layerName) => {
              const checked = selected.has(layerName);
              return (
                <li key={layerName}>
                  <label
                    className={`flex w-full cursor-pointer items-center gap-2.5 px-4 py-2 transition-colors ${
                      checked ? 'bg-accent/10 text-studio-ink' : 'text-studio-ink-2 hover:bg-studio-3/60'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(layerName)}
                      className="h-3.5 w-3.5 shrink-0 accent-[#2f6f5e]"
                    />
                    <span className="min-w-0 flex-1 truncate text-[12.5px]" title={layerName}>
                      {layerName}
                    </span>
                  </label>
                </li>
              );
            })
          )}
        </ul>

        <div className="flex items-center gap-2 border-t border-studio-line px-4 py-3">
          {options ? (
            <button
              type="button"
              onClick={() => {
                const allSelected = selected.size === options.length;
                if (allSelected) {
                  for (const layerName of selected) onToggle(layerName);
                } else {
                  for (const layerName of options) {
                    if (!selected.has(layerName)) onToggle(layerName);
                  }
                }
              }}
              className="font-mono text-[11px] text-studio-ink-3 transition-colors hover:text-studio-ink"
            >
              {selected.size === options.length ? '清空' : '全选'}
            </button>
          ) : null}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="border border-studio-line px-3 py-1.5 font-mono text-[11.5px] text-studio-ink-2 transition-colors hover:border-studio-ink-3 hover:text-studio-ink disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={busy || selected.size === 0}
            className="border border-accent bg-accent px-3 py-1.5 font-mono text-[11.5px] text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            加载所选{selected.size > 0 ? `（${selected.size}）` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
