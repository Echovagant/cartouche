'use client';

/**
 * 引擎侧机器级设置的同步（权威副本）。
 *
 * 浏览器 localStorage 按 origin + 浏览器隔离，换地址或换浏览器就丢设置；
 * 引擎是这台机器上的唯一状态中心（DPAPI 密钥、代号表都在它那儿），
 * 所以**机器级偏好跟引擎走**，浏览器这边只做缓存。
 *
 * 一次请求多处复用：BootCinematic（决定播不播）、CanvasWorkbench/CanvasMotion
 * （决定减不减弱动效）、设置页（显示当前值）都从这里拿，**不重复打引擎**。
 *
 * 谁是权威、谁是缓存：
 *   - 引擎 `GET /api/settings` = 权威值；
 *   - 浏览器 localStorage = 缓存，负责"下次启动零延迟"；
 *   - 两者不一致时**以引擎为准**（问完写回缓存）。
 */

import { ENGINE_BASE } from '../../engine-base';
import { engineFetch } from '../../engine-auth';

export interface EngineSettings {
  /** 加载动画：always / first-visit / never */
  readonly bootAnimation?: 'always' | 'first-visit' | 'never';
  /** 减弱动效：强制关掉入场/反馈动画 */
  readonly reduceMotion?: boolean;
}

let cache: EngineSettings | null = null;
let inflight: Promise<EngineSettings | null> | null = null;

/**
 * 「本地缓存已经和引擎核对过」的标记。
 *
 * 没有它 = 本地缓存还没跟引擎比对过（首访、换浏览器、换访问地址），
 * 这时要**先问引擎**再决定按哪份设置走 —— 跨浏览器才能拿到同一份设置。
 * 加载动画与减弱动效共用这一个标记（都是机器级设置，一起核对）。
 */
const SYNCED_KEY = 'cartouche.settings.synced';

export function isEngineSettingsSynced(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SYNCED_KEY) === '1';
  } catch {
    return false;
  }
}

/** 打上"本地缓存已与引擎核对过"的标记：下次启动就可以零延迟用本地值 */
export function markEngineSettingsSynced(): void {
  try {
    window.localStorage.setItem(SYNCED_KEY, '1');
  } catch {
    /* 隐私模式写不了：下次再问一遍引擎就是了 */
  }
}

/**
 * 向引擎问一次机器级设置（问不到返回 null，调用方按本地缓存继续）。
 *
 * 并发调用共享同一次请求 —— BootCinematic 与设置页可能同时要它。
 */
export async function fetchEngineSettings(timeoutMs = 800): Promise<EngineSettings | null> {
  if (typeof window === 'undefined') return null;
  if (inflight) return inflight;
  inflight = (async (): Promise<EngineSettings | null> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await engineFetch(`${ENGINE_BASE}/api/settings`, { signal: controller.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as EngineSettings;
      cache = body;
      return body;
    } catch {
      return null;
    } finally {
      window.clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
}

/** 写回引擎（权威副本）；失败返回 false（本地已生效，不算失败） */
export async function saveEngineSettings(patch: Partial<EngineSettings>): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    const res = await engineFetch(`${ENGINE_BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as EngineSettings;
    cache = body;
    return true;
  } catch {
    return false;
  }
}
