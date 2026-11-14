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

/**
 * 一次性读取当前设置。
 *
 * 给 GSAP 回调用：动画开始那一刻的设置才是准的
 * （React 状态可能还没跟上一次设置变更）。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(QUERY).matches;
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
