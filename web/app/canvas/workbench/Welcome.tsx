'use client';

/**
 * 没打开项目时**编辑区**里的欢迎页。
 *
 * VS Code 的欢迎页逻辑：不挡路、给方向 —— 主行动（选一个文件夹）只有
 * 一个按钮，剩下的信息（最近项目）顺手摆在下面。
 *
 * 这里**没有**「已登记的工作区」：引擎的目录边界是引擎自己的事，
 * 用户只做两件事——选一个文件夹、开始干活。
 */
import { ArrowRightIcon, FolderOpenIcon } from '@phosphor-icons/react';
import { ActionButton, EmptyHint, TextField } from '../ui';
import { ProjectCard } from '../project/ProjectCard';
import type { ProjectSummary } from '../types';

export interface WelcomeProps {
  readonly recent: readonly ProjectSummary[];
  readonly engineOffline: boolean;
  readonly busy: boolean;
  readonly onPickFolder: () => void;
  readonly onOpenProject: (project: ProjectSummary) => void;
  readonly onCreateFromPath: (path: string) => void;
}

export function Welcome({
  recent,
  engineOffline,
  busy,
  onPickFolder,
  onOpenProject,
  onCreateFromPath,
}: WelcomeProps) {
  return (
    <div className="mx-auto flex h-full w-full max-w-[880px] flex-col justify-center overflow-y-auto px-6 py-10">
      <p className="font-mono text-[11.5px] tracking-[0.22em] text-studio-ink-3">
        CARTOUCHE · 地图出图工作台
      </p>
      <h1 className="mt-3 font-display text-[34px] font-semibold leading-tight tracking-tight text-studio-ink">
        选一个文件夹，开始改图
      </h1>
      <p className="mt-3 max-w-[62ch] text-[13.5px] leading-relaxed text-studio-ink-2">
        图件留在你自己的文件夹里，工具在旁边建
        <code className="mx-1 rounded bg-studio-3 px-1 font-mono text-[12.5px]">.cartouche</code>
        记进度与产出。改了什么、动了多少、备份在哪，都会先说清楚再动手。
      </p>

      {/* 主行动：选文件夹。引擎会弹系统原生的选择框，选完直接进工作台 */}
      <div className="mt-7 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onPickFolder}
          disabled={busy}
          className="flex h-11 items-center gap-2 border border-studio-ink bg-studio-3 px-5 text-[13.5px] font-medium text-studio-ink transition-colors hover:bg-studio-raised disabled:pointer-events-none disabled:opacity-45"
        >
          <FolderOpenIcon size={16} weight="bold" aria-hidden="true" />
          选一个文件夹打开
        </button>

        {engineOffline ? (
          <span className="text-[12.5px] leading-relaxed text-warn">
            引擎没连上 —— 这是装在本机之后才能用的功能，先看官网「下载」。
          </span>
        ) : null}
      </div>

      {/* 手动填路径：退路（远程机器、图形对话框不可用） */}
      <ManualCreate busy={busy} onCreateFromPath={onCreateFromPath} />

      {/* 最近项目 */}
      <section aria-labelledby="welcome-recent" className="mt-10">
        <div className="flex items-baseline justify-between border-b border-studio-line pb-2">
          <h2
            id="welcome-recent"
            className="font-mono text-[11px] font-medium tracking-[0.12em] text-studio-ink-3"
          >
            最近打开
          </h2>
          <span className="tnum font-mono text-[11px] text-studio-ink-3">{recent.length}</span>
        </div>
        {recent.length === 0 ? (
          <div className="mt-4">
            <EmptyHint tone="studio">
              <p className="text-[12.5px] leading-relaxed text-studio-ink-3">
                打开过的项目会在这里排成一排图签；源文件不动，进度跟着文件夹走。
              </p>
            </EmptyHint>
          </div>
        ) : (
          <ul className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-3">
            {recent.slice(0, 8).map((project) => (
              <ProjectCard
                key={project.path ?? project.handle ?? project.name}
                project={project}
                disabled={busy}
                onOpen={onOpenProject}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** 手填路径：折叠起来，不跟主行动抢 */
function ManualCreate({
  busy,
  onCreateFromPath,
}: {
  busy: boolean;
  onCreateFromPath: (path: string) => void;
}) {
  // 不引入状态到 Welcome 顶层：这个折叠块自己管自己的输入
  return (
    <details className="mt-4 max-w-[520px] border-t border-studio-line pt-3">
      <summary className="cursor-pointer list-none text-[12px] text-studio-ink-3 transition-colors hover:text-studio-ink-2">
        或者手动粘贴文件夹路径
      </summary>
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const input = event.currentTarget.elements.namedItem('welcome-path');
          if (!(input instanceof HTMLInputElement)) return;
          const value = input.value.trim();
          if (!value || busy) return;
          onCreateFromPath(value);
        }}
      >
        <label htmlFor="welcome-path" className="sr-only">
          图件所在的文件夹
        </label>
        <TextField
          id="welcome-path"
          value={undefined}
          onChange={undefined}
          name="welcome-path"
          placeholder="直接粘贴文件夹路径"
          className="h-10 w-full font-mono focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 focus-visible:[--tw-outline-style:solid]!"
        />
        <ActionButton
          variant="primary"
          type="submit"
          disabled={busy}
          className="h-10 shrink-0 px-4"
        >
          打开
          <ArrowRightIcon size={14} weight="bold" aria-hidden="true" />
        </ActionButton>
      </form>
    </details>
  );
}
