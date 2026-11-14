'use client';

/**
 * 跟随系统的「减少动态效果」设置。
 *
 * 为什么不在挂载时读一次 `.matches` 就完事：用户中途在系统里改了设置，
 * 界面还得跟着变（这是系统设置该有的样子）。
 * 写法照 MagneticLink：matchMedia + change 事件。
 */
import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/** 用户在设置页里的覆盖值：'1' = 永远减弱动效；未设置 = 跟系统 */
const OVERRIDE_KEY = 'cartouche.reduce-motion';

/**
 * 一次性读取当前设置。
 *
 * 给 GSAP 回调用：动画开始那一刻的设置才是准的
 * （React 状态可能还没跟上一次设置变更）。
 *
 * 优先级：设置页的覆盖（localStorage）→ 系统设置。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.localStorage.getItem(OVERRIDE_KEY) === '1') return true;
  } catch {
    /* 隐私模式下不可用，走系统设置 */
  }
  return window.matchMedia(QUERY).matches;
}

/** 写入 / 清除设置页的覆盖值；写入后刷新页面生效 */
export function setReduceMotionOverride(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(OVERRIDE_KEY, '1');
    else window.localStorage.removeItem(OVERRIDE_KEY);
  } catch {
    /* 隐私模式下写不了，本次会话内不生效 */
  }
}

export function readReduceMotionOverride(): boolean {
  try {
    return window.localStorage.getItem(OVERRIDE_KEY) === '1';
  } catch {
    return false;
  }
}

/** 跟着系统设置走；用户中途改也生效 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const update = (): void => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  return reduced;
}
