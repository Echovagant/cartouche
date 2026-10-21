'use client';

/**
 * 要素属性表。
 *
 * 字段名**保持源文件里的中文原样**：这份表最终要拿去和 ArcGIS 里的属性表对照，
 * 翻译一遍反而对不上。值统一转成字符串显示；对象/数组用 JSON 展开。
 */
import { XIcon } from '@phosphor-icons/react';
import type { SelectedFeature } from './types';
import { ActionButton, EmptyHint, SectionLabel } from './ui';

export interface AttributeTableProps {
  features: readonly SelectedFeature[];
  /** 当前显示的是第几个要素 */
  activeIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}

/** 属性值 → 显示文本 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '（空）' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default function AttributeTable({
  features,
  activeIndex,
  onSelect,
  onClose,
}: AttributeTableProps) {
  if (features.length === 0) {
    return (
      <div className="p-4">
        <SectionLabel>属性表</SectionLabel>
        <EmptyHint>
          在地图上点一个要素，这里会显示它的属性。
          <br />
          字段名保持源文件里的中文原样，方便直接和 ArcGIS 里的属性表对照。
        </EmptyHint>
      </div>
    );
  }

  const active = features[activeIndex] ?? features[0];
  if (!active) return null;
  const entries = Object.entries(active.properties);

  return (
    <div className="p-4">
      <SectionLabel
        right={
          <ActionButton variant="quiet" onClick={onClose} className="!px-2 !py-0.5 text-[11.5px]">
            <XIcon size={12} weight="bold" />
            清除选择
          </ActionButton>
        }
      >
        属性表 · {active.layerName}
      </SectionLabel>

      {features.length > 1 ? (
        <div className="mb-3">
          <div className="mb-1.5 text-[11.5px] text-studio-ink-3">本次点到 {features.length} 个要素</div>
          <div className="flex flex-wrap gap-1.5">
            {features.map((feature, index) => (
              <button
                key={`${feature.layerId}-${feature.index}-${index}`}
                type="button"
                onClick={() => onSelect(index)}
                className={`rounded-md border px-2 py-0.5 text-[11.5px] transition-colors ${
                  index === activeIndex
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-studio-line bg-studio-3/45 text-studio-ink-2 hover:border-studio-line-2'
                }`}
              >
                {feature.layerName} #{index + 1}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            <th className="w-[38%] border border-studio-line bg-studio-3/60 px-2 py-1.5 text-left font-medium text-studio-ink">
              字段
            </th>
            <th className="border border-studio-line bg-studio-3/60 px-2 py-1.5 text-left font-medium text-studio-ink">
              值
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td colSpan={2} className="border border-studio-line px-2 py-2 text-studio-ink-3">
                该要素没有属性字段。
              </td>
            </tr>
          ) : (
            entries.map(([key, value]) => (
              <tr key={key} className="transition-colors hover:bg-studio-3/40">
                <td className="border border-studio-line px-2 py-1.5 break-all text-studio-ink-2">{key}</td>
                <td className="border border-studio-line px-2 py-1.5 font-mono break-all text-studio-ink">
                  {formatValue(value)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
