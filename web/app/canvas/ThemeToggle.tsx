'use client';

/**
 * 浅色 / 暗色主题切换。
 *
 * 为什么放在画布而不是全局：落地页永远是浅色的（那是它的品牌面），
 * 只有画布需要两套——暗色是"制图台"，浅色是"白天在办公室里看图"。
 * 落地页用的 paper/ink 色阶不受影响。
 *
 * 实现要点：
 *  - 主题状态存在 `<html data-theme="...">` 上，CSS 变量据此取值；
 *  - 初次加载由 layout.tsx 里的内联脚本**在首帧之前**应用，避免闪白；
 *  - 切换那一瞬间挂 `theme-shift` class 做颜色过渡，过完立刻摘掉。
 */
import { useEffect, useState } from 'react';
import { MoonIcon, SunIcon } from '@phosphor-icons/react';

type Theme = 'dark' | 'light';

const STORAGE_KEY = 'cartouche.canvas.theme';

function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  // 挂载后同步一次真实值（内联脚本可能已经设成了用户上次选的）
  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    const root = document.documentElement;

    // 先挂过渡 class，再换主题 → 颜色平滑过渡
    root.classList.add('theme-shift');
    root.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 隐私模式下 localStorage 可能不可用；不影响本次切换
    }

    window.setTimeout(() => root.classList.remove('theme-shift'), 480);
  };

  const dark = theme === 'dark';

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
