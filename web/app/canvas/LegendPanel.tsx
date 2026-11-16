'use client';

/**
 * 图例面板（屏幕上的**界面**，不是画布像素）。
 *
 * 为什么不再画进画布（2026-11-16 用户裁定）：
 *   图例是"给人看的说明"，不是图像的一部分。画在画布上会：
 *     ① 挡住正在编辑的图像（编辑区域最不能被遮挡）；
 *     ② 跟着缩放跑位，用户想看清某个图层时它正好压在图上；
 *     ③ 透明度不可调 —— 压在图上的说明要么全挡要么全藏。
 *   现在它是**独立的 DOM 层**（z-index 高于地图画布，不在同一个 canvas 上），
 *   用户可以拖到任何位置、可以调透明度、可以折叠起来。
 *
 * 导出不受影响：PDF/JPEG 走的是完整版式（图例照旧进图面），
 * 见 sheet.ts 的 drawSheet 与 MapCanvas 的 exportJpeg。
 *
 * 位置、透明度、折叠状态存在**本机浏览器**（localStorage）：
 *   这是"这块屏幕上我习惯把图例放哪"的界面偏好，跟着这台机器走，不上传。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface LegendItem {
  readonly name: string;
  readonly color: string;
}

const STORAGE_KEY = 'cartouche.legend.panel.v1';

/** 位置用**相对容器的比例**存：换个屏幕尺寸，图例还在同一个相对地方 */
interface LegendPanelState {
  /** 左上角位置，0~1 的比例 */
  readonly x: number;
  readonly y: number;
  /** 不透明度 0.2~1 */
  readonly opacity: number;
  readonly collapsed: boolean;
  readonly hidden: boolean;
}

const DEFAULT_STATE: LegendPanelState = { x: 0.02, y: 0.72, opacity: 0.92, collapsed: false, hidden: false };

function readState(): LegendPanelState {
  if (typeof window === 'undefined') return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<LegendPanelState>;
    return {
      x: typeof parsed.x === 'number' && parsed.x >= 0 && parsed.x <= 1 ? parsed.x : DEFAULT_STATE.x,
      y: typeof parsed.y === 'number' && parsed.y >= 0 && parsed.y <= 1 ? parsed.y : DEFAULT_STATE.y,
      opacity:
        typeof parsed.opacity === 'number' && parsed.opacity >= 0.2 && parsed.opacity <= 1
          ? parsed.opacity
          : DEFAULT_STATE.opacity,
      collapsed: parsed.collapsed === true,
      hidden: parsed.hidden === true,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function writeState(state: LegendPanelState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* 隐私模式下写不了：本次会话内仍然能用 */
  }
}

export interface LegendPanelProps {
  /** 图层条目（可见图层） */
  readonly items: readonly LegendItem[];
  /** 位置参照的容器（画布容器）—— 拖动时按它的尺寸换算比例 */
  readonly containerRef: React.RefObject<HTMLElement | null>;
}

export function LegendPanel({ items, containerRef }: LegendPanelProps) {
  const [state, setState] = useState<LegendPanelState>(DEFAULT_STATE);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

  // 挂载后读一次真实值（首帧的默认值不能覆盖用户存的位置）
  useEffect(() => {
    setState(readState());
  }, []);

  const update = useCallback((patch: Partial<LegendPanelState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      writeState(next);
      return next;
    });
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // 只从标题条发起拖动：面板里的滑杆与按钮不该触发拖动
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      dragRef.current = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left - state.x * rect.width,
        offsetY: event.clientY - rect.top - state.y * rect.height,
      };
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
      event.preventDefault();
    },
    [containerRef, state.x, state.y],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const container = containerRef.current;
      if (!drag || !container || drag.pointerId !== event.pointerId) return;
      const rect = container.getBoundingClientRect();
      const x = (event.clientX - rect.left - drag.offsetX) / Math.max(1, rect.width);
      const y = (event.clientY - rect.top - drag.offsetY) / Math.max(1, rect.height);
      // 夹在容器内：拖出去就找不回来了
      update({
        x: Math.min(0.96, Math.max(0, x)),
        y: Math.min(0.96, Math.max(0, y)),
      });
    },
    [containerRef, update],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }, []);

  if (state.hidden) {
    return (
      <button
        type="button"
        onClick={() => update({ hidden: false })}
        className="absolute bottom-3 left-3 z-20 rounded border border-studio-line bg-studio-2/85 px-2 py-1 font-mono text-[11px] text-studio-ink-2 transition-colors hover:border-studio-ink-3 hover:text-studio-ink"
        title="显示图例"
      >
        图例
      </button>
    );
  }

  return (
    <div
      className="absolute z-20 w-[190px] select-none rounded border border-studio-line bg-studio-2/92 shadow-[var(--studio-panel-shadow)]"
      style={{
        left: `${state.x * 100}%`,
        top: `${state.y * 100}%`,
        opacity: state.opacity,
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* 标题条：拖这里挪位置 */}
      <div
        onPointerDown={onPointerDown}
        className="flex cursor-grab items-center gap-1.5 border-b border-studio-line px-2 py-1.5 active:cursor-grabbing"
        title="拖动挪位置"
      >
        <span className="font-mono text-[10.5px] tracking-[0.14em] text-studio-ink-3">图例</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => update({ collapsed: !state.collapsed })}
          className="rounded px-1 font-mono text-[10.5px] text-studio-ink-3 transition-colors hover:text-studio-ink"
          title={state.collapsed ? '展开' : '折叠'}
          aria-label={state.collapsed ? '展开图例' : '折叠图例'}
        >
          {state.collapsed ? '▸' : '▾'}
        </button>
        <button
          type="button"
          onClick={() => update({ hidden: true })}
          className="rounded px-1 font-mono text-[10.5px] text-studio-ink-3 transition-colors hover:text-studio-ink"
          title="隐藏图例"
          aria-label="隐藏图例"
        >
          ✕
        </button>
      </div>

      {state.collapsed ? null : (
        <>
          <ul className="max-h-[160px] overflow-y-auto px-2 py-1.5">
            {items.length === 0 ? (
              <li className="py-1 font-mono text-[11px] text-studio-ink-3">没有可见图层</li>
            ) : (
              items.map((item) => (
                <li key={item.name} className="flex items-center gap-2 py-[3px]">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{ background: item.color }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-studio-ink-2" title={item.name}>
                    {item.name}
                  </span>
                </li>
              ))
            )}
          </ul>

          {/* 透明度：压在图上的说明要能淡到不挡事 */}
          <div className="flex items-center gap-2 border-t border-studio-line px-2 py-1.5">
            <span className="font-mono text-[10.5px] text-studio-ink-3">透明</span>
            <input
              type="range"
              min={20}
              max={100}
              step={5}
              value={Math.round(state.opacity * 100)}
              onChange={(event) => update({ opacity: Number(event.target.value) / 100 })}
              className="h-1 flex-1 accent-[#2f6f5e]"
              aria-label="图例透明度"
            />
            <span className="tnum w-8 text-right font-mono text-[10.5px] text-studio-ink-3">
              {Math.round(state.opacity * 100)}%
            </span>
          </div>
        </>
      )}
    </div>
  );
}
