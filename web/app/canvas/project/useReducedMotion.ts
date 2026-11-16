'use client';

/**
 * 跟随系统的「减少动态效果」设置 + 设置页的覆盖值。
 *
 * 为什么不在挂载时读一次 `.matches` 就完事：用户中途在系统里改了设置，
 * 界面还得跟着变（这是系统设置该有的样子）。
 * 写法照 MagneticLink：matchMedia + change 事件。
 *
 * **覆盖值的来源有三层，优先级从高到低**：
 *   1. 设置页的覆盖（localStorage 的 '1'/'0'）—— 用户在本机明确设过；
 *   2. **引擎的机器级设置**（权威）—— 换浏览器、换访问地址都跟着走
 *      （2026-11-16 用户裁定：主题留浏览器，但减弱动效搬引擎）；
 *   3. 系统设置（prefers-reduced-motion）。
 *
 * 引擎的值在**启动后异步**到达（几十毫秒），到达前一律按"减弱"处理 ——
 * 对动效敏感的用户宁可少一次入场动画，也不该先看到一次闪过的动效。
 */
import { useEffect, useState } from 'react';
import {
  fetchEngineSettings,
  markEngineSettingsSynced,
} from './engineSettings';

const QUERY = '(prefers-reduced-motion: reduce)';

/** 用户在设置页里的覆盖值：'1' = 永远减弱动效；'0' = 明确不减弱；未设置 = 跟引擎/系统 */
const OVERRIDE_KEY = 'cartouche.reduce-motion';

/** 三态决策：pending = 还没问引擎（此时按"减弱"处理） */
export type ReduceMotionDecision = 'pending' | 'on' | 'off';

/** 一次性读取当前设置。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(OVERRIDE_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    /* 隐私模式下不可用，走系统设置 */
  }
  return window.matchMedia(QUERY).matches;
}

/** 写入 / 清除设置页的覆盖值；写入后刷新页面生效 */
export function setReduceMotionOverride(on: boolean): void {
  try {
    window.localStorage.setItem(OVERRIDE_KEY, on ? '1' : '0');
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

/** 本地有没有明确值（'1'/'0'）；没有 = 该问引擎 */
function readLocalDecision(): 'on' | 'off' | null {
  try {
    const raw = window.localStorage.getItem(OVERRIDE_KEY);
    if (raw === '1') return 'on';
    if (raw === '0') return 'off';
  } catch {
    /* 读不到就当没有 */
  }
  return null;
}

/**
 * 三态决策：动画组件据此决定播不播。
 *
 * - `pending`：还没问引擎（首访 / 换浏览器）→ **一律当作要减弱**，
 *   宁可少一次入场动画，也不给敏感用户闪一下动效；
 * - `on`：减弱动效；
 * - `off`：正常播。
 *
 * 本地有明确值 → 立即给结论（零延迟）；没有 → 问引擎（≤800ms），
 * 拿到后写回本地缓存，下次启动就零延迟。
 */
export function useReduceMotionDecision(): ReduceMotionDecision {
  const [decision, setDecision] = useState<ReduceMotionDecision>(() => {
    if (typeof window === 'undefined') return 'pending';
    // 还没问引擎时先按"减弱"：等答案的工夫里不播任何动效
    return readLocalDecision() ?? 'pending';
  });

  useEffect(() => {
    const local = readLocalDecision();
    let alive = true;
    void fetchEngineSettings().then((settings) => {
      if (!alive) return;
      if (typeof settings?.reduceMotion === 'boolean') {
        // 引擎是权威：写回本地缓存（下次零延迟），并按它的值决定。
        // ⚠️ 即使本地已经有值也要核对：设置可能在**另一个浏览器**里改过
        //    （2026-11-16 实测踩到：标记是永久的 → 引擎改了本地永远不知道）。
        //    本地有值时这次是**后台**核对，不影响首帧。
        try {
          window.localStorage.setItem(OVERRIDE_KEY, settings.reduceMotion ? '1' : '0');
        } catch {
          /* 写不了就只本次会话生效 */
        }
        markEngineSettingsSynced();
        setDecision(settings.reduceMotion ? 'on' : 'off');
        return;
      }
      // 引擎没这项（老版本 / 没配）→ 跟系统
      if (!local) setDecision(window.matchMedia(QUERY).matches ? 'on' : 'off');
    });
    return () => {
      alive = false;
    };
  }, []);

  return decision;
}
