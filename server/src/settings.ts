/**
 * 机器级偏好（设置页里的"本机设置"）。
 *
 * 存 `%LOCALAPPDATA%\cartouche\settings.json`（配置目录，与 roots.json 同级）。
 *
 * **为什么不能只放浏览器 localStorage**：localStorage 按 **origin + 浏览器**隔离，
 * 而这个工具的访问地址不止一种（`127.0.0.1:8080` / `localhost:8080` /
 * 便携包的 `file://`），用户换一个地址或换一个浏览器，设置就"丢了"——
 * 2026-11-16 用户明确提出过这个担心。引擎是这台机器上的唯一状态中心
 * （DPAPI 密钥、代号表都在它这儿），机器级偏好跟它走才说得通。
 *
 * 浏览器侧仍保留 localStorage 缓存：它负责**首帧零闪屏**（静态导出会预渲染
 * 启动屏标记，得在第一帧就知道要不要播）。引擎是权威，浏览器是缓存：
 * 浏览器没有缓存时向引擎问一次，问完写回缓存并打"已核对"标记。
 *
 * 读写都**不能把引擎搞崩**：文件坏了当没配，写不了只警告。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const configDir =
  process.env.CARTOUCHE_CONFIG_DIR ??
  join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '.', 'cartouche');
const settingsFile = join(configDir, 'settings.json');

/** 加载动画的播放方式（与前端 useBootAnimation.ts 的三态一致） */
export type BootAnimationSetting = 'always' | 'first-visit' | 'never';

export interface CartoucheSettings {
  /** 加载动画：总是播放 / 仅首次访问（默认）/ 从不播放 */
  readonly bootAnimation?: BootAnimationSetting;
  /** 减弱动效：强制关掉所有入场/反馈动画（覆盖系统的 prefers-reduced-motion） */
  readonly reduceMotion?: boolean;
}

function isBootAnimation(value: unknown): value is BootAnimationSetting {
  return value === 'always' || value === 'first-visit' || value === 'never';
}

/** 读回设置；文件不存在或坏了都当「没设过」（用各字段的默认值） */
export function readSettings(): CartoucheSettings {
  try {
    if (!existsSync(settingsFile)) return {};
    const raw = JSON.parse(readFileSync(settingsFile, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return {};
    const obj = raw as { bootAnimation?: unknown; reduceMotion?: unknown };
    return {
      ...(isBootAnimation(obj.bootAnimation) ? { bootAnimation: obj.bootAnimation } : {}),
      ...(typeof obj.reduceMotion === 'boolean' ? { reduceMotion: obj.reduceMotion } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * 合并写入设置（只覆盖给定的字段，其余保留）。
 * 写不了只警告 —— 配置写不了不该挡住用户干活。
 */
export function writeSettings(patch: Partial<CartoucheSettings>): CartoucheSettings {
  const current = readSettings();
  const next: CartoucheSettings = {
    ...current,
    ...(patch.bootAnimation !== undefined ? { bootAnimation: patch.bootAnimation } : {}),
    ...(patch.reduceMotion !== undefined ? { reduceMotion: patch.reduceMotion } : {}),
  };
  try {
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[engine] 设置写入失败：${(err as Error).message}`);
  }
  return next;
}
