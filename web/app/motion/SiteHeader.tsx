'use client';

/**
 * 顶部导航。
 *
 * ── 折叠点为什么定在 900px ─────────────────────────────────────
 * 旧写法是 `i >= 2 ? 'hidden md:block' : 'hidden sm:block'`：
 * 640–767px 只剩 2 个链接、768–1023px 变 4 个——同一套导航在
 * 两段宽度里显示的东西不一样，看着像 bug。
 * 现在统一成一个断点：< 900px 时链接**全收进汉堡**，只留 logo 与
 * 「打开画布」；≥ 900px 时一行铺开。
 *
 * 玻璃皮（浅色段 / 深色段）由 <html data-surface> 驱动，
 * 切换逻辑在 globals.css 的 `[data-surface='dark'] .glass` 里。
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CompassIcon, ListIcon, XIcon } from '@phosphor-icons/react';

export interface NavItem {
  readonly href: string;
  readonly label: string;
}

export function SiteHeader({ items }: { items: readonly NavItem[] }) {
  const [open, setOpen] = useState(false);
  /**
   * 导航实体化阈值 **16px**：首屏顶部是透明的，滚过 16px 才获得实体。
   *
   * 为什么不是"永远实体"：永远有底色的导航会读成「管理后台」，不是官网。
   * 阈值取 16px（NIO 实测 10px、理想整页透明），16px 是本站自己的取值。
   *
   * 注意：这一条与 ScrollChoreography 里 `top 72px` 的**表面色切换**是
   * 两件事——72px 管的是"导航落在浅段还是深段"，16px 管的是"要不要实体"。
   */
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    const update = (): void => setSolid(window.scrollY > 16);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  // 打开菜单时锁住背景滚动：菜单浮层下面不该还能滚页面
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-4 pt-4 sm:px-6">
      {/*
        skip link：**首个可聚焦元素**。它是键盘用户的第一站，
        平时视觉隐藏，聚焦时出现在左上角。
      */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-paper focus:px-4 focus:py-2.5 focus:text-[15px] focus:font-medium focus:text-ink focus:shadow-[var(--shadow-nav)]"
      >
        跳到主内容
      </a>

      <nav
        className={`${solid ? 'glass' : 'nav-bar-plain'} mx-auto flex max-w-6xl flex-nowrap items-center gap-3 rounded-full px-3.5 py-2.5 sm:px-5`}
      >
        <Link
          href="./"
          className="nav-fg flex shrink-0 items-center gap-2.5 text-[13.5px] font-medium tracking-tight whitespace-nowrap"
        >
          <span className="grid h-7 w-7 place-items-center rounded-full border border-current">
            <CompassIcon aria-hidden="true" size={15} weight="bold" />
          </span>
          图签 Cartouche
        </Link>
        <span className="nav-divider hidden h-4 w-px lg:block" />
        <span className="nav-fg-muted hidden font-mono text-[12px] tracking-wide whitespace-nowrap lg:block">
          本机运行的出图工具
        </span>
        <span className="flex-1" />

        {/* ≥900px：一行铺开 */}
        <div className="hidden min-[900px]:flex min-[900px]:items-center">
          {items.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="nav-fg-muted inline-flex min-h-11 min-w-11 items-center justify-center rounded-full px-3 text-label whitespace-nowrap transition-colors"
            >
              {item.label}
            </a>
          ))}
          <a
            href="ai.html"
            className="nav-fg-muted inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-full px-3 text-[13px] whitespace-nowrap transition-colors"
          >
            AI 接入
            <span
              className="nav-warn rounded-full border px-1.5 py-px font-mono text-[11px] leading-none"
              title="模型接入（配密钥、拉模型清单、测连通）已可用；用一句话改图的链路已接通，但还没用真实模型跑通"
            >
              开发中
            </span>
          </a>
        </div>

        {/* <900px：汉堡 */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="site-menu"
          className="nav-outline inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border transition-colors min-[900px]:hidden"
        >
          {open ? (
            <XIcon aria-hidden="true" size={18} weight="bold" />
          ) : (
            <ListIcon aria-hidden="true" size={18} weight="bold" />
          )}
          <span className="sr-only">{open ? '关闭菜单' : '打开菜单'}</span>
        </button>

        <a
          href="canvas.html"
          className="nav-fg shrink-0 rounded-full border border-current px-4 py-2 text-[13px] font-medium whitespace-nowrap transition-colors hover:bg-[var(--nav-hover-bg)]"
        >
          打开画布
        </a>
      </nav>

      {/* 移动端菜单：浮层在药丸下面 */}
      {open ? (
        <div
          id="site-menu"
          className="glass mx-auto mt-2 max-w-6xl overflow-hidden rounded-panel p-2 min-[900px]:hidden"
        >
          {items.map((item) => (
            <a
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="nav-item flex min-h-11 items-center rounded-lg px-4 text-label transition-colors"
            >
              {item.label}
            </a>
          ))}
          <a
            href="ai.html"
            onClick={() => setOpen(false)}
            className="nav-item flex min-h-11 items-center gap-2 rounded-lg px-4 text-[14px] transition-colors"
          >
            AI 接入
            <span
              className="nav-warn rounded-full border px-1.5 py-px font-mono text-[11px] leading-none"
              title="模型接入（配密钥、拉模型清单、测连通）已可用；用一句话改图的链路已接通，但还没用真实模型跑通"
            >
              开发中
            </span>
          </a>
        </div>
      ) : null}
    </header>
  );
}
