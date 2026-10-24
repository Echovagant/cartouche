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

/**
 * GSAP 默认的 lagSmoothing 必须关掉。
 *
 * 默认值是 lagSmoothing(500, 33)：**只要某一帧的间隔超过 500ms，
 * 这一帧就按 33ms 记**（本意是防止切回标签页时动画"瞬移"）。
 * 但机器一忙（rAF 帧间隔轻松超过 500ms），1.75s 的首屏时间轴
 * 就被拖成几十秒 —— 首屏左栏（眉标 / 字标 / H1 / 事实条 / CTA）
 * 整整一列停在 opacity 0，用户看到的是**一张空白的首屏**。
 *
 * 实测（2026-10-23）：同一份代码，机器空闲时首屏正常；
 * 同一时刻有栅格处理任务在跑时，首屏整列隐形 3.5 秒以上。
 * 关掉它，时间轴按真实经过时间推进，帧再慢也在 1.75s 内放完。
 */
gsap.ticker.lagSmoothing(0);

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
         逐拍（规格 §3.2 的 B1–B7，代码照抄）：
           B1 eyebrow      0.00 → 0.60  y 14 → 0
           B2 wordmark     0.20 → 1.05  y 26 → 0  power4.out
           B3 h1 断言      0.45 → 1.15  y 18 → 0
           B4 四条事实     0.54 → 1.09  y 14 → 0  stagger 0.09
           B5 两个 CTA     0.70 → 1.15  opacity
           B6 确认卡落定   0.95 → 1.50  y 12 → 0
           B7 滚动提示     0.95 → 1.50  opacity
         **B0（成品图面）没有入场动画**：第一帧就是一张完整可看的图。
         旧实现把主图放在 t=0.9 才淡入（duration 0.9），那一拍已经删掉——
         「首帧即高潮」，等 0.9 秒才出图等于开场什么都没发生。
         B6 原来画的是外层 CSS 图框；换成图签自己出的中国图面后，
         图面自带图框（工具画的），再套一层会重影 —— 改成确认卡落下。 */
      const hero = gsap.timeline({ defaults: { ease: 'power3.out' } });
      hero
        .fromTo(
          '[data-hero="eyebrow"]',
          { y: 14, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.6, immediateRender: true },
          0,
        )
        .fromTo(
          '[data-hero="wordmark"]',
          { y: 26, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.85, ease: 'power4.out', immediateRender: true },
          0.2,
        )
        .fromTo(
          '[data-hero="claim"]',
          { y: 18, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.7, immediateRender: true },
          0.45,
        )
        .fromTo(
          '[data-hero="fact"]',
          { y: 14, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.55, stagger: 0.09, immediateRender: true },
          0.54,
        )
        .fromTo(
          '[data-hero="cta"]',
          { opacity: 0 },
          { opacity: 1, duration: 0.45, ease: 'power2.out', immediateRender: true },
          0.7,
        )
        .fromTo(
          '[data-hero="card"]',
          { y: 12, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.55, ease: 'power3.out', immediateRender: true },
          0.95,
        )
        .fromTo(
          '[data-hero="caption"]',
          { y: 10, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.55, ease: 'power3.out', immediateRender: true },
          1.0,
        )
        .fromTo(
          '[data-hero="scrollhint"]',
          { opacity: 0 },
          { opacity: 1, duration: 0.55, ease: 'power2.out', immediateRender: true },
          0.95,
        );

      /* ── S2 确认卡：top 75%，once ───────────────────────────────
         段头 0 → 真实截图 +120 → 三行解读 +260 起、每行 120ms
         位移 8–10px，时长 0.5–0.6s */
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
            '[data-s2="figure"]',
            { y: 10, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.6, ease: 'power3.out', immediateRender: true },
            0.12,
          )
          .fromTo(
            '[data-s2="note"]',
            { y: 8, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.5, stagger: 0.12, ease: 'power2.out', immediateRender: true },
            0.26,
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
          )
          .fromTo(
            '[data-s3="source"]',
            { opacity: 0 },
            { opacity: 1, duration: 0.4, ease: 'power2.out', immediateRender: true },
            0.6,
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

      /* ── 一句话改图（分工屏）：top 82%，once ───────────────────────
         三栏错峰 120ms；每栏淡入 + 位移 14px（不超全站 34px 上限）。
         卡片自带 .reveal（初态 opacity 0），所以**必须**有这条编排，
         否则它们会一直隐身（CSS 里 .reveal 就是 opacity: 0）。 */
      const aiRoles = gsap.utils.toArray<HTMLElement>('[data-ai-role="card"]');
      aiRoles.forEach((card, index) => {
        gsap.fromTo(
          card,
          { y: 14, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.6,
            ease: 'power3.out',
            delay: index * 0.12,
            immediateRender: true,
            scrollTrigger: { trigger: card, start: 'top 82%', once: true },
          },
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

    /* ── 首屏看门狗：首屏永远不能是空的 ─────────────────────────
       动画有可能根本没跑：浏览器冻结 rAF（后台标签页、页面不可见）、
       脚本被拦截、插件打架……首屏是用户看到的第一件事，
       不能因为一条动画没放出来就让人对着空白。
       2.5 秒后还停在 opacity 0 的首屏元素，直接放出来。
       （正常路径下这里什么都不做：元素早就是 opacity 1。） */
    const heroGuard = window.setTimeout(() => {
      const stuck = gsap.utils.toArray<HTMLElement>('[data-hero]').filter(
        (el) => parseFloat(getComputedStyle(el).opacity) < 0.92,
      );
      if (stuck.length === 0) return;
      gsap.set(stuck, { opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1 });
    }, 2500);

    /* ── 字体加载完成后重算触发点（全站只此一处） ──────────────── */
    const onFonts = (): void => ScrollTrigger.refresh();
    document.fonts?.ready.then(onFonts).catch(() => undefined);

    return () => {
      window.clearTimeout(heroGuard);
      mm.revert();
      document.fonts?.ready.then(onFonts).catch(() => undefined);
    };
  });

  return null;
}
