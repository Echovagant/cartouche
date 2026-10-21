'use client';

/**
 * 磁性按钮。
 *
 * 鼠标靠近时按钮被轻轻"吸"过去 —— 用 GSAP 的 quickTo，
 * **不经过 React 状态**，所以不会触发任何重渲染（移动端也不会掉帧）。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import gsap from 'gsap';

interface MagneticProps {
  className?: string;
  children: ReactNode;
  /** 吸力上限系数（相对自身尺寸） */
  strength?: number;
}

/** 把"吸"这套逻辑挂到任意元素上 */
function useMagnetic<T extends HTMLElement>(strength: number) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 系统开了"减少动态效果"就不做磁性
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const xTo = gsap.quickTo(el, 'x', { duration: 0.45, ease: 'power3.out' });
    const yTo = gsap.quickTo(el, 'y', { duration: 0.45, ease: 'power3.out' });

    const onMove = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      // 吸力上限：最多偏移自身尺寸的 18%，不然会飘得太远
      const limit = Math.max(rect.width, rect.height) * 0.18 * strength;
      xTo(gsap.utils.clamp(-limit, limit, dx * 0.32));
      yTo(gsap.utils.clamp(-limit, limit, dy * 0.32));
    };
    const onLeave = () => {
      xTo(0);
      yTo(0);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
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
