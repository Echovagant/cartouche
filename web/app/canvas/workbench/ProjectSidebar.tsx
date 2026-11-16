'use client';

/**
 * 侧栏的「项目」视图：打开 / 新建 / 最近项目。
 *
 * 与旧版全屏选择页的差别：这是工作台侧栏里的一栏（260px 宽），
 * 不再是独立的一屏 —— 你随时可以回到这一栏换项目，工作台壳子不动。
 *
 * **没有**「已登记的工作区」这一节：选哪个文件夹是用户自己的事，
 * 引擎在后台管好边界就行，界面不把内部机制当概念讲。
 */
import { FolderOpenIcon } from '@phosphor-icons/react';
import { ActionButton, TextField } from '../ui';
import { ProjectCard } from '../project/ProjectCard';
import type { ProjectSummary } from '../types';

export interface ProjectSidebarProps {
  readonly recent: readonly ProjectSummary[];
  readonly busy: boolean;
  readonly error: string | null;
  readonly engineOffline: boolean;
  readonly onPickFolder: () => void;
  readonly onOpenProject: (project: ProjectSummary) => void;
  readonly onCreateFromPath: (path: string) => void;
}

export function ProjectSidebar({
  recent,
  busy,
  error,
  engineOffline,
  onPickFolder,
  onOpenProject,
  onCreateFromPath,
}: ProjectSidebarProps) {
  return (
    <div className="flex h-full flex-col overflow-y-auto p-3">
      <h2 className="font-mono text-[11px] font-medium tracking-[0.12em] text-studio-ink-3">
        项目
      </h2>

      {/* 主行动：弹系统文件夹选择框，选完自动「有清单就打开、没清单就新建」 */}
      <button
        type="button"
        onClick={onPickFolder}
        disabled={busy}
        className="mt-3 flex h-10 w-full items-center justify-center gap-2 border border-studio-ink bg-studio-3 px-4 text-[13px] font-medium text-studio-ink transition-colors hover:bg-studio-raised disabled:pointer-events-none disabled:opacity-45"
      >
        <FolderOpenIcon size={15} weight="bold" aria-hidden="true" />
        选一个文件夹
      </button>

      {/* 手填路径：退路（远程机器、图形对话框不可用） */}
      <details className="mt-3 border-t border-studio-line pt-2.5">
        <summary className="cursor-pointer list-none text-[12px] text-studio-ink-3 transition-colors hover:text-studio-ink-2">
          或手动粘贴路径
        </summary>
        <form
          className="mt-2.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const input = event.currentTarget.elements.namedItem('sidebar-path');
            if (!(input instanceof HTMLInputElement)) return;
            const value = input.value.trim();
            if (!value || busy) return;
            onCreateFromPath(value);
          }}
        >
          <label htmlFor="sidebar-path" className="sr-only">
            图件所在的文件夹
          </label>
          <TextField
            id="sidebar-path"
            name="sidebar-path"
            placeholder="直接粘贴文件夹路径"
            className="h-9 w-full font-mono focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 focus-visible:[--tw-outline-style:solid]!"
          />
          <ActionButton variant="primary" type="submit" disabled={busy} className="h-9 w-full">
            打开
          </ActionButton>
        </form>
      </details>

      {error ? (
        <p className="mt-3 rounded-lg border border-warn/35 bg-warn/10 px-3 py-2 text-[12px] leading-relaxed text-warn">
          {error}
        </p>
      ) : null}
      {engineOffline ? (
        <p className="mt-3 text-[12px] leading-relaxed text-studio-ink-3">
          引擎没连上 —— 本机工具要先启动引擎（便携包双击 START.cmd 即可）。
        </p>
      ) : null}

      <div className="mt-4 border-t border-studio-line pt-3">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[11px] tracking-[0.12em] text-studio-ink-3">
            最近打开
          </span>
          <span className="tnum font-mono text-[11px] text-studio-ink-3">{recent.length}</span>
        </div>
        {recent.length === 0 ? (
          <p className="mt-3 text-[12px] leading-relaxed text-studio-ink-3">
            还没有打开过的项目。上面选一个文件夹，它就会变成一枚图签。
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2.5">
            {recent.map((project) => (
              <ProjectCard
                key={project.path ?? project.handle ?? project.name}
                project={project}
                disabled={busy}
                onOpen={onOpenProject}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
