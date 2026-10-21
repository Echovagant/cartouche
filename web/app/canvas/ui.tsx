'use client';

/**
 * 画布侧的共享界面原语。
 *
 * 为什么单独抽：图层面板、属性表、工具栏、报告抽屉是四个互不相识的组件，
 * 按钮/输入框/分区标题的样式各写一遍必然走样（这次重做前就是这么乱的：
 * 同一个按钮在四个文件里有四种圆角、四种边框色）。
 *
 * 配色是"制图室"：暗色台面 + 暖光文字，地图那块纸自己就是亮的。
 * 只放**表现**原语，不放业务逻辑。
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/** 分区标题：小字、等宽、带细分隔线——不是大标题，是"抽屉里的一栏" */
export function SectionLabel({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-studio-line pb-2">
      {/* 不用 uppercase：这一行常带文件名（sample.geojson），
          转成大写会让人以为真有个叫 SAMPLE.GEOJSON 的文件。 */}
      <h2 className="font-mono text-[11px] font-medium tracking-[0.12em] text-studio-ink-3">
        {children}
      </h2>
      {right}
    </div>
  );
}

type ButtonVariant = 'primary' | 'ghost' | 'quiet' | 'danger';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-paper border-accent hover:bg-accent-deep hover:border-accent-deep shadow-[0_2px_14px_-4px_rgba(47,111,94,0.8)]',
  ghost: 'bg-studio-3/70 text-studio-ink border-studio-line hover:border-studio-ink-3 hover:bg-studio-3',
  quiet: 'bg-transparent text-studio-ink-2 border-transparent hover:bg-studio-3 hover:text-studio-ink',
  danger: 'bg-transparent text-warn border-studio-line hover:border-warn/45 hover:bg-warn/12',
};

export function ActionButton({
  variant = 'ghost',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-all duration-200 active:translate-y-px disabled:pointer-events-none disabled:opacity-40 ${BUTTON_VARIANT[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function TextField({
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={`rounded-lg border border-studio-line bg-studio/70 px-2.5 py-1.5 text-[12.5px] text-studio-ink transition-colors placeholder:text-studio-ink-3 focus:border-accent focus:outline-none ${className}`}
    />
  );
}

/** 状态点：带呼吸动画，一眼看出引擎在不在 */
export function StatusDot({ tone }: { tone: 'ready' | 'checking' | 'offline' }) {
  const color = tone === 'ready' ? 'bg-accent' : tone === 'checking' ? 'bg-studio-ink-3' : 'bg-warn';
  return (
    <span className="relative inline-flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
      {tone === 'ready' ? (
        <span
          className={`absolute inline-flex h-full w-full rounded-full ${color} opacity-60`}
          style={{ animation: 'breathe 3.2s ease-in-out infinite' }}
        />
      ) : null}
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${color}`} />
    </span>
  );
}

/** 空状态：不是一句"暂无数据"，而是告诉用户下一步做什么 */
export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-studio-line bg-studio/45 px-4 py-5 text-[12.5px] leading-relaxed text-studio-ink-3">
      {children}
    </div>
  );
}
