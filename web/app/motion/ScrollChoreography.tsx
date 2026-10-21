'use client';

/**
 * 落地页的滚动编排（GSAP ScrollTrigger）。
 *
 * 只做一件事：**驱动 DOM**。
 * 页面结构在服务端组件里（静态语义），这里用 data 属性定位元素并做编排，
 * 所以 React 不会因为动画而重渲染 —— 所有位移只走 transform / opacity。
 *
 * 严格清理：组件卸载时 kill 掉所有 ScrollTrigger 与时间线。
 */
import { useEffect } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

export function ScrollChoreography() {
  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    const ctx = gsap.context(() => {
      /* ── Hero：进场序列 ── */
      const hero = gsap.timeline({ defaults: { ease: 'power3.out' } });
      hero
        .from('[data-hero="eyebrow"]', { y: 14, opacity: 0, duration: 0.6 })
        .from(
          '[data-hero="title"]',
          { y: 26, opacity: 0, duration: 0.85, ease: 'power4.out' },
          '-=0.35',
        )
        .from('[data-hero="body"]', { y: 18, opacity: 0, duration: 0.7 }, '-=0.5')
        .from('[data-hero="cta"] > *', { y: 14, opacity: 0, duration: 0.55, stagger: 0.09 }, '-=0.42');

      /* ── Bento：错落进入 ── */
      const cells = gsap.utils.toArray<HTMLElement>('[data-bento="cell"]');
      if (cells.length > 0) {
        gsap.from(cells, {
          y: 34,
          opacity: 0,
          duration: 0.75,
          ease: 'power3.out',
          stagger: 0.09,
          scrollTrigger: { trigger: cells[0]!, start: 'top 82%' },
        });
      }

      /* ── 格式列表：逐行落位 ── */
      const items = gsap.utils.toArray<HTMLElement>('[data-stagger="list"] > li');
      if (items.length > 0) {
        gsap.from(items, {
          x: -18,
          opacity: 0,
          duration: 0.5,
          ease: 'power2.out',
          stagger: 0.035,
          scrollTrigger: { trigger: items[0]!, start: 'top 88%' },
        });
      }
    });

    // 字体加载完成后尺寸会变，重新算一次触发点
    const onFonts = () => ScrollTrigger.refresh();
    document.fonts?.ready.then(onFonts).catch(() => undefined);

    return () => {
      document.fonts?.ready.then(onFonts).catch(() => undefined);
      ctx.revert();
    };
  }, []);

  return null;
}
