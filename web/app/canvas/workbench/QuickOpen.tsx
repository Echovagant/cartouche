'use client';

/**
 * 快速打开（Ctrl+P）：VS Code 的命令面板位。
 *
 * 搜两样东西，一起排：
 *   - 最近打开的项目（存在浏览器本地的那份）；
 *   - 当前项目的文件（引擎的工作区根一层；没有打开项目时只搜项目）。
 *
 * 选中项目 → 打开（没清单就当场新建）；选中文件 → 当图层加载。
 * 纯键盘：↑↓ 选，Enter 确认，Esc 关。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderSimpleIcon, MagnifyingGlassIcon, StackIcon } from '@phosphor-icons/react';
import type { ProjectSummary } from '../types';

export interface QuickOpenProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly recent: readonly ProjectSummary[];
  /** 当前项目的文件（相对路径；空串 = 没打开项目） */
  readonly files: readonly string[];
  readonly onOpenProject: (project: ProjectSummary) => void;
  readonly onOpenFile: (relativePath: string) => void;
}

/** 极简模糊匹配：子序列命中即算，按命中位置打分（越靠前越高分） */
function fuzzyScore(text: string, query: string): number | null {
  if (query === '') return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let score = 0;
  let idx = 0;
  for (const ch of q) {
    const hit = t.indexOf(ch, idx);
    if (hit < 0) return null;
    score += hit === idx ? 0 : 1; // 连续命中加分
    idx = hit + 1;
  }
  return score;
}

type Entry =
  | { readonly kind: 'project'; readonly project: ProjectSummary }
  | { readonly kind: 'file'; readonly path: string };

export function QuickOpen({
  open,
  onClose,
  recent,
  files,
  onOpenProject,
  onOpenFile,
}: QuickOpenProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    // 面板挂上就把焦点交给输入框 —— Ctrl+P 的手感从这一刻开始
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [
      ...recent.map((project): Entry => ({ kind: 'project', project })),
      ...files
        .filter((f) => !f.split('/').some((seg) => seg.startsWith('.')))
        .map((path): Entry => ({ kind: 'file', path })),
    ];
    if (query.trim() === '') return list.slice(0, 20);
    return list
      .map((entry) => {
        const text = entry.kind === 'project' ? entry.project.name : entry.path;
        const score = fuzzyScore(text, query.trim());
        return score === null ? null : { entry, score, text };
      })
      .filter((v): v is { entry: Entry; score: number; text: string } => v !== null)
      .sort((a, b) => a.score - b.score || a.text.localeCompare(b.text, 'zh-CN'))
      .slice(0, 20)
      .map((v) => v.entry);
  }, [recent, files, query]);

  useEffect(() => {
    setActive((prev) => Math.min(prev, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  if (!open) return null;

  const confirm = (entry: Entry): void => {
    onClose();
    if (entry.kind === 'project') onOpenProject(entry.project);
    else onOpenFile(entry.path);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((prev) => Math.min(prev + 1, entries.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const entry = entries[active];
      if (entry) confirm(entry);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="快速打开"
      className="fixed inset-x-0 top-[8vh] z-[60] mx-auto w-full max-w-[560px] px-4"
      onKeyDown={onKeyDown}
    >
      <div className="border border-studio-line bg-studio-2 shadow-[var(--studio-panel-shadow)]">
        <div className="relative">
          <MagnifyingGlassIcon
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-studio-ink-3"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜项目或文件名（↑↓ 选择，Enter 打开，Esc 关闭）"
            aria-label="快速打开搜索"
            className="h-11 w-full border-b border-studio-line bg-transparent px-9 text-[13px] text-studio-ink placeholder:text-studio-ink-3 focus:outline-none"
          />
        </div>
        <ul ref={listRef} className="max-h-[46vh] overflow-y-auto py-1" role="listbox">
          {entries.length === 0 ? (
            <li className="px-4 py-3 text-[12.5px] text-studio-ink-3">
              {files.length === 0 && recent.length === 0
                ? '还没有可打开的项目 —— 先在侧栏选一个文件夹。'
                : '没有匹配项。'}
            </li>
          ) : (
            entries.map((entry, index) => {
              const selected = index === active;
              const isProject = entry.kind === 'project';
              return (
                <li key={isProject ? entry.project.path ?? entry.project.handle ?? entry.project.name : entry.path} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(index)}
                    onClick={() => confirm(entry)}
                    className={`flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors ${
                      selected ? 'bg-studio-3 text-studio-ink' : 'text-studio-ink-2 hover:bg-studio-3/60'
                    }`}
                  >
                    {isProject ? (
                      <FolderSimpleIcon size={14} aria-hidden="true" className="shrink-0 text-studio-ink-3" />
                    ) : (
                      <StackIcon size={14} aria-hidden="true" className="shrink-0 text-studio-ink-3" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">
                      {isProject ? entry.project.name : entry.path.split('/').pop()}
                    </span>
                    <span className="shrink-0 font-mono text-[10.5px] text-studio-ink-3">
                      {isProject ? '项目' : entry.path}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
