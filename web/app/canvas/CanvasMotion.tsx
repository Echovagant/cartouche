'use client';

/**
 * 画布的动效编排。
 *
 * 原则（按 gsap-react 技能）：
 *  - 一律用 `useGSAP()`，卸载自动清理；
 *  - **目标一律用显式 ref，不写选择器字符串**。既然不靠选择器，就**不要传 scope**
 *    ——scope 是给选择器用的限定域，而这里的 ref 元素在 scope 之外（首帧甚至还没挂上），
 *    GSAP 会报 "Invalid scope / target null not found" 并放弃动画；
 *  - 只动 transform / opacity，不动 width / height / top / left；
 *  - `prefers-reduced-motion` 时全部退化为不动画（不闪烁、不剥夺功能）；
 *  - 动效只负责"表达状态变化"，不承载任何信息——关掉动效，功能一条不少。
 *
 * 三个编排：
 *  1. **开机**：面板从两侧滑入，图纸从暗处"显影"出来；
 *  2. **图层就位**：地图区做一次曝光扫描，图层卡片逐个落位；
 *  3. **选中**：图纸边框闪一下暖光（像相机快门），属性表内容滑入。
 */
import { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

/** 开机：面板滑入 + 图纸显影 */
export function CanvasBoot({
  leftRef,
  rightRef,
  stageRef,
}: {
  leftRef: React.RefObject<HTMLElement | null>;
  rightRef: React.RefObject<HTMLElement | null>;
  stageRef: React.RefObject<HTMLElement | null>;
}) {
  useGSAP(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    const left = leftRef.current;
    const right = rightRef.current;
    const stage = stageRef.current;
    if (!left || !right || !stage) return;

    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    tl.from(left, { xPercent: -6, autoAlpha: 0, duration: 0.7 })
      .from(stage, { scale: 0.985, autoAlpha: 0, duration: 0.9, ease: 'power4.out' }, '-=0.5')
      .from(right, { xPercent: 6, autoAlpha: 0, duration: 0.7 }, '-=0.75');
  });

  return null;
}

/**
 * 图层就位：每次图层数量变化，做一次"曝光"。
 *
 * 曝光 = 一道暖光沿图纸扫过（纯 transform/opacity），同时新加的图层卡片
 * 从上方落位。它同时在传达两件事：数据到了、视野已经跟过去了。
 */
export function LayerArrival({
  stageRef,
  layerCount,
}: {
  stageRef: React.RefObject<HTMLElement | null>;
  layerCount: number;
}) {
  const sweepRef = useRef<HTMLDivElement | null>(null);
  const first = useRef(true);

  useGSAP(
    () => {
      if (first.current) {
        first.current = false;
        return;
      }
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const sweep = sweepRef.current;
      if (!sweep || reduced) return;

      const tl = gsap.timeline();
      tl.fromTo(
        sweep,
        { yPercent: -120, autoAlpha: 0 },
        { yPercent: 120, autoAlpha: 0.85, duration: 0.85, ease: 'power2.inOut' },
      ).to(sweep, { autoAlpha: 0, duration: 0.35 });
    },
    { dependencies: [layerCount] },
  );

  return (
    <div
      ref={sweepRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 z-30 h-24 opacity-0"
      style={{
        background:
          'linear-gradient(180deg, transparent 0%, rgba(255,241,214,0.16) 45%, rgba(255,241,214,0.04) 70%, transparent 100%)',
      }}
    />
  );
}

/**
 * 选中反馈：图纸边框闪一下暖光。
 *
 * 只在"选中数量从 0 变成 >0"时闪一次；取消选择不闪——
 * 否则用户连续点多个要素时会一直在闪，注意力被抢走。
 */
export function SelectionShutter({
  stageRef,
  selectedCount,
}: {
  stageRef: React.RefObject<HTMLElement | null>;
  selectedCount: number;
}) {
  const prev = useRef(0);

  useGSAP(
    () => {
      const before = prev.current;
      prev.current = selectedCount;
      if (selectedCount <= 0 || before > 0) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const stage = stageRef.current;
      if (reduced || !stage) return;

      gsap.fromTo(
        stage,
        { boxShadow: '0 0 0 0 rgba(255, 201, 138, 0)' },
        {
          boxShadow: '0 0 0 2px rgba(255, 201, 138, 0.85), 0 0 26px 2px rgba(255, 201, 138, 0.32)',
          duration: 0.18,
          ease: 'power2.out',
          yoyo: true,
          repeat: 1,
          clearProps: 'boxShadow',
        },
      );
    },
    { dependencies: [selectedCount] },
  );

  return null;
}

/**
 * 出图瞬间：纸张"显影"一下。
 *
 * 导出 PDF 时前端要把画布合成 JPEG 再发引擎，这期间用户是干等着。
 * 一道从左到右的显影光带说明"正在出图"，比转圈更有信息量。
 */
export function ExportDevelop({
  stageRef,
  active,
}: {
  stageRef: React.RefObject<HTMLElement | null>;
  active: boolean;
}) {
  const bandRef = useRef<HTMLDivElement | null>(null);

  useGSAP(
    () => {
      const band = bandRef.current;
      if (!active || !band) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) return;

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.25 });
      tl.fromTo(
        band,
        { xPercent: -110, autoAlpha: 0 },
        { xPercent: 110, autoAlpha: 0.9, duration: 0.9, ease: 'power1.inOut' },
      ).to(band, { autoAlpha: 0, duration: 0.2 });
    },
    { dependencies: [active] },
  );

  return (
    <div
      ref={bandRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-0 z-30 w-1/3 opacity-0"
      style={{
        background:
          'linear-gradient(90deg, transparent 0%, rgba(255,241,214,0.22) 50%, transparent 100%)',
      }}
    />
  );
}
