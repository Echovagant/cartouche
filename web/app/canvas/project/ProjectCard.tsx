'use client';

/**
 * 一枚图签。
 *
 * 形状不是通用 SaaS 卡片，是**地图上那个图签框**：
 * 细边框 + 双线内框（与出图时那张图面的图框同源）、
 * 下方一条题注栏放位置与时间戳、右上角一个图号。
 *
 * 色阶用 studio（跟主题走）：工作台整体是一个界面了，
 * 图签不再有自己单独的「纸面」——那是旧版全屏选择页的做法。
 *
 * 交互只有一件事：打开。位置、时间、图层数都是只读的——
 * 次级信息做成可点的，手一滑就点错了。
 */
import { MapTrifoldIcon } from '@phosphor-icons/react';
import type { ProjectSummary } from '../types';
import { formatStamp, projectKey, sheetNumber } from './project-utils';
import { useReduceMotionDecision } from './useReducedMotion';

/** 最近项目的一张卡片：图号、名称、更新时间、入口。整卡可点。 */
export interface ProjectCardProps {
  readonly project: ProjectSummary;
  readonly disabled?: boolean;
  readonly onOpen: (project: ProjectSummary) => void;
}

export function ProjectCard({ project, disabled = false, onOpen }: ProjectCardProps) {
  // 三态：pending（还没问引擎）也按"要减弱"处理 —— 宁可少一次位移反馈，
  // 也不给动效敏感的用户闪一下。
  const motion = useReduceMotionDecision();
  const reduced = motion !== 'off';
  const number = sheetNumber(projectKey(project), project.updatedAt);
  const stamp = formatStamp(project.updatedAt);

  return (
    <li className="h-full">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onOpen(project)}
        className={`group relative flex h-full w-full flex-col border border-studio-line bg-studio-3 p-3 text-left transition-[translate,scale,border-color] duration-150 ease-out hover:border-studio-ink-3 disabled:pointer-events-none disabled:opacity-50 ${
          // 位移类反馈在「减少动态效果」下整个撤掉：
          // 只留边框变色（那是可用性反馈，不是装饰）。
          reduced ? '' : 'hover:-translate-y-0.5 active:scale-[0.98]'
        }`}
      >
        {/* 内框：图面的图框是双线（外粗内细），这里也双线 */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-[4px] border border-studio-line/70"
        />

        <span className="relative flex flex-1 flex-col">
          <span className="flex items-start justify-between gap-2">
            <span className="font-mono text-[11px] leading-none tracking-[0.14em] text-studio-ink-3">
              {number}
            </span>
            <MapTrifoldIcon
              size={13}
              aria-hidden="true"
              className="shrink-0 text-studio-ink-3 transition-colors duration-150 group-hover:text-studio-ink-2"
            />
          </span>

          <span className="mt-3 block text-[14px] font-semibold leading-snug text-studio-ink">
            {project.name}
          </span>

          {/* 题注栏：位置与时间戳。
              这里显示的是**相对位置**，不是绝对路径 ——
              绝对路径里有用户的盘符与用户名，摆在界面上就等于
              把用户身份和机器布局一起晒出去（截图、录屏都会带上）。 */}
          <span className="mt-auto block border-t border-studio-line pt-2">
            <span
              className="block truncate font-mono text-[11px] leading-[1.45] text-studio-ink-3"
              title={project.location ?? project.name}
            >
              {project.location ?? project.name}
            </span>
            <span className="mt-1 flex items-baseline justify-between gap-2 font-mono text-[11px] text-studio-ink-3">
              <span className="tnum">{project.layerCount} 图层</span>
              <span className="tnum">{stamp}</span>
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}
