'use client';

/**
 * 工作台底部的**状态栏**：引擎连接、当前项目、图层与选中数。
 *
 * 布局语义照着 VS Code 来：一整条 26px 的窄条放"当下状态"，
 * 左边是引擎与项目，右边留给全局开关（主题）。
 * 出错时的红点也在这里 —— 状态栏是唯一永远可见的地方。
 */
import { ThemeToggle } from '../ThemeToggle';
import { StatusDot } from '../ui';

export interface StatusBarProps {
  readonly engineOffline: boolean;
  readonly engineError?: string | null;
  readonly projectName: string | null;
  readonly layerCount: number;
  readonly selectedCount: number;
}

/** 状态栏本体：引擎连接、当前项目、图层数与选中数都在这一条上；没有项目时显示「还没打开项目」。 */
export function StatusBar({
  engineOffline,
  engineError,
  projectName,
  layerCount,
  selectedCount,
}: StatusBarProps) {
  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-4 border-t border-studio-line bg-studio-2 px-3 font-mono text-[11px] text-studio-ink-3">
      <span
        className="flex items-center gap-1.5"
        title={engineOffline ? (engineError ?? '引擎没起来') : '引擎已连接，可以干活了'}
      >
        <StatusDot tone={engineOffline ? 'offline' : 'ready'} />
        {engineOffline ? '引擎离线' : '引擎在线'}
      </span>

      {projectName ? (
        <>
          <span className="h-3 w-px bg-studio-line" aria-hidden="true" />
          <span className="max-w-[240px] truncate text-studio-ink-2">{projectName}</span>
          <span className="tnum">{layerCount} 图层</span>
          {selectedCount > 0 ? (
            <span className="tnum text-accent">已选 {selectedCount} 个要素</span>
          ) : null}
        </>
      ) : (
        <span>还没打开项目</span>
      )}

      <span className="flex-1" />

      <span className="font-sans">图签 Cartouche</span>
      {/* 26px 的条装不下滑杆形态，用紧凑图标 */}
      <ThemeToggle variant="icon" />
    </footer>
  );
}
