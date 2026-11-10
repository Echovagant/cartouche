'use client';

/**
 * 已登记的工作区。
 *
 * 「工作区」是长期概念：项目在它下面，引擎只在登记过的目录里动手。
 * 登记错了要能撤销 —— 撤销是真的调引擎的 DELETE，撤完这条从列表里消失。
 *
 * ⚠️ **这里不显示绝对路径**。
 * 绝对路径里带着用户的盘符与用户名，一旦出现在界面上，
 * 就会跟着截图、录屏、发给同事的消息一起出去。所以只显示：
 *   - 工作区的**名字**（文件夹名）
 *   - 它相对默认根的**位置**（`演示项目` 这样，不含盘符与用户名）
 * 需要看完整路径时，用户自己去资源管理器里看 —— 那是他的机器，他熟。
 *
 * 动效：撤掉一行时那行先淡出，剩下的行再滑到新位置（FLIP）。
 * 只动 transform / opacity；撤完列表立刻更新（父组件那边改状态）。
 */
import { useLayoutEffect, useRef } from 'react';
import { FolderSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import gsap from 'gsap';
import type { WorkspaceRoot } from '../types';
import { prefersReducedMotion } from './useReducedMotion';

export interface WorkspaceListProps {
  readonly roots: readonly WorkspaceRoot[];
  readonly loading: boolean;
  readonly error: string | null;
  /** 撤销某个工作区（凭它的 id —— 前端不知道绝对路径） */
  readonly onUnregister: (id: string) => void;
}

export function WorkspaceList({
  roots,
  loading,
  error,
  onUnregister,
}: WorkspaceListProps) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  /** 上一帧每行的位置（FLIP 用） */
  const prevTops = useRef(new Map<string, number>());

  // 撤掉一行之后，剩下的行滑到新位置
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const items = Array.from(list.querySelectorAll<HTMLElement>('[data-root-id]'));
    const next = new Map<string, number>();
    for (const item of items) {
      const id = item.dataset.rootId ?? '';
      next.set(id, item.getBoundingClientRect().top);
    }
    if (!prefersReducedMotion()) {
      for (const item of items) {
        const id = item.dataset.rootId ?? '';
        const before = prevTops.current.get(id);
        const after = next.get(id);
        if (before === undefined || after === undefined) continue;
        const dy = before - after;
        if (Math.abs(dy) < 0.5) continue;
        gsap.fromTo(
          item,
          { y: dy },
          { y: 0, duration: 0.28, ease: 'power2.out', clearProps: 'transform' },
        );
      }
    }
    prevTops.current = next;
  }, [roots]);

  const handleUnregister = (root: WorkspaceRoot): void => {
    const row = rows.current.get(root.id);
    if (!row || prefersReducedMotion()) {
      onUnregister(root.id);
      return;
    }
    // 先淡出这一行，撤完了再从列表里去掉
    gsap.to(row, {
      autoAlpha: 0,
      y: -6,
      duration: 0.2,
      ease: 'power2.out',
      onComplete: () => onUnregister(root.id),
    });
  };

  if (loading) {
    return <p className="mt-3 text-[12px] text-ink-3">正在读已登记的工作区……</p>;
  }

  const list =
    roots.length === 0 ? (
      <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
        还没有登记过工作区。上面选一个文件夹，它就会登记进来。
      </p>
    ) : (
      <ul ref={listRef} className="mt-3 flex flex-col gap-1.5">
        {roots.map((root) => (
          <li
            key={root.id}
            data-root-id={root.id}
            ref={(element) => {
              if (element) rows.current.set(root.id, element);
              else rows.current.delete(root.id);
            }}
            className="flex items-center gap-3 border border-line bg-surface px-3 py-2"
          >
            <FolderSimpleIcon size={15} className="shrink-0 text-ink-3" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] text-ink">{root.label}</span>
              {/* 位置是相对默认根的（`演示项目`），不是绝对路径 */}
              {root.location ? (
                <span className="block truncate font-mono text-[11px] text-ink-3">
                  {root.location}
                </span>
              ) : null}
            </span>
            {root.builtin ? (
              <span
                className="shrink-0 font-mono text-[11px] text-ink-3"
                title="默认工作区不能撤销：所有相对路径都落在它下面。"
              >
                默认
              </span>
            ) : (
              <button
                type="button"
                onClick={() => handleUnregister(root)}
                aria-label={`撤销 ${root.label} 的登记`}
                title="撤销登记（引擎将不再读写这个目录）"
                className="flex h-11 w-11 shrink-0 items-center justify-center border border-transparent text-ink-3 transition-colors hover:border-warn/40 hover:text-warn"
              >
                <TrashIcon size={15} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
    );

  return (
    <>
      {list}
      {error ? <p className="mt-2 text-[11.5px] leading-relaxed text-warn">{error}</p> : null}
    </>
  );
}
