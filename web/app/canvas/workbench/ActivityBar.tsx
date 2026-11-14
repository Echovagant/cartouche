'use client';

/**
 * 工作台左侧的**活动栏**（activity bar）：一竖条图标按钮，切侧栏的视图。
 *
 * 布局语义照着 VS Code 来：最左一条窄栏是「你在哪个功能区」的总开关，
 * 每个图标对应侧栏里的一块内容。图标下缘亮条表示当前视图。
 *
 * 「一句话改图」不放侧栏：AI 工作台是独立页面（状态不共享），这里只负责跳过去。
 */
import {
  FolderSimpleIcon,
  PrinterIcon,
  SparkleIcon,
  StackIcon,
} from '@phosphor-icons/react';
import { ThemeToggle } from '../ThemeToggle';

export type WorkbenchView = 'project' | 'layers' | 'layout';

export interface ActivityBarProps {
  readonly activeView: WorkbenchView;
  readonly onViewChange: (view: WorkbenchView) => void;
  /** 没打开项目时，图层与出图两个视图没有内容可看 */
  readonly projectOpen: boolean;
  /** 跳到 AI 工作台（整页跳转，见 CanvasWorkbench 的 openAiWorkbench） */
  readonly onOpenAi: () => void;
  /** AI 入口当前能不能用（没打开项目时带上下文才有意义） */
  readonly aiEnabled: boolean;
  readonly aiBlockedReason: string;
}

const VIEWS: readonly {
  readonly id: WorkbenchView;
  readonly label: string;
  readonly icon: typeof FolderSimpleIcon;
}[] = [
  { id: 'project', label: '项目', icon: FolderSimpleIcon },
  { id: 'layers', label: '图层', icon: StackIcon },
  { id: 'layout', label: '出图', icon: PrinterIcon },
];

export function ActivityBar({
  activeView,
  onViewChange,
  projectOpen,
  onOpenAi,
  aiEnabled,
  aiBlockedReason,
}: ActivityBarProps) {
  return (
    <nav
      aria-label="工作台功能区"
      className="flex w-12 shrink-0 flex-col items-center border-r border-studio-line bg-studio-2/80 py-2"
    >
      {VIEWS.map(({ id, label, icon: Icon }) => {
        // 没打开项目时，图层/出图点过去只会看到空状态——点项目视图更直接
        const disabled = id !== 'project' && !projectOpen;
        const active = activeView === id;
        return (
          <button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => onViewChange(id)}
            title={disabled ? '先打开一个项目' : label}
            aria-label={label}
            aria-pressed={active}
            className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
              disabled
                ? 'pointer-events-none opacity-35'
                : active
                  ? 'bg-studio-3 text-studio-ink'
                  : 'text-studio-ink-3 hover:bg-studio-3/60 hover:text-studio-ink-2'
            }`}
          >
            {/* 当前视图的亮条：贴左缘的一条短线 */}
            {active ? (
              <span
                aria-hidden="true"
                className="absolute -left-2 h-5 w-0.5 rounded-full bg-accent"
              />
            ) : null}
            <Icon size={19} weight={active ? 'fill' : 'regular'} aria-hidden="true" />
          </button>
        );
      })}

      <span className="flex-1" />

      <button
        type="button"
        onClick={onOpenAi}
        disabled={!aiEnabled}
        title={aiEnabled ? '一句话改图（AI 工作台）' : aiBlockedReason}
        aria-label="一句话改图（AI 工作台）"
        className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
          aiEnabled
            ? 'text-studio-ink-3 hover:bg-studio-3/60 hover:text-studio-ink'
            : 'pointer-events-none opacity-35'
        }`}
      >
        <SparkleIcon size={19} aria-hidden="true" />
      </button>

      <span className="mb-1.5 mt-1 h-px w-6 bg-studio-line" aria-hidden="true" />
      <ThemeToggle variant="icon" />
    </nav>
  );
}
