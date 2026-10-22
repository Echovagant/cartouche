'use client';

/**
 * 落地页的滚动编排（GSAP ScrollTrigger）。
 *
 * 只做一件事：**驱动 DOM**。
 * 页面结构在服务端组件里（静态语义），这里用 data 属性定位元素并做编排，
 * 所以 React 不会因为动画而重渲染 —— 所有位移只走 transform / opacity。
 *
 * ── 三条硬规矩 ─────────────────────────────────────────────────
 * 1. **不 pin、不接管滚轮、不 scrub**（项目实测踩过的坑）。
 *    每个 ScrollTrigger 都是 once: true，一次放完就收工。
 * 2. **只动 transform + opacity**，移动幅度上限 34px。
 * 3. **`gsap.from` 一律不用**，改 `fromTo`：
 *    from 的初态是 JS 挂载后才设的，JS 慢一点内容会先可见再消失。
 *    初态写在 CSS 的 `.reveal { opacity: 0 }` 里，fromTo 从同一个值起步，
 *    两者对得上，就不会有闪。
 *
 * `prefers-reduced-motion` 用 **gsap.matchMedia()** 而不是挂载时读一次
 * `.matches` —— 用户中途改系统设置也要立刻生效。
 *
 * 字体加载完成后尺寸会变，触发点要重算 —— 这件事**全站只在这里做一次**
 * （以前 ScrollChoreography 做一次、Deliverables 没人做，触发点算不准）。
 */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP, ScrollTrigger);

export function ScrollChoreography() {
  useGSAP(() => {
    const mm = gsap.matchMedia();

    /* ── 导航换皮：深色段进出时切 <html data-surface> ──────────────
       玻璃导航在纸面上是浅色玻璃，压到墨面上必须换皮（否则发灰、
       描边也读不出来）。这是官网唯一的分段开关。 */
    const setSurface = (surface: 'light' | 'dark'): void => {
      document.documentElement.dataset.surface = surface;
    };
    setSurface('light');

    const surfaceSections = gsap.utils.toArray<HTMLElement>('[data-surface-section]');
    surfaceSections.forEach((el) => {
      ScrollTrigger.create({
        trigger: el,
        start: 'top 72px',
        end: 'bottom 72px',
        onToggle: (self) => {
          const wanted = (el.dataset.surfaceSection ?? 'light') === 'dark' ? 'dark' : 'light';
          setSurface(self.isActive ? wanted : 'light');
        },
      });
    });

    mm.add('(prefers-reduced-motion: no-preference)', () => {
      /* ── 段头：统一的浅入场（S2 / S3 / S8 各自有编排，不走这里） ── */
      const heads = gsap.utils.toArray<HTMLElement>('[data-section-head]');
      heads.forEach((head) => {
        gsap.fromTo(
          head,
          { y: 10, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.6,
            ease: 'power3.out',
            scrollTrigger: { trigger: head, start: 'top 85%', once: true },
          },
        );
      });

      /* ── S1 Hero：加载即播（不滚） ───────────────────────────────
         eyebrow 0 → h1 +350 → 副标 +250 → CTA +90×2 → 图幅 +120
         位移 14 / 26 / 18 / 14 / 0（图幅只淡入） */
      const hero = gsap.timeline({ defaults: { ease: 'power3.out' } });
      hero
        .fromTo(
          '[data-hero="eyebrow"]',
          { y: 14, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.6 },
          0,
        )
        .fromTo(
          '[data-hero="title"]',
          { y: 26, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.85, ease: 'power4.out', immediateRender: true },
          0.35,
        )
        .fromTo(
          '[data-hero="body"]',
          { y: 18, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.7, immediateRender: true },
          0.6,
        )
        .fromTo(
          '[data-hero="cta"] > *',
          { y: 14, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.55, stagger: 0.09, immediateRender: true },
          0.69,
        )
        .fromTo(
          '[data-hero="figure"]',
          { opacity: 0 },
          { opacity: 1, duration: 0.9, ease: 'power2.out', immediateRender: true },
          0.9,
        );

      /* ── S2 确认卡：top 75%，once ───────────────────────────────
         段头 0 → 截图容器 +120 → 四行数字 +260 起、每行 120ms → 注解 +200
         位移 8–10px，时长 0.5–0.7s */
      const s2Head = gsap.utils.toArray<HTMLElement>('[data-s2="head"]');
      if (s2Head.length > 0) {
        gsap
          .timeline({
            scrollTrigger: { trigger: s2Head[0]!, start: 'top 75%', once: true },
          })
          .fromTo(
            '[data-s2="head"]',
            { y: 10, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.6, ease: 'power3.out', immediateRender: true },
            0,
          )
          .fromTo(
            '[data-s2="container"]',
            { y: 10, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.6, ease: 'power3.out', immediateRender: true },
            0.12,
          )
          .fromTo(
            '[data-confirm-row]',
            { y: 8, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.5, stagger: 0.12, ease: 'power2.out', immediateRender: true },
            0.26,
          )
          .fromTo(
            '[data-s2="caption"]',
            { y: 8, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.5, ease: 'power2.out', immediateRender: true },
            0.46,
          );
      }

      /* ── S3 呼吸段：top 70%，once ───────────────────────────────
         否定句 0 → 巨号数字 +300（y 24→0）→ 解释行 +180。
         数字**不做 count-up**：终值直接给出来。 */
      const s3 = gsap.utils.toArray<HTMLElement>('[data-s3="denial"]');
      if (s3.length > 0) {
        gsap
          .timeline({
            scrollTrigger: { trigger: s3[0]!, start: 'top 70%', once: true },
          })
          .fromTo(
            '[data-s3="denial"]',
            { opacity: 0 },
            { opacity: 1, duration: 0.5, ease: 'power2.out' },
            0,
          )
          .fromTo(
            '[data-s3="figure"]',
            { y: 24, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.8, ease: 'power3.out', immediateRender: true },
            0.3,
          )
          .fromTo(
            '[data-s3="note"]',
            { opacity: 0 },
            { opacity: 1, duration: 0.4, ease: 'power2.out', immediateRender: true },
            0.48,
          );
      }

      /* ── S6 三步：top 82%，once ─────────────────────────────────
         三步错峰 140ms；每步内代码块 +100（x -12→0） */
      const steps = gsap.utils.toArray<HTMLElement>('[data-step="item"]');
      steps.forEach((step, index) => {
        gsap
          .timeline({
            delay: index * 0.14,
            scrollTrigger: { trigger: step, start: 'top 82%', once: true },
          })
          .fromTo(
            step,
            { y: 28, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.6, ease: 'power3.out', immediateRender: true },
          )
          .fromTo(
            step.querySelector('[data-step="code"]'),
            { x: -12, opacity: 0 },
            { x: 0, opacity: 1, duration: 0.5, ease: 'power2.out', immediateRender: true },
            0.1,
          );
      });

      /* ── S7 格式窄带：top 88% ───────────────────────────────────
         三组错峰 90ms；组内格式名逐行 stagger 35ms（x -18→0） */
      const groups = gsap.utils.toArray<HTMLElement>('[data-format="group"]');
      groups.forEach((group, index) => {
        const tl = gsap.timeline({
          delay: index * 0.09,
          scrollTrigger: { trigger: group, start: 'top 88%', once: true },
        });
        /* 组本身只淡入；位移留给组内的格式名（-18px）。
           组与行都是 -18 会叠成 -36，超出全站 34px 的位移上限。 */
        tl.fromTo(
          group,
          { opacity: 0 },
          { opacity: 1, duration: 0.45, ease: 'power2.out', immediateRender: true },
        ).fromTo(
          group.querySelectorAll('[data-format="row"]'),
          { x: -18 },
          { x: 0, duration: 0.45, stagger: 0.035, ease: 'power2.out', immediateRender: true },
          0.06,
        );
      });

      /* ── S8 收尾：top 85%，once ─────────────────────────────────
         下载面板 0 → 4 条 About +100 错峰 → 图签框特写 +200（不做位移） */
      const s8 = gsap.utils.toArray<HTMLElement>('[data-s8="panel"]');
      if (s8.length > 0) {
        gsap
          .timeline({
            scrollTrigger: { trigger: s8[0]!, start: 'top 85%', once: true },
          })
          .fromTo(
            '[data-s8="panel"]',
            { y: 16, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.6, ease: 'power3.out', immediateRender: true },
            0,
          )
          .fromTo(
            '[data-s8="about"]',
            { y: 16, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.55, stagger: 0.1, ease: 'power3.out', immediateRender: true },
            0.1,
          )
          .fromTo(
            '[data-s8="closeup"]',
            { opacity: 0 },
            { opacity: 1, duration: 0.6, ease: 'power2.out', immediateRender: true },
            0.3,
          );
      }
    });

    /* ── 字体加载完成后重算触发点（全站只此一处） ──────────────── */
    const onFonts = (): void => ScrollTrigger.refresh();
    document.fonts?.ready.then(onFonts).catch(() => undefined);

    return () => {
      mm.revert();
      document.fonts?.ready.then(onFonts).catch(() => undefined);
    };
  });

  return null;
}
