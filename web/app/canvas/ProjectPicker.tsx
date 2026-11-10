'use client';

/**
 * 打开项目（进画布之前的那一屏）。
 *
 * 调性刻意与画布相反：画布是暗色的「制图台」，这里是**纸面**——
 * 打开项目之前用户面对的是一张白纸（选一个文件夹开始），
 * 进了工作区才落到暗色台面上。两者用不同的色阶（paper / studio），
 * 免得用户以为「打开项目」和「画图」是同一屏里的两个面板。
 *
 * 版面是**两栏**，不是一个居中的窄表单：
 *   - 左栏（宽）是焦点区——最近项目的图签卡片 + 已登记的工作区，
 *     用户九成的时间在这里点；
 *   - 右栏（窄）是右栏——「新建项目」是一次性动作，配一段「数据去哪了」，
 *     说完就沉底，不跟焦点区抢。
 * 窄屏时右栏折到上面（order-first），因为那时它是唯一能立刻做的事。
 *
 * 这一屏的主语是**图签**：卡片不是通用 SaaS 卡片，是地图上那个图签框
 * （细边框 + 双线内框 + 题注栏 + 图号），跟出图时印在图框里的标题栏
 * 是同一套视觉语言。产品叫「图签」，入口就该长成这个样子。
 *
 * 动效沿用 CanvasMotion 的规矩：显式 ref、不写选择器、只动 transform/opacity、
 * 尊重 prefers-reduced-motion（用户中途改设置也生效）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRightIcon, CheckCircleIcon, FolderOpenIcon } from '@phosphor-icons/react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ActionButton, EmptyHint, StatusDot, TextField } from './ui';
import { ProjectCard } from './project/ProjectCard';
import { ProjectToolbar } from './project/ProjectToolbar';
import { WorkspaceList } from './project/WorkspaceList';
import { filterProjects, sortProjects, type ProjectSort } from './project/project-utils';
import { prefersReducedMotion } from './project/useReducedMotion';
import { listRoots, pickFolder, registerWorkspace, unregisterRoot } from './useProjects';
import type { ProjectSummary, WorkspaceRoot } from './types';

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

/** 纸面侧的小节标题（ui.tsx 的 SectionLabel 是画布那一套色阶，不能用） */
function PickerLabel({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h2
      id={id}
      className="font-mono text-[11px] font-medium tracking-[0.12em] text-ink-3"
    >
      {children}
    </h2>
  );
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
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSort>('recent');
  /** 正在切到画布：这一屏淡出，等画布接上 */
  const [leaving, setLeaving] = useState(false);
  const [roots, setRoots] = useState<readonly WorkspaceRoot[]>([]);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [rootsLoading, setRootsLoading] = useState(true);
  /** 刚用弹窗选中的文件夹（只有代号与名字，没有绝对路径） */
  const [picked, setPicked] = useState<{ handle: string; label: string } | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLUListElement | null>(null);
  /** 右栏：空状态里的「去登记第一个项目」要把光标送回路径输入框 */
  const createRef = useRef<HTMLDivElement | null>(null);
  /** 图签卡片只落一次场；之后的淡入是筛选/排序造成的，是另一回事 */
  const entered = useRef(false);
  /** 离场那一刻的错误文案（用来分辨「新错误」与「旧错误」） */
  const errorAtLeave = useRef<string | null>(null);

  const trimmed = manual.trim();
  const visible = useMemo(
    () => sortProjects(filterProjects(recent, query), sort),
    [recent, query, sort],
  );

  /* ── 图签卡片：首次落场（错峰落下），筛选/排序之后淡入 ── */
  const listKey = visible.map((p) => p.path).join('\u0001');
  useGSAP(
    () => {
      const grid = gridRef.current;
      if (!grid) return;
      const items = Array.from(grid.children) as HTMLElement[];
      if (items.length === 0) return;
      if (prefersReducedMotion()) return;
      if (!entered.current) {
        entered.current = true;
        gsap.from(items, {
          y: 14,
          autoAlpha: 0,
          duration: 0.5,
          stagger: 0.04,
          ease: 'power2.out',
          clearProps: 'transform,opacity,visibility',
        });
      } else {
        gsap.fromTo(
          items,
          { autoAlpha: 0 },
          { autoAlpha: 1, duration: 0.22, ease: 'power1.out', clearProps: 'opacity,visibility' },
        );
      }
    },
    { dependencies: [listKey] },
  );

  /* ── 切到画布：卡片这一屏淡出并轻微缩放，别硬切 ── */
  const leave = useCallback(
    (action: () => void) => {
      if (leaving) return;
      setLeaving(true);
      errorAtLeave.current = error;
      const root = rootRef.current;
      if (!root || prefersReducedMotion()) {
        action();
        return;
      }
      gsap.to(root, {
        autoAlpha: 0,
        scale: 0.985,
        duration: 0.26,
        ease: 'power2.out',
        onComplete: action,
      });
    },
    [leaving, error],
  );

  // 打开失败时这一屏还在（引擎没起来、清单坏了……），得把它恢复出来
  useEffect(() => {
    if (!leaving) return;
    if (!error || error === errorAtLeave.current) return;
    setLeaving(false);
    const root = rootRef.current;
    if (root) gsap.set(root, { clearProps: 'transform,opacity,visibility' });
  }, [error, leaving]);

  const handleOpen = useCallback(
    (path: string) => {
      if (busy || leaving) return;
      leave(() => onOpenExisting(path));
    },
    [busy, leaving, leave, onOpenExisting],
  );

  const handleCreate = useCallback(() => {
    if (!trimmed || busy || leaving) return;
    leave(() => onCreateFromFolder(trimmed));
  }, [trimmed, busy, leaving, leave, onCreateFromFolder]);

  /** 空状态里的引导按钮：把光标送到路径输入框 */
  const focusCreate = useCallback(() => {
    const input = createRef.current?.querySelector<HTMLInputElement>('#new-project-path');
    if (!input) return;
    input.focus();
    input.scrollIntoView({
      block: 'center',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, []);

  /* ── 已登记的工作区 ── */
  const loadRoots = useCallback(async () => {
    setRootsLoading(true);
    try {
      const list = await listRoots();
      setRoots(list);
      setRootsError(null);
    } catch (err) {
      setRoots([]);
      setRootsError((err as Error).message);
    } finally {
      setRootsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  // 引擎刚起来（离线转在线）时重读一次：离线时根本读不到
  const wasOffline = useRef(engineOffline);
  useEffect(() => {
    if (wasOffline.current && !engineOffline) {
      wasOffline.current = engineOffline;
      void loadRoots();
      return;
    }
    wasOffline.current = engineOffline;
  }, [engineOffline, loadRoots]);

  const handleUnregister = useCallback((id: string) => {
    setRootsError(null);
    void (async () => {
      try {
        await unregisterRoot(id);
        // 撤完立刻从列表里去掉
        setRoots((prev) => prev.filter((r) => r.id !== id));
      } catch (err) {
        setRootsError((err as Error).message);
      }
    })();
  }, []);

  /**
   * 弹系统的文件夹选择框。
   *
   * 拿到的是**代号**与文件夹名，没有绝对路径 —— 绝对路径只在引擎那边（见
   * server/src/folder-picker.ts）。所以界面上从头到尾不会出现用户的盘符与用户名。
   */
  const handlePick = useCallback(() => {
    if (busy || leaving) return;
    setRootsError(null);
    void (async () => {
      try {
        const picked = await pickFolder();
        if (!picked) return; // 用户取消，不是错误
        setPicked({ handle: picked.handle, label: picked.label });
        // 直接登记：用户既然选了就是要用它，不必再点一次
        await registerWorkspace({ handle: picked.handle });
        await loadRoots();
      } catch (err) {
        setRootsError((err as Error).message);
      }
    })();
  }, [busy, leaving, loadRoots]);

  return (
    <div ref={rootRef} className="min-h-[100dvh] bg-paper text-ink">
      <div className="mx-auto w-full max-w-[1440px] px-5 py-7 sm:px-8 lg:px-10 lg:py-10">
        {/* ── 页头 ── */}
        <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3 border-b border-line pb-5">
          <div className="min-w-0">
            <h1 className="font-display text-[28px] font-semibold tracking-tight text-ink">
              打开一个项目
            </h1>
            <p className="mt-1.5 max-w-[68ch] text-[13px] leading-[1.55] text-ink-2">
              一个项目 = 一次交差任务：源数据留在原地，工具在旁边建
              <code className="mx-0.5 rounded bg-paper-deep px-1 font-mono text-[12px]">
                .cartouche
              </code>
              记进度与产出。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-1.5 text-[12px] text-ink-3">
            <StatusDot tone={engineOffline ? 'offline' : 'ready'} />
            <span>{engineOffline ? '引擎离线' : '引擎在线'}</span>
          </div>
        </header>

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

        {/* ── 两栏：左=焦点区，右=一次性动作与说明 ── */}
        <div className="mt-7 grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_370px]">
          {/* ── 左栏：最近项目 + 已登记的工作区 ── */}
          <div className="order-2 min-w-0 lg:order-1">
            <section aria-labelledby="picker-recent">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2.5">
                <div className="flex items-baseline gap-2.5">
                  <PickerLabel id="picker-recent">最近项目</PickerLabel>
                  <span className="tnum font-mono text-[11px] text-ink-3">{visible.length}</span>
                </div>
                {recent.length > 0 ? (
                  <ProjectToolbar
                    query={query}
                    onQueryChange={setQuery}
                    sort={sort}
                    onSortChange={setSort}
                  />
                ) : null}
              </div>

              {recent.length === 0 ? (
                <div className="mt-3">
                  <EmptyHint tone="paper">
                    <div className="flex flex-col items-center gap-4 py-3 text-center">
                      {/*
                        空图签：把这块界面的形状本身画出来（真卡片就是这个样子：
                        图号、图名、题注栏）。它比一句「暂无数据」有方向感 ——
                        用户看得懂「项目长什么样」。
                      */}
                      <div
                        aria-hidden="true"
                        className="w-[238px] border border-line-2 bg-surface px-3.5 py-3"
                      >
                        <div className="font-mono text-[11px] leading-none tracking-[0.16em] text-ink-3">
                          CH-——————
                        </div>
                        <div className="mt-3.5 text-[13px] font-semibold leading-snug text-ink-3">
                          未命名图幅
                        </div>
                        <div className="mt-3.5 border-t border-line pt-2">
                          <div className="truncate font-mono text-[11px] leading-[1.45] text-ink-3">
                            D:\……\……
                          </div>
                          <div className="mt-1 flex items-baseline justify-between font-mono text-[11px] text-ink-3">
                            <span>0 图层</span>
                            <span>————</span>
                          </div>
                        </div>
                      </div>
                      <div>
                        <p className="text-[13px] text-ink-2">还没有打开过的项目</p>
                        <p className="mx-auto mt-1 max-w-[44ch] text-[12px] leading-relaxed text-ink-3">
                          填一个图件所在的文件夹并登记，它就会变成上面那样一枚图签；
                          之后每次打开都从这里点进去。源文件不动，工具只在旁边记进度。
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={focusCreate}
                        className="inline-flex h-10 items-center gap-1.5 border border-line bg-surface px-3.5 text-[12.5px] text-ink transition-colors hover:border-ink-3"
                      >
                        去登记第一个项目
                        <ArrowRightIcon size={13} aria-hidden="true" />
                      </button>
                    </div>
                  </EmptyHint>
                </div>
              ) : visible.length === 0 ? (
                <div className="mt-3">
                  <EmptyHint tone="paper">
                    <div className="flex flex-wrap items-center justify-center gap-3 py-1">
                      <span className="text-[12.5px] text-ink-3">
                        没有匹配「{query}」的项目。
                      </span>
                      <button
                        type="button"
                        onClick={() => setQuery('')}
                        className="inline-flex h-10 items-center border border-line px-3 text-[12.5px] text-ink transition-colors hover:border-ink-3"
                      >
                        清除搜索
                      </button>
                    </div>
                  </EmptyHint>
                </div>
              ) : (
                <ul
                  ref={gridRef}
                  className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(186px,1fr))] gap-3"
                >
                  {visible.map((project) => (
                    <ProjectCard
                      key={project.path}
                      project={project}
                      disabled={busy || leaving}
                      onOpen={handleOpen}
                    />
                  ))}
                </ul>
              )}
            </section>

            {/* ── 已登记的工作区 ── */}
            <section aria-labelledby="picker-workspaces" className="mt-9 border-t border-line pt-5">
              <div className="flex items-baseline gap-3">
                <PickerLabel id="picker-workspaces">已登记的工作区</PickerLabel>
                <span className="text-[11.5px] text-ink-3">引擎只在这些目录里动手</span>
              </div>
              <WorkspaceList
                roots={roots}
                loading={rootsLoading}
                error={rootsError}
                onUnregister={handleUnregister}
              />
            </section>
          </div>

          {/* ── 右栏：新建项目（一次性动作）+ 说明 ── */}
          <div
            ref={createRef}
            className="order-1 lg:order-2 lg:sticky lg:top-10 lg:self-start"
          >
            <section aria-labelledby="picker-create">
              <div className="flex items-baseline gap-3">
                <PickerLabel id="picker-create">新建项目</PickerLabel>
                <span className="text-[11.5px] text-ink-3">登记后出现在左边的图签里</span>
              </div>

              {/* ── 主行动：自己挑一个文件夹 ────────────────────────────
                  手打绝对路径是**门槛**（盘符、中文、反斜杠），
                  而这个工具是跑在用户自己电脑上的本机服务 ——
                  让它弹系统那个「选择文件夹」的框，是最省事的做法：
                  用户看到的是熟悉的资源管理器界面，选完直接就能用。

                  弹出来的路径**不会进浏览器**：引擎自己记住它，
                  只给前端一个代号。所以界面上从头到尾看不到
                  用户的盘符与用户名（那属于隐私，不该被顺手带出去）。 */}
              <button
                type="button"
                onClick={handlePick}
                disabled={busy || leaving}
                className="mt-3 flex h-11 w-full items-center justify-center gap-2 border border-ink bg-surface px-4 text-[13px] font-medium text-ink transition-colors hover:bg-paper-deep disabled:pointer-events-none disabled:opacity-45"
              >
                <FolderOpenIcon size={16} weight="bold" aria-hidden="true" />
                选一个文件夹
              </button>

              {picked ? (
                <p className="mt-2 flex items-baseline gap-1.5 text-[11.5px] text-ink-3">
                  <CheckCircleIcon size={13} weight="bold" aria-hidden="true" className="shrink-0 text-accent" />
                  已登记
                  <span className="font-mono text-ink-2">{picked.label}</span>
                </p>
              ) : null}

              {/* 手动输入：留作退路（图形界面选不了的时候，比如远程机器） */}
              <details className="mt-4 border-t border-line pt-3">
                <summary className="cursor-pointer list-none text-[12px] text-ink-3 transition-colors hover:text-ink-2">
                  或手动填写路径
                </summary>
                <label htmlFor="new-project-path" className="mt-3 block text-[12.5px] text-ink-3">
                  图件所在的文件夹
                </label>
                <TextField
                  id="new-project-path"
                  tone="paper"
                  value={manual}
                  onChange={(event) => setManual(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleCreate();
                  }}
                  placeholder="D:\任务\2026改图"
                  className="mt-1.5 h-10 w-full font-mono focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 focus-visible:[--tw-outline-style:solid]!"
                />
                <ActionButton
                  variant="primary"
                  disabled={!trimmed || busy || leaving}
                  onClick={handleCreate}
                  className="mt-2 h-10 w-full px-4"
                >
                  <FolderOpenIcon size={15} weight="bold" />
                  登记并新建
                </ActionButton>
                <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
                  这个文件夹必须已经存在。工具不会搬动里面的任何东西，只在旁边建一个
                  <code className="mx-0.5 rounded bg-paper-deep px-1 font-mono">.cartouche</code>
                  目录记录进度。
                </p>
              </details>
            </section>

            <section className="mt-7 border-t border-line pt-5">
              <PickerLabel>数据去哪了</PickerLabel>
              <ul className="mt-2.5 flex flex-col gap-1.5 text-[12px] leading-relaxed text-ink-3">
                <li className="flex gap-2">
                  <span aria-hidden="true" className="mt-[7px] h-px w-2 shrink-0 bg-line-2" />
                  <span>源数据一个字节都不动，工具只读它。</span>
                </li>
                <li className="flex gap-2">
                  <span aria-hidden="true" className="mt-[7px] h-px w-2 shrink-0 bg-line-2" />
                  <span>进度、留痕与产出物都在旁边的 .cartouche 里。</span>
                </li>
                <li className="flex gap-2">
                  <span aria-hidden="true" className="mt-[7px] h-px w-2 shrink-0 bg-line-2" />
                  <span>文件夹整个拷走，进度也跟着走。</span>
                </li>
              </ul>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
