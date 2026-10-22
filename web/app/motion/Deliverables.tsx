'use client';

/**
 * 交付物三件实物（S5）。
 *
 * 之前这里是 GSAP ScrollTrigger 的 **pin + 横向位移**（滚动时卡片横着走）。
 * 实测下来有两个问题，都不值得留：
 *   1. 固定高度 580px 的容器放不下卡片，底部被视口截掉，看起来像"被拉伸"；
 *   2. 横向位移会**接管滚轮**，页面在那一段不能正常上下滚。
 * 现在改成普通的响应式网格：内容一样，滚轮就是滚轮。
 *
 * ── 三张图都是真的 ─────────────────────────────────────────────
 *  - canvas-frame.jpg  出图工作台的实拍（1578×802）
 *  - report.jpg        六段式自检报告的实拍（1400×702）
 *  - export-pdf.png    **引擎自己导出的**那一份单页 PDF 的首页
 *                      （引擎 /api/render/raster.png 出图 → 引擎
 *                        /api/export/pdf 封 PDF → 首页栅格化）
 *
 * 手绘的示意 SVG 已经全部删掉：示意图里的面积、坐标、操作人、日期
 * 都是编的，而用户明确要求「不伪造数据」。
 * 保留的只有**入场动画**（滚到时逐张淡入上移）——它不接管滚动。
 */
import { useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP, ScrollTrigger);

interface Deliverable {
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly body: string;
  /** 一行等宽事实：这件东西到底是什么 */
  readonly fact: string;
}

const ITEMS: readonly Deliverable[] = [
  {
    src: './site/canvas-frame.jpg',
    alt: '出图工作台：栅格与矢量叠在图框中，图名、操作人、图例、比例尺与出图时间都印在图面上',
    width: 1578,
    height: 802,
    title: '工作台：栅格与矢量同屏',
    body: '图层叠在同一个图框里看，图名、图例、比例尺、出图时间印在图面上，不用切窗口对图。',
    fact: '图框 · 图例 · 比例尺 · 标题栏',
  },
  {
    src: './site/report.jpg',
    alt: '兼容性自检报告：文件格式、坐标系、几何有效性、伴随文件、在 ArcGIS 里打开要注意什么、量化摘要',
    width: 1400,
    height: 702,
    title: '六段式自检报告',
    body: '文件格式、坐标系、几何有效性、伴随文件、在 ArcGIS 里打开要注意什么、量化摘要——六段逐条写清。',
    fact: '六段自检 · 未发现阻断',
  },
  {
    src: './site/export-pdf.png',
    alt: '引擎导出的单页 PDF 首页：A4 横版，图框内是 Natural Earth 栅格的真实渲染',
    width: 1053,
    height: 745,
    title: '单页 PDF 图件',
    body: '当前视口封成单页 PDF，图框一起出，比例尺按缩放后的真实情况标，不用再套一遍模板。',
    fact: 'A4 横版 · 单页 · 150 DPI',
  },
];

export function Deliverables() {
  const gridRef = useRef<HTMLDivElement | null>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const items = gsap.utils.toArray<HTMLElement>('[data-deliverable="item"]');
        items.forEach((item, index) => {
          const tl = gsap.timeline({
            // 每件比上一件晚 140ms：这三件是要**看清**的，不是扫一眼就过
            delay: index * 0.14,
            scrollTrigger: { trigger: item, start: 'top 80%', once: true },
          });
          tl.fromTo(
            item,
            { y: 28, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.7, ease: 'power3.out' },
          )
            .fromTo(
              item.querySelector('[data-deliverable="image"]'),
              { opacity: 0 },
              { opacity: 1, duration: 0.45, ease: 'power2.out' },
              0,
            )
            .fromTo(
              item.querySelector('[data-deliverable="title"]'),
              { opacity: 0 },
              { opacity: 1, duration: 0.45, ease: 'power2.out', immediateRender: true },
              0.08,
            )
            .fromTo(
              item.querySelector('[data-deliverable="body"]'),
              { opacity: 0 },
              { opacity: 1, duration: 0.45, ease: 'power2.out', immediateRender: true },
              0.14,
            )
            .fromTo(
              item.querySelector('[data-deliverable="fact"]'),
              { opacity: 0 },
              { opacity: 1, duration: 0.45, ease: 'power2.out', immediateRender: true },
              0.2,
            );
        });
      });

      return () => mm.revert();
    },
    { scope: gridRef },
  );

  return (
    <div
      ref={gridRef}
      className="container-deliverables relative z-10 mx-auto mt-12 max-w-[1440px] px-5 sm:px-8"
    >
      <div className="deliverables-grid">
        {ITEMS.map((item) => (
          <article
            key={item.src}
            data-deliverable="item"
            className="reveal flex flex-col rounded-panel border border-ink-line bg-ink-surface p-6"
          >
            <figure
              data-deliverable="image"
              className="aspect-[4/3] overflow-hidden rounded-lg border border-ink-line bg-ink/60 p-3"
            >
              <img
                src={item.src}
                alt={item.alt}
                width={item.width}
                height={item.height}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-contain"
              />
            </figure>

            <h3
              data-deliverable="title"
              className="mt-6 font-display text-display-3 text-paper"
            >
              {item.title}
            </h3>
            <p
              data-deliverable="body"
              className="mt-3 max-w-[40ch] text-body-sm leading-relaxed text-paper/85"
            >
              {item.body}
            </p>

            {/* 一行等宽事实：这件东西到底是什么 */}
            <p
              data-deliverable="fact"
              className="mt-auto pt-6 font-mono text-mono-data text-accent-lit tnum"
            >
              {item.fact}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
