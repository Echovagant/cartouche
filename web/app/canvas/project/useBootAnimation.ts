'use client';

/**
 * 加载动画的播放方式（本机偏好，存 localStorage，不上传）。
 *
 * 三态：
 *   - `always`      每次打开画布都完整播（想看随时看得到）；
 *   - `first-visit` 默认：第一次访问完整播，12 小时内再来自动缩短（业界通行做法）；
 *   - `never`       一次都不播 —— 直接进工作台，不闪屏。
 *
 * 这个开关同时管两处加载反馈：
 *   1. **启动屏**（BootCinematic，全屏 cinematic 动画）；
 *   2. **打开项目时**的加载态（画布区遮罩 + 进度）——
 *      大文件转换可能要几十秒，没有反馈界面就像卡死。
 *
 * `never` 不等于"没有信息"：打开项目时的文字提示（正在加载哪个图层）始终保留，
 * 灭掉的只是动效 —— 与项目既有原则一致（「动效只负责表达状态变化，不承载信息」）。
 */
import { useCallback, useEffect, useState } from 'react';

export type BootAnimationMode = 'always' | 'first-visit' | 'never';

const STORAGE_KEY = 'cartouche.boot.animation';

export const BOOT_ANIMATION_LABELS: Record<BootAnimationMode, string> = {
  always: '总是播放',
  'first-visit': '仅首次访问',
  never: '从不播放',
};

export const BOOT_ANIMATION_HINTS: Record<BootAnimationMode, string> = {
  always: '每次打开画布都完整播一遍启动动画（约 2 秒）。',
  'first-visit': '第一次访问播完整动画，12 小时内再来自动缩短到约 1 秒。',
  never: '直接进工作台，不播启动动画；打开大项目时的文字提示仍然保留。',
};

function isMode(value: unknown): value is BootAnimationMode {
  return value === 'always' || value === 'first-visit' || value === 'never';
}

/** 读当前设置；localStorage 不可用时按默认（首次访问）走 */
export function readBootAnimationMode(): BootAnimationMode {
  if (typeof window === 'undefined') return 'first-visit';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isMode(raw) ? raw : 'first-visit';
  } catch {
    return 'first-visit';
  }
}

/** 写入设置；'first-visit' 是默认值，用 removeItem 而不是写一个冗余值 */
export function setBootAnimationMode(mode: BootAnimationMode): void {
  try {
    if (mode === 'first-visit') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 隐私模式下写不了，本次会话内不生效 */
  }
}

/**
 * 首帧前用的标记：写到 <html data-boot>，CSS 据此把启动屏**在渲染前**藏掉。
 *
 * 为什么需要它：静态导出（next build + output: export）会把启动屏标记
 * 预渲染进 HTML —— 如果只靠 JS 判断，首帧会先闪一下启动屏再消失。
 * 内联脚本 + CSS 属性选择器是唯一能做到"首帧就没有"的办法
 * （与主题的 data-theme 同一套路）。
 */
export const BOOT_ATTR = 'data-boot';

export function applyBootAttr(mode: BootAnimationMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute(BOOT_ATTR, mode === 'never' ? 'off' : 'on');
}

/** React 侧订阅设置值（设置页改完立刻反映到界面，不必刷新） */
export function useBootAnimationMode(): [BootAnimationMode, (mode: BootAnimationMode) => void] {
  const [mode, setMode] = useState<BootAnimationMode>('first-visit');

  useEffect(() => {
    setMode(readBootAnimationMode());
  }, []);

  const update = useCallback((next: BootAnimationMode) => {
    setBootAnimationMode(next);
    setMode(next);
    applyBootAttr(next);
  }, []);

  return [mode, update];
}
