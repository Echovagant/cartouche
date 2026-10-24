'use client';

/**
 * 项目列表（打开前的选择界面）。
 *
 * 调性刻意与画布相反：画布是暗色的"制图台"，这里是**纸面**——
 * 打开项目之前用户面对的是一张白纸（选一个文件夹开始），
 * 进了工作区才落到暗色台面上。两者用不同的色阶（paper / studio），
 * 免得用户以为"打开项目"和"画图"是同一屏里的两个面板。
 *
 * 动效沿用 CanvasMotion 的规矩：显式 ref、不写选择器、只动 transform/opacity、
 * 尊重 prefers-reduced-motion。
 */
import { useRef, useState } from 'react';
import { FolderOpenIcon, MapTrifoldIcon } from '@phosphor-icons/react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ActionButton, EmptyHint, TextField } from './ui';
import type { ProjectSummary } from './types';

gsap.registerPlugin(useGSAP);

export interface ProjectPickerProps {
  /** 最近打开过的项目（存在浏览器本地） */
  recent: readonly ProjectSummary[];
  /** 点某个最近的项目 */
  onOpenExisting: (path: string) => void;
  /** 用一个文件夹路径新建项目 */
  onCreateFromFolder: (path: string) => void;
  /** 出错时的提示（引擎不可达、路径不存在、清单损坏……） */
  error?: string | null;
  /**
   * 引擎连不上（画布要连本机 127.0.0.1:8787）。
   *
   * 连不上时要说清「这是本机工具、引擎没开」，
   * 而不是让人对着「无法连接引擎服务」自己猜。
   */
  engineOffline?: boolean;
  /** 正在请求中：按钮置灰，避免重复点 */
  busy?: boolean;
}

/** 「上次打开」的时间：清单里存的是 ISO 字符串，这里翻成能读的样子 */
function formatTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ProjectPicker({
  recent,
  onOpenExisting,
  onCreateFromFolder,
  error = null,
  engineOffline = false,
  busy = false,
}: ProjectPickerProps) {
  const [manual, setManual] = useState('');
  const cardRef = useRef<HTMLDivElement | null>(null);

  useGSAP(
    () => {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) return;
      const card = cardRef.current;
      if (!card) return;
      gsap.from(card, { y: 14, autoAlpha: 0, duration: 0.6, ease: 'power3.out' });
    },
    { dependencies: [] },
  );

  const trimmed = manual.trim();

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-paper p-6 text-ink">
      <div ref={cardRef} className="w-full max-w-[560px]">
        <h1 className="font-display text-[26px] font-semibold tracking-tight text-ink">打开一个项目</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
          一个项目 = 一次交差任务。把你放图件的文件夹登记进来，工具会在旁边建
          <code className="rounded bg-paper-deep px-1 font-mono">.cartouche</code>
          存清单、产出物与留痕；<strong className="text-ink">源数据不用搬家</strong>。
        </p>

        {/*
          这一屏是陌生人打开官网画布页时**第一眼**看到的东西，而画布要连
          本机引擎（127.0.0.1:8787）。不写清楚的话，他一点「打开」就得到
          一句「无法连接引擎服务」—— 那是一条死路，而这里本该一眼说清。
          只在引擎连不上时才出现（engineOffline），连得上就不打扰他。

          这里**不写怎么启动引擎**：那是 GitHub 仓库页该讲的（README 的
          「快速开始」里有），官网只负责说清一件事——这是个本机预览，
          要先把工具拿下来。
        */}
        {engineOffline ? (
          <div className="mt-5 rounded-lg border border-warn/35 bg-warn-soft px-3.5 py-3 text-[12.5px] leading-relaxed text-warn">
            <strong className="font-medium">这是本机的在线预览</strong>
            <div className="mt-1">画布要下载（图签 Cartouche）后使用。</div>
          </div>
        ) : null}

        {error ? (
          <div className="mt-5 rounded-lg border border-warn/35 bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-warn">
            {error}
          </div>
        ) : null}

        {recent.length === 0 ? (
          <div className="mt-6">
            <EmptyHint tone="paper">
              还没有打开过的项目。在下面填一个文件夹路径开始。
            </EmptyHint>
          </div>
        ) : (
          <ul className="mt-6 flex flex-col gap-2">
            {recent.map((p) => (
              <li key={p.path}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onOpenExisting(p.path)}
                  className="flex w-full items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent disabled:pointer-events-none disabled:opacity-50"
                >
                  <MapTrifoldIcon size={17} className="shrink-0 text-accent" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] text-ink">{p.name}</span>
                    <span className="block truncate font-mono text-[11.5px] text-ink-3">{p.path}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[11.5px] text-ink-3">
                    {p.layerCount} 图层
                    {formatTime(p.updatedAt) ? ` · ${formatTime(p.updatedAt)}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-8 border-t border-line pt-6">
          <label className="block text-[12.5px] text-ink-3" htmlFor="new-project-path">
            新项目：填一个图件所在的文件夹
          </label>
          <div className="mt-2 flex gap-2">
            <TextField
              id="new-project-path"
              tone="paper"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="D:\任务\2026改图"
              className="min-w-0 flex-1 font-mono"
            />
            <ActionButton
              variant="primary"
              disabled={!trimmed || busy}
              onClick={() => trimmed && onCreateFromFolder(trimmed)}
            >
              <FolderOpenIcon size={15} weight="bold" />
              登记并新建
            </ActionButton>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
            这个文件夹必须已经存在。工具不会搬动里面的任何东西，只在旁边建一个
            <code className="rounded bg-paper-deep px-1 font-mono">.cartouche</code>
            目录记录进度。
          </p>
        </div>
      </div>
    </div>
  );
}
