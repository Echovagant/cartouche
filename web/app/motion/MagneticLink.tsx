'use client';

/**
 * 磁性按钮。
 *
 * 鼠标靠近时按钮被轻轻"吸"过去 —— 用 GSAP 的 quickTo，
 * **不经过 React 状态**，所以不会触发任何重渲染。
 *
 * ── 三个必须修的毛病 ───────────────────────────────────────────
 * 1. **window 级 pointermove**：旧写法给每个磁性按钮各挂一个
 *    window 的 pointermove，一次鼠标移动要算 5 次 getBoundingClientRect。
 *    现在**全站只挂一个 document 级监听**（事件委托），
 *    每次指针移动只读一次坐标，各按钮在自己的 rAF 帧里算。
 * 2. **触屏上按钮被"吸"着走**：触屏滚动时 pointermove 同样会触发，
 *    按钮就跟着手指飘。修法是**只在 (hover: hover) and (pointer: fine)
 *    时启用**——粗指针设备（触屏）直接不挂监听。
 * 3. **pointermove 频率高于帧率**：现在用 requestAnimationFrame 节流，
 *    一帧最多算一次。
 *
 * 另外：`prefers-reduced-motion` 与 hover 能力都用 matchMedia 的
 * change 事件跟随，用户中途改系统设置也生效（不是挂载时读一次 .matches）。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import gsap from 'gsap';

/** 一个磁性目标：元素本身 + 它的 quickTo */
interface MagneticEntry {
  readonly el: HTMLElement;
  readonly strength: number;
  readonly xTo: (v: number) => void;
  readonly yTo: (v: number) => void;
}

/**
 * 全站共享的磁吸运行时。
 *
 * 放在模块作用域而不是组件里：磁吸是"页面级"的副作用，
 * 放在组件里会随组件挂载/卸载反复注册监听。
 */
const entries = new Set<MagneticEntry>();

let pointerHandler: ((event: PointerEvent) => void) | null = null;
let pendingX = 0;
let pendingY = 0;
let frameId = 0;

function flush(): void {
  frameId = 0;
  for (const entry of entries) {
    const rect = entry.el.getBoundingClientRect();
    const dx = pendingX - (rect.left + rect.width / 2);
    const dy = pendingY - (rect.top + rect.height / 2);
    // 吸力上限：最多偏移自身尺寸的 18%，不然会飘得太远
    const limit = Math.max(rect.width, rect.height) * 0.18 * entry.strength;
    // 指针不在元素附近就归位（原来的 pointerleave 等价行为）
    const near =
      Math.abs(dx) < rect.width / 2 + limit * 2 && Math.abs(dy) < rect.height / 2 + limit * 2;
    if (!near) {
      entry.xTo(0);
      entry.yTo(0);
      continue;
    }
    entry.xTo(gsap.utils.clamp(-limit, limit, dx * 0.32));
    entry.yTo(gsap.utils.clamp(-limit, limit, dy * 0.32));
  }
}

function attach(): void {
  if (pointerHandler) return;
  pointerHandler = (event: PointerEvent) => {
    pendingX = event.clientX;
    pendingY = event.clientY;
    // 一帧只算一次
    if (frameId) return;
    frameId = requestAnimationFrame(flush);
  };
  document.addEventListener('pointermove', pointerHandler, { passive: true });
}

function detach(): void {
  if (frameId) {
    cancelAnimationFrame(frameId);
    frameId = 0;
  }
  if (pointerHandler) {
    document.removeEventListener('pointermove', pointerHandler);
    pointerHandler = null;
  }
}

/** 把"吸"这套逻辑挂到任意元素上 */
function useMagnetic<T extends HTMLElement>(strength: number) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // 只有"能精确悬停 + 精细指针"的设备才吸；触屏与 reduced-motion 都关掉
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    const xTo = gsap.quickTo(el, 'x', { duration: 0.45, ease: 'power3.out' });
    const yTo = gsap.quickTo(el, 'y', { duration: 0.45, ease: 'power3.out' });

    const entry: MagneticEntry = { el, strength, xTo, yTo };

    const enable = (): void => {
      if (!finePointer.matches || reduced.matches) {
        entries.delete(entry);
        if (entries.size === 0) detach();
        xTo(0);
        yTo(0);
        return;
      }
      entries.add(entry);
      attach();
    };

    enable();
    // 系统设置中途变了也生效
    finePointer.addEventListener('change', enable);
    reduced.addEventListener('change', enable);

    return () => {
      finePointer.removeEventListener('change', enable);
      reduced.removeEventListener('change', enable);
      entries.delete(entry);
      if (entries.size === 0) detach();
    };
  }, [strength]);

  return ref;
}

export function MagneticLink({
  href,
  className = '',
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useMagnetic<HTMLAnchorElement>(1);
  return (
    <a ref={ref} href={href} className={className}>
      {children}
    </a>
  );
}

export function MagneticButton({
  className = '',
  children,
  strength = 1,
  onClick,
  disabled,
  title,
}: {
  className?: string;
  children: ReactNode;
  strength?: number;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const ref = useMagnetic<HTMLButtonElement>(strength);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={className}
    >
      {children}
    </button>
  );
}
