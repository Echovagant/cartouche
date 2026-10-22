'use client';

/**
 * 四道闸门：滚动时逐张"叠"上来（GSAP ScrollTrigger）。
 *
 * 左边标题由 CSS sticky 固定，右边四张卡依次盖住上一张——
 * 视觉上就是"一道接一道关上的闸门"，正好是产品的核心隐喻。
 *
 * ── 这套做法是踩坑换来的，不要随便改 ───────────────────────────
 * - `fromTo`（不是 `from`）：初态写死在 tween 里，初始帧就位，不会闪；
 * - `once: true`：只放一次，不来回重播；
 * - **不用 scrub**：scrub 把进度绑死在滚动位置上，停在段尾时
 *   第 3、4 张卡会永远停在 opacity 0.88 / 0.99 —— 文字发虚，
 *   看着像渲染坏了。堆叠的视觉由 z-index + 负 margin 负责。
 * - 叠压量 18px **必须小于下内边距（pb-11 = 44px）**，
 *   否则后一张卡会把前一张的正文盖掉。
 *
 * 层序（z-index）现在写在 CSS 的 :nth-child 里，不再用内联 style。
 */
import { useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP, ScrollTrigger);

export interface Gate {
  readonly n: string;
  readonly title: string;
  readonly body: string;
}

export function GateStack({ gates }: { gates: readonly Gate[] }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useGSAP(
    () => {
      // matchMedia 而不是挂载时读一次 .matches：
      // 用户中途改系统设置（减少动态效果 / 窗口宽度）也要立刻生效。
      const mm = gsap.matchMedia();

      mm.add('(min-width: 768px) and (prefers-reduced-motion: no-preference)', () => {
        const cards = gsap.utils.toArray<HTMLElement>('[data-gate="card"]');
        cards.forEach((card, index) => {
          if (index === 0) return;
          gsap.fromTo(
            card,
            { y: 44, scale: 0.97, opacity: 0 },
            {
              y: 0,
              scale: 1,
              opacity: 1,
              duration: 0.55,
              ease: 'power2.out',
              // 每张比上一张晚 120ms 落位：闸门是"一道接一道"关上的
              delay: index * 0.12,
              scrollTrigger: {
                trigger: card,
                start: 'top 88%',
                once: true,
              },
            },
          );
        });
      });

      return () => mm.revert();
    },
    { scope: wrapRef },
  );

  return (
    <div ref={wrapRef} className="gate-stack flex flex-col gap-4 md:gap-0">
      {gates.map((g, i) => (
        <article
          key={g.n}
          data-gate="card"
          // 叠压量 18px **必须小于下内边距（pb-11 = 44px）**，
          // 否则后一张卡会把前一张的正文盖掉——这是"堆叠"最常见的翻车点。
          //
          // 第一张不挂 reveal：它本来就不参与入场动画，挂了就是永远隐形。
          className={`relative rounded-panel border border-line bg-surface p-7 pt-7 pb-11 md:-mt-4.5 md:first:mt-0${
            i > 0 ? ' reveal' : ''
          }`}
        >
          <div className="flex items-start gap-5">
            <span className="font-mono text-[13px] tracking-[0.14em] text-accent">{g.n}</span>
            <div>
              <h3 className="font-display text-[19px] leading-snug font-semibold tracking-tight text-ink">
                {g.title}
              </h3>
              <p className="mt-2.5 max-w-[52ch] text-[14.5px] leading-relaxed text-ink-2">{g.body}</p>
            </div>
          </div>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/45 to-transparent"
          />
        </article>
      ))}
    </div>
  );
}
