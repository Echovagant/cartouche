'use client';

/**
 * 工具栏。
 *
 * 两个动作对应两条"交差"链路：
 *   - 导出 PDF：把当前视口（图框、标题栏、比例尺、图例、指北针都已画好）封成 PDF；
 *   - 兼容性报告：出一份可以直接转给 GIS 同事的自检材料。
 *
 * 按钮的可用性由上层算好：没有选中图层时没法出报告（报告要有被检查的文件）。
 *
 * 另有一组"栅格显示"的分段控件：三档说人话的选择，影响底图怎么上屏。
 */
import { useRef, type KeyboardEvent } from 'react';
import { FilePdfIcon, ShieldCheckIcon, SparkleIcon } from '@phosphor-icons/react';
import type { HealthStatus } from './useEngine';
import { MagneticButton } from '../motion/MagneticLink';
import { ActionButton, StatusDot } from './ui';

export interface ToolbarProps {
  onExportPdf: () => void;
  onCompatReport: () => void;
  exporting: boolean;
  reporting: boolean;
  /** 是否存在可检查的文件 */
  canReport: boolean;
  health: HealthStatus;
  onReloadHealth: () => void;
  /**
   * 栅格显示的拉伸档位。
   * undefined = 自动（不给引擎发参数，由引擎按源类型决定）。
   */
  stretch?: 'auto' | 'none';
  /** 切档；传 undefined = 回到「自动」 */
  onStretchChange: (value: 'auto' | 'none' | undefined) => void;
  /** 跳到 AI 工作台，把当前项目与图层带过去 */
  onOpenAi: () => void;
  /** 为什么现在点不了（空 = 可以点） */
  aiBlockedReason: string;
}

const HEALTH_TEXT: Record<HealthStatus, string> = {
  checking: '引擎连接中',
  ready: '引擎已就绪',
  offline: '引擎未启动',
};

/**
 * 三档显示方式。
 *
 * 为什么是三档而不是两档：「自动」这一档**不给引擎发参数**，
 * 由引擎按源类型自己决定（8 位按原样、16 位按实际亮度）。
 * 如果默认就发 'auto'，8 位影像的显示行为会跟着变（现在是不拉伸）——
 * 那是既有行为，不该被这个开关顺手改掉。
 *
 * 文案写给不懂 GIS 的人：说清"屏幕上的亮度"和"文件里的数值"的关系。
 */
const STRETCH_OPTIONS: readonly {
  readonly value: 'auto' | 'none' | undefined;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    value: undefined,
    label: '自动',
    hint: '8 位按原样、16 位按实际亮度',
  },
  {
    value: 'auto',
    label: '按实际亮度',
    hint: '把这幅图实际用到的明暗范围铺满，画面最接近 ArcGIS Pro 里看到的效果',
  },
  {
    value: 'none',
    label: '按原始值',
    hint: '严格按文件里的数值显示；16 位影像会偏暗',
  },
];

export default function Toolbar({
  onExportPdf,
  onCompatReport,
  exporting,
  reporting,
  canReport,
  health,
  onReloadHealth,
  stretch,
  onStretchChange,
  onOpenAi,
  aiBlockedReason,
}: ToolbarProps) {
  const exportDisabled = exporting || health !== 'ready';
  const reportDisabled = reporting || !canReport || health !== 'ready';
  const aiDisabled = aiBlockedReason !== '';

  // 分段控件的按钮节点：roving tabindex 需要把焦点挪到刚选中的那一档
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const activeIndex = Math.max(
    0,
    STRETCH_OPTIONS.findIndex((option) => option.value === stretch),
  );
  const activeHint = STRETCH_OPTIONS.find((option) => option.value === stretch)?.hint ?? '';

  /**
   * 键盘切档：← → （顺带 ↑ ↓ / Home / End）。
   *
   * 切完把焦点跟着挪过去：不挪的话键盘用户每换一档都得重新 Tab 一次，
   * 连续对比三档会非常别扭。
   */
  const onOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = STRETCH_OPTIONS.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = index === last ? 0 : index + 1;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = index === 0 ? last : index - 1;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = last;
    }
    if (next === null) return;
    event.preventDefault();
    const target = STRETCH_OPTIONS[next];
    if (!target) return;
    onStretchChange(target.value);
    optionRefs.current[next]?.focus();
  };

  return (
    <div className="flex items-center gap-2 border-b border-studio-line bg-studio-2/60 px-4 py-2.5">
      <MagneticButton
        onClick={onExportPdf}
        disabled={exportDisabled}
        title={health !== 'ready' ? '引擎未就绪' : '把当前视口封成带图框的 PDF'}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-accent bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-paper shadow-[0_2px_14px_-4px_rgba(47,111,94,0.85)] transition-colors hover:border-accent-deep hover:bg-accent-deep active:translate-y-px disabled:pointer-events-none disabled:opacity-40"
      >
        <FilePdfIcon size={15} weight="bold" />
        {exporting ? '正在导出' : '导出 PDF'}
      </MagneticButton>

      <MagneticButton
        onClick={onCompatReport}
        disabled={reportDisabled}
        title={canReport ? '对当前图层生成兼容性自检报告' : '先加载一个图层'}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-studio-line bg-studio-3/70 px-3 py-1.5 text-[12.5px] font-medium text-studio-ink transition-colors hover:border-studio-ink-3 hover:bg-studio-3 active:translate-y-px disabled:pointer-events-none disabled:opacity-40"
      >
        <ShieldCheckIcon size={15} weight="bold" />
        {reporting ? '正在检查' : '兼容性报告'}
      </MagneticButton>

      {/* 用一句话改图：把当前项目与图层带进 AI 工作台。
          放在「导出 / 报告」这一组之后：这组是"交差"链路，
          AI 改图是另一条链路，紧挨着容易被当成同一件事的两步。 */}
      <MagneticButton
        onClick={onOpenAi}
        disabled={aiDisabled}
        title={aiDisabled ? aiBlockedReason : '把当前项目与图层带进 AI 工作台，用一句话提议改动'}
        className="ml-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-studio-line bg-studio-3/70 px-3 py-1.5 text-[12.5px] font-medium text-studio-ink transition-colors hover:border-studio-ink-3 hover:bg-studio-3 active:translate-y-px disabled:pointer-events-none disabled:opacity-40"
      >
        <SparkleIcon size={15} weight="bold" />
        用一句话改图
      </MagneticButton>

      {/* 栅格显示档位。
          放在这组按钮之后、不去挤右边的健康状态区：它管的是底图怎么上屏，
          跟"导出 / 报告"是两条不同的心智模型，挨在一起反而看不明白。 */}
      <div className="ml-1 flex items-center gap-2">
        <span className="text-[11.5px] text-studio-ink-3">栅格显示</span>
        <div
          role="radiogroup"
          aria-label="栅格显示的拉伸档位"
          className="flex items-center overflow-hidden rounded-lg border border-studio-line bg-studio-3/50"
        >
          {STRETCH_OPTIONS.map((option, index) => {
            const active = index === activeIndex;
            return (
              <button
                key={option.label}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                role="radio"
                aria-checked={active}
                aria-describedby={`stretch-hint-${index}`}
                tabIndex={active ? 0 : -1}
                title={option.hint}
                onClick={() => {
                  onStretchChange(option.value);
                }}
                onKeyDown={(event) => {
                  onOptionKeyDown(event, index);
                }}
                className={[
                  'px-2.5 py-1.5 text-[12.5px] transition-colors',
                  index > 0 ? 'border-l border-studio-line' : '',
                  active
                    ? 'bg-studio-ink/15 font-medium text-studio-ink'
                    : 'text-studio-ink-3 hover:bg-studio-ink/8 hover:text-studio-ink-2',
                ].join(' ')}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {/* 当前档位的大白话解释：悬停提示里看不全的，在这里一直摆着 */}
        <span
          className="hidden max-w-[440px] truncate text-[11.5px] text-studio-ink-3 xl:inline"
          title={activeHint}
        >
          {activeHint}
        </span>
        {/* 读屏用的说明文本：放在按钮外面，免得把按钮的名字撑长 */}
        {STRETCH_OPTIONS.map((option, index) => (
          <span key={option.label} id={`stretch-hint-${index}`} className="sr-only">
            {option.hint}
          </span>
        ))}
      </div>

      <span className="flex-1" />

      <span className="flex items-center gap-1.5 text-[12px] text-studio-ink-2">
        <StatusDot tone={health} />
        {HEALTH_TEXT[health]}
      </span>
      <ActionButton variant="quiet" onClick={onReloadHealth} className="!px-2 !py-1 text-[11.5px]">
        重新体检
      </ActionButton>
    </div>
  );
}
