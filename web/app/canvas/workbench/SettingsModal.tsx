'use client';

/**
 * 设置（Ctrl+, 或活动栏齿轮）：VS Code 的「设置」位。
 *
 * 四项，都是**本机偏好**，存 localStorage，不进仓库不上传：
 *   - 主题：全站明暗（与导航/状态栏的开关是同一份状态）；
 *   - 加载动画：启动屏与打开项目时的加载反馈，总是播 / 仅首次访问 / 从不播；
 *   - 引擎地址：默认 127.0.0.1:8787；改完刷新页面生效 —— 引擎要真的在那个地址上；
 *   - 减弱动效：覆盖系统的 prefers-reduced-motion（对动效敏感的用户）。
 */
import { useEffect, useState } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { ThemeToggle } from '../ThemeToggle';
import { ActionButton, TextField } from '../ui';
import {
  readReduceMotionOverride,
  setReduceMotionOverride,
} from '../project/useReducedMotion';
import {
  BOOT_ANIMATION_HINTS,
  BOOT_ANIMATION_LABELS,
  applyBootAttr,
  fetchEngineBootMode,
  readBootAnimationMode,
  saveBootModeToEngine,
  setBootAnimationMode,
  type BootAnimationMode,
} from '../project/useBootAnimation';
import { fetchEngineSettings, saveEngineSettings } from '../project/engineSettings';

export interface SettingsModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const BOOT_MODES: readonly BootAnimationMode[] = ['always', 'first-visit', 'never'];

/** 设置弹窗本体：四项偏好在这里读写；打开时先向引擎核对当前生效值再回填，保存后立即生效并同步到引擎。 */
export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [engineBase, setEngineBase] = useState('');
  const [reduceMotion, setReduceMotion] = useState(false);
  const [bootMode, setBootMode] = useState<BootAnimationMode>('first-visit');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    try {
      setEngineBase(window.localStorage.getItem('cartouche.engine-base') ?? '');
    } catch {
      setEngineBase('');
    }
    setReduceMotion(readReduceMotionOverride());
    setBootMode(readBootAnimationMode());
    setSaved(false);
    // 本地缓存还没跟引擎核对过（换浏览器 / 换访问地址）→ 向引擎问一次：
    // 设置页显示的必须是**当前生效**的那份，不能是本地的默认值
    // （否则会出现"设置里写着从不播放、实际却在播"的错觉）。
    void fetchEngineSettings(800).then((settings) => {
      if (!settings) return;
      if (settings.bootAnimation) setBootMode(settings.bootAnimation);
      if (typeof settings.reduceMotion === 'boolean') setReduceMotion(settings.reduceMotion);
    });
  }, [open]);

  if (!open) return null;

  const save = (): void => {
    try {
      const trimmed = engineBase.trim();
      if (trimmed === '') window.localStorage.removeItem('cartouche.engine-base');
      else window.localStorage.setItem('cartouche.engine-base', trimmed);
    } catch {
      /* 隐私模式下写不了 */
    }
    setReduceMotionOverride(reduceMotion);
    // 减弱动效也同步到引擎（机器级设置，跨浏览器/换地址都跟着走）
    void saveEngineSettings({ reduceMotion });
    // 加载动画：写完立刻生效（启动屏下一次打开画布时按新设置走；
    // 打开项目时的加载态本次会话内就跟着变），并同步到引擎 ——
    // 引擎是权威副本，换浏览器、换访问地址都跟着走。
    setBootAnimationMode(bootMode);
    applyBootAttr(bootMode);
    void saveBootModeToEngine(bootMode);
    setSaved(true);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      className="fixed inset-0 z-[60] flex items-start justify-center bg-studio/60 px-4 pt-[10vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[520px] border border-studio-line bg-studio-2 shadow-[var(--studio-panel-shadow)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-studio-line px-4 py-3">
          <strong className="font-display text-[14px] font-semibold text-studio-ink">设置</strong>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭设置"
            className="flex h-8 w-8 items-center justify-center rounded-md text-studio-ink-3 transition-colors hover:bg-studio-3 hover:text-studio-ink"
          >
            <XIcon size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="flex flex-col gap-5 px-4 py-4">
          {/* 主题 */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[13px] font-medium text-studio-ink">主题</div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-studio-ink-3">
                全站（官网、画布、AI 工作台）跟着这个开关走。
              </p>
            </div>
            <ThemeToggle />
          </div>

          {/* 加载动画 */}
          <div>
            <div className="text-[13px] font-medium text-studio-ink">加载动画</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-studio-ink-3">
              打开画布时的启动屏，以及打开项目时的加载反馈。改完立即生效。
            </p>
            <div
              role="radiogroup"
              aria-label="加载动画"
              className="mt-2 inline-flex overflow-hidden rounded-md border border-studio-line"
            >
              {BOOT_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={bootMode === mode}
                  onClick={() => setBootMode(mode)}
                  className={`px-3 py-1.5 font-mono text-[11.5px] transition-colors ${
                    bootMode === mode
                      ? 'bg-accent text-paper'
                      : 'text-studio-ink-2 hover:bg-studio-3 hover:text-studio-ink'
                  } ${mode === BOOT_MODES[0] ? '' : 'border-l border-studio-line'}`}
                >
                  {BOOT_ANIMATION_LABELS[mode]}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-studio-ink-3">
              {BOOT_ANIMATION_HINTS[bootMode]}
            </p>
          </div>

          {/* 引擎地址 */}
          <div>
            <label htmlFor="setting-engine" className="block text-[13px] font-medium text-studio-ink">
              引擎地址
            </label>
            <p className="mt-0.5 text-[12px] leading-relaxed text-studio-ink-3">
              引擎跑在本机（默认 <code className="font-mono">127.0.0.1:8787</code>）。
              改了地址就保存，刷新页面后生效 —— 前提是那个地址上真的有引擎在跑。
            </p>
            <TextField
              id="setting-engine"
              value={engineBase}
              onChange={(event) => setEngineBase(event.target.value)}
              placeholder="http://127.0.0.1:8787"
              className="mt-2 h-9 w-full font-mono"
            />
          </div>

          {/* 减弱动效 */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[13px] font-medium text-studio-ink">减弱动效</div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-studio-ink-3">
                勾上后所有入场/反馈动画直接退化为不动画（覆盖系统设置）。
              </p>
            </div>
            <input
              type="checkbox"
              checked={reduceMotion}
              onChange={(event) => setReduceMotion(event.target.checked)}
              className="h-4 w-4 accent-[#2f6f5e]"
            />
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-studio-line px-4 py-3">
          <span className="text-[12px] text-studio-ink-3">
            {saved
              ? '已保存 —— 引擎地址与动效设置刷新页面后生效'
              : '加载动画与减弱动效存在本机引擎上（换浏览器、换地址都跟着走）；主题存在浏览器里。都不上传。'}
          </span>
          <div className="flex items-center gap-2">
            <ActionButton variant="ghost" onClick={onClose}>
              关闭
            </ActionButton>
            <ActionButton variant="primary" onClick={save}>
              保存
            </ActionButton>
          </div>
        </div>
      </div>
    </div>
  );
}
