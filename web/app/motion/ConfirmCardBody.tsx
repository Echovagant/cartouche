/**
 * 确认卡本体（纯展示组件）。
 *
 * 这张卡是"改动会不会落到文件上"的最后一道关卡：影响面、目标文件、
 * 备份文件、操作类型，四件事一次说清楚。
 *
 * 为什么要抽出来：
 *   - 画布（studio 主题）与官网（墨面深色段）要显示**同一张卡**；
 *   - 官网上要显示的是**一次真实运行的录制值**，而不是示意图；
 *   - 以前官网只能贴一张 556px 宽的位图截图（必然糊），
 *     抽成组件后官网渲染的是矢量，永远清晰，改版自动同步。
 *
 * 组件只负责"把四个闸门值摆出来"，不碰预演、不碰执行、
 * 不碰二次确认——那些逻辑仍然留在画布的 ConfirmCard 里。
 */

import type { ReactNode } from 'react';

export interface ConfirmGate {
  /** 闸门名，如「将影响的像元」 */
  readonly label: string;
  /** 闸门值，如「165 / 1,200 像元（13.8%）」 */
  readonly value: string;
}

export interface ConfirmCardBodyProps {
  /** 卡头标题 */
  readonly title: string;
  /** 卡头右上角的操作标记（如 raster.paint）；没有就不显示 */
  readonly opLabel?: string;
  /** 四道闸门 */
  readonly gates: readonly ConfirmGate[];
  /**
   * 表面变体：
   *   studio = 画布的制图台主题（跟随 canvas 的浅/暗）
   *   ink    = 官网的墨面深色段
   */
  readonly variant?: 'studio' | 'ink';
  /** 卡头右侧的动作位（画布放「取消」，官网留空） */
  readonly headerAction?: ReactNode;
  /** 卡体下半部分（画布放预演失败/影响面过大/执行结果/按钮组） */
  readonly children?: ReactNode;
  /**
   * 是否给四行闸门挂上「揭示态」。
   *
   * 官网开（滚动到才逐行盖章），画布关——画布里这张卡是**当场弹出来**的，
   * 挂上揭示态就等于让它永远隐形。
   */
  readonly reveal?: boolean;
  readonly className?: string;
}

/**
 * 像元闸门那一行的口径。
 *
 * 官网与画布必须**逐字一致**——官网写「165 / 1,200 像元（13.8%）」，
 * 画布算出来也必须是同一串字，不然官网就在说谎了。
 * 抽成函数，两边共用同一个格式化口径。
 */
export function formatPixelGate(
  affectedPixels: number,
  totalPixels: number,
  ratio: number,
): string {
  return `${affectedPixels.toLocaleString('zh-CN')} / ${totalPixels.toLocaleString('zh-CN')} 像元（${(ratio * 100).toFixed(1)}%）`;
}

export function ConfirmCardBody({
  title,
  opLabel,
  gates,
  variant = 'studio',
  headerAction,
  children,
  reveal = false,
  className = '',
}: ConfirmCardBodyProps) {
  const ink = variant === 'ink';

  return (
    <div
      className={
        ink
          ? `w-full rounded-panel border border-ink-line bg-ink-surface p-5 ${className}`
          : `w-[540px] max-w-full rounded-panel border border-studio-line bg-studio-2 p-5 shadow-[var(--studio-stage-shadow)] ${className}`
      }
    >
      <div className="flex items-center gap-2.5">
        <strong
          className={`font-display text-[15px] font-semibold ${ink ? 'text-paper' : 'text-studio-ink'}`}
        >
          {title}
        </strong>
        {opLabel ? (
          <span
            className={
              ink
                ? 'rounded border border-ink-line bg-ink-raised px-1.5 py-0.5 font-mono text-[11px] text-paper/85'
                : 'rounded border border-studio-line bg-studio-3/70 px-1.5 py-0.5 font-mono text-[11px] text-studio-ink-2'
            }
          >
            {opLabel}
          </span>
        ) : null}
        <span className="flex-1" />
        {headerAction}
      </div>

      <ol className="mt-4 flex flex-col gap-2">
        {gates.map((gate, index) => (
          <li
            key={gate.label}
            data-confirm-row={index + 1}
            className={
              ink
                ? `flex items-start gap-3 rounded-lg border border-ink-line bg-ink-surface px-3.5 py-3${reveal ? ' reveal' : ''}`
                : 'flex items-start gap-2.5 rounded-lg border border-studio-line bg-studio/45 px-3 py-2'
            }
          >
            <span
              className={
                ink
                  ? 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-lit/18 font-mono text-[10.5px] text-accent-lit'
                  : 'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/20 font-mono text-[10px] text-accent'
              }
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div
                className={
                  ink
                    ? 'text-[11.5px] text-paper/85'
                    : 'text-[11px] text-studio-ink-3'
                }
              >
                {gate.label}
              </div>
              <div
                className={
                  ink
                    ? 'mt-1 font-mono text-[13px] break-all text-paper tnum'
                    : 'mt-0.5 font-mono text-[12.5px] break-all text-studio-ink'
                }
              >
                {gate.value}
              </div>
            </div>
          </li>
        ))}
      </ol>

      {children}
    </div>
  );
}
