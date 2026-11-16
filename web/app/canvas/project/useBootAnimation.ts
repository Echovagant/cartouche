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
import { ENGINE_BASE } from '../../engine-base';

export type BootAnimationMode = 'always' | 'first-visit' | 'never';

const STORAGE_KEY = 'cartouche.boot.animation';
/**
 * 「这个值已经和引擎核对过」的标记。
 *
 * 没有它 = 本地缓存还没跟引擎比对过（首访、换浏览器、换访问地址），
 * 这时要**先问引擎**再决定播不播 —— 跨浏览器才能拿到同一份设置。
 */
const SYNCED_KEY = 'cartouche.boot.synced';

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

/** 本地缓存是否已经和引擎核对过 */
export function isBootAnimationSynced(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SYNCED_KEY) === '1';
  } catch {
    return false;
  }
}

/** 记下"已与引擎核对过" */
function markSynced(): void {
  try {
    window.localStorage.setItem(SYNCED_KEY, '1');
  } catch {
    /* 隐私模式写不了：下次再问一遍引擎就是了 */
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
 *
 * `pending` = 本地缓存还没跟引擎核对过（首访、换浏览器、换访问地址）：
 * 这时**先藏住**启动屏，等问完引擎再决定播不播 —— 问的工夫只有几十毫秒，
 * 藏着比"闪一下再消失"好看得多。
 */
export const BOOT_ATTR = 'data-boot';
export const BOOT_PENDING_ATTR = 'data-boot-pending';

export function applyBootAttr(mode: BootAnimationMode, pending = false): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute(BOOT_ATTR, mode === 'never' ? 'off' : 'on');
  document.documentElement.setAttribute(BOOT_PENDING_ATTR, pending ? '1' : '0');
}

/**
 * 向引擎问一次机器级设置（引擎是权威：跨浏览器、跨访问地址都一致）。
 *
 * 返回 null = 问不到（引擎没起 / 超时）——调用方按本地缓存继续，
 * 不能因为引擎没起就让用户看到个错的设置。
 *
 * 拿到值后顺手写回本地缓存并打"已核对"标记：下次启动就能零延迟用本地值。
 */
export async function fetchEngineBootMode(timeoutMs = 800): Promise<BootAnimationMode | null> {
  if (typeof window === 'undefined') return null;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ENGINE_BASE}/api/settings`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { bootAnimation?: unknown };
    if (!isMode(body.bootAnimation)) return null;
    setBootAnimationMode(body.bootAnimation);
    markSynced();
    return body.bootAnimation;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/** 把设置写进引擎（权威副本）：保存时两边都写，本地即时生效、引擎跨浏览器共享 */
export async function saveBootModeToEngine(mode: BootAnimationMode): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    const res = await fetch(`${ENGINE_BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootAnimation: mode }),
    });
    if (!res.ok) return false;
    markSynced();
    return true;
  } catch {
    return false;
  }
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
    // 同步到引擎（跨浏览器/跨地址共享）——失败也不影响本地已生效
    void saveBootModeToEngine(next);
  }, []);

  return [mode, update];
}
