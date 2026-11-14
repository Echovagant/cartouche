'use client';

/**
 * 浅色 / 暗色主题切换。
 *
 * 全站一个开关：画布工作台、AI 工作台、官网都跟着 <html data-theme> 走。
 * 主题状态存在 `<html data-theme="...">` 上，CSS 变量据此取值；
 * 初次加载由 layout.tsx 里的内联脚本**在首帧之前**应用，避免闪白；
 * 切换那一瞬间挂 `theme-shift` class 做颜色过渡，过完立刻摘掉。
 *
 * 三个形态：
 *   - `pill`：滑杆式开关（默认）。画布状态栏用；
 *   - `icon`：单图标按钮，studio 色阶（画布活动栏底部用）；
 *   - `nav`：单图标按钮，颜色跟导航的 --nav-fg 走（官网玻璃导航上用，
 *     那里的深浅由 data-surface 按所在段落决定，不能用 studio 色阶）。
 */
import { useEffect, useState } from 'react';
import { MoonIcon, SunIcon } from '@phosphor-icons/react';

type Theme = 'dark' | 'light';

const STORAGE_KEY = 'cartouche.theme';

function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(next: Theme): void {
  const root = document.documentElement;
  root.classList.add('theme-shift');
  root.dataset.theme = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 隐私模式下 localStorage 可能不可用；不影响本次切换
  }
  window.setTimeout(() => root.classList.remove('theme-shift'), 480);
}

export function ThemeToggle({ variant = 'pill' }: { variant?: 'pill' | 'icon' | 'nav' } = {}) {
  const [theme, setTheme] = useState<Theme>('dark');

  // 挂载后同步一次真实值（内联脚本可能已经设成了用户上次选的）
  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };

  const dark = theme === 'dark';

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={toggle}
        title={dark ? '切换到浅色主题' : '切换到暗色主题'}
        aria-label={dark ? '切换到浅色主题' : '切换到暗色主题'}
        className="flex h-6 w-6 items-center justify-center rounded-md text-studio-ink-3 transition-colors hover:bg-studio-3 hover:text-studio-ink"
      >
        {dark ? <SunIcon size={14} weight="bold" aria-hidden="true" /> : <MoonIcon size={14} weight="bold" aria-hidden="true" />}
      </button>
    );
  }

  if (variant === 'nav') {
    return (
      <button
        type="button"
        onClick={toggle}
        title={dark ? '切换到浅色主题' : '切换到暗色主题'}
        aria-label={dark ? '切换到浅色主题' : '切换到暗色主题'}
        className="nav-fg-muted inline-flex h-11 w-11 items-center justify-center rounded-full border border-transparent transition-colors hover:bg-[var(--nav-hover-bg)] hover:text-[var(--nav-fg)]"
      >
        {dark ? <SunIcon size={16} weight="bold" aria-hidden="true" /> : <MoonIcon size={16} weight="bold" aria-hidden="true" />}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? '切换到浅色' : '切换到暗色'}
      aria-label={dark ? '切换到浅色主题' : '切换到暗色主题'}
      className="group relative flex h-7 w-[58px] shrink-0 items-center rounded-full border border-studio-line bg-studio-3/60 p-0.5 transition-colors hover:border-studio-ink-3"
    >
      {/* 滑块 */}
      <span
        aria-hidden="true"
        className={`flex h-5 w-5 items-center justify-center rounded-full bg-accent text-paper shadow-lift transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          dark ? 'translate-x-0' : 'translate-x-[26px]'
        }`}
      >
        {dark ? (
          <MoonIcon size={12} weight="fill" />
        ) : (
          <SunIcon size={12} weight="fill" />
        )}
      </span>
      {/* 两个图标做背景提示（用 studio 色阶，跟着主题走） */}
      <span className="pointer-events-none absolute inset-0 flex items-center justify-between px-[7px]">
        <SunIcon
          size={12}
          weight="bold"
          className={`text-studio-ink-3 transition-opacity duration-200 ${dark ? 'opacity-100' : 'opacity-0'}`}
        />
        <MoonIcon
          size={12}
          weight="bold"
          className={`text-studio-ink-3 transition-opacity duration-200 ${dark ? 'opacity-0' : 'opacity-100'}`}
        />
      </span>
    </button>
  );
}
