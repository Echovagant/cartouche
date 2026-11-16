'use client';

/**
 * 打开项目时的加载态（画布区遮罩）。
 *
 * 为什么需要：大文件转换可能要几十秒（187MB 源实测全量转换 60s，
 * 视口裁剪也有 29s 的量级）。没有这层反馈，界面就是"卡住了"，
 * 用户会以为程序死了然后反复点。
 *
 * 两条原则：
 *   1. **信息与动效分开**：文字（正在加载哪个图层）永远在，
 *      动效（呼吸光带、进度条扫光）可以被设置关掉 —— 与项目既有原则一致
 *      （「动效只负责表达状态变化，不承载任何信息」）。
 *   2. **不抢戏**：这是项目级遮罩，不是启动屏那种全屏 cinematic；
 *      视觉上与启动屏同一族（暖黑 + 墨绿 + 等宽字），但克制。
 */
import { useEffect, useRef } from 'react';

export interface ProjectLoadingProps {
  /** 正在加载第几个（从 1 起）；0 = 正在准备 */
  readonly done: number;
  /** 一共要加载几个 */
  readonly total: number;
  /** 当前图层名（显示出来，用户知道卡在哪个文件上） */
  readonly current?: string | null;
  /** 动效是否开启（设置里的「加载动画」= 从不播放时关掉） */
  readonly animated: boolean;
}

export function ProjectLoading({ done, total, current, animated }: ProjectLoadingProps) {
  const pulseRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!animated) return;
    const el = pulseRef.current;
    if (!el) return;
    // 呼吸光带：纯 CSS 动画，动画关掉时干脆不挂（连元素都不渲染）
    el.style.animation = 'boot-pulse 1.6s cubic-bezier(.4,0,.2,1) infinite';
    return () => {
      el.style.animation = '';
    };
  }, [animated]);

  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  // 文案：正在读第 N 个图层时要说清是第几个（done 是**已完成**数，所以显示 done+1）；
  // 百分比仍是真实完成度（done/total），不为了好看虚报。
  const label = current
    ? `加载图层 ${Math.min(total, done + 1)}/${total}`
    : done > 0
      ? `加载图层 ${done}/${total}`
      : '准备中';

  return (
    <div
      className="project-loading pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-studio/72 backdrop-blur-[1px]"
      role="status"
      aria-live="polite"
      data-testid="project-loading"
    >
      {/* 底衬：加载发生在**任意底图**上（深色影像、浅色纸面），
          没有底衬的话文字会跟底图糊在一起 —— 用户看到的只是"灰了一块"。 */}
      <div className="flex w-[300px] flex-col gap-3 rounded-panel border border-studio-line bg-studio-2/95 px-4 py-3.5 shadow-[var(--studio-panel-shadow)]">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[11px] tracking-[0.3em] text-studio-ink-2">{label}</span>
          <span className="tnum font-mono text-[11px] text-studio-ink-2">{percent}%</span>
        </div>

        {/* 进度条：底槽 + 填充（填充宽度是真实进度，不是假动画） */}
        <div className="h-[2px] w-full overflow-hidden bg-studio-line">
          <div
            className="h-full bg-accent transition-[width] duration-500 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>

        <div className="flex items-center gap-2">
          {animated ? (
            <div
              ref={pulseRef}
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-studio-ink-2">
            {current ? `正在读取 ${current}` : '正在读取图层数据'}
          </span>
        </div>
      </div>
    </div>
  );
}
