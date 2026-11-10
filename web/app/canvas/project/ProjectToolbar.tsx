'use client';

/**
 * 最近项目那一栏的工具条：搜索 + 排序。
 *
 * 搜索框有真实的 `<label>`（sr-only）：占位文字不是标签，
 * 读屏软件念出来用户不知道这是干什么的。
 *
 * 排序做成小分段按钮而不是下拉框：三个选项一眼看全，
 * 换排序不需要多开一层菜单。
 */
import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { TextField } from '../ui';
import type { ProjectSort } from './project-utils';

const SORTS: readonly { readonly value: ProjectSort; readonly label: string }[] = [
  { value: 'recent', label: '最近打开' },
  { value: 'name', label: '名称' },
  { value: 'layers', label: '图层数' },
];

export interface ProjectToolbarProps {
  readonly query: string;
  readonly onQueryChange: (value: string) => void;
  readonly sort: ProjectSort;
  readonly onSortChange: (value: ProjectSort) => void;
}

export function ProjectToolbar({
  query,
  onQueryChange,
  sort,
  onSortChange,
}: ProjectToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <MagnifyingGlassIcon
          size={13}
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
        />
        <label htmlFor="project-search" className="sr-only">
          按项目名或路径搜索
        </label>
        <TextField
          id="project-search"
          type="search"
          tone="paper"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索项目"
          /*
            焦点环：TextField 自带 `focus:outline-none`，它把
            `--tw-outline-style` 设成了 none —— 全局的 :focus-visible 焦点环
            因此在键盘聚焦时是看不见的（鼠标点击时无所谓，那是刻意的）。
            这里把样式显式扳回 solid（!important，不靠工具类的先后顺序）。
          */
          className="h-10 w-[188px] pl-8 text-[12.5px] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 focus-visible:[--tw-outline-style:solid]!"
        />
      </div>

      <div
        role="group"
        aria-label="排序方式"
        className="flex border border-line bg-surface"
      >
        {SORTS.map((option, index) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={sort === option.value}
            onClick={() => onSortChange(option.value)}
            className={`h-10 px-3 text-[12px] transition-colors ${
              index > 0 ? 'border-l border-line' : ''
            } ${
              // 选中态：墨色/纸色互翻，不用墨绿（墨绿留给主 CTA 与焦点环）
              sort === option.value
                ? 'bg-ink text-paper'
                : 'text-ink-3 hover:bg-paper-deep hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
