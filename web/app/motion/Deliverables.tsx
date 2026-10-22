'use client';

/**
 * 交付物三联卡。
 *
 * 原本这里是 GSAP ScrollTrigger 的 **pin + 横向位移**（滚动时卡片横着走）。
 * 实测下来有两个问题，都不值得留：
 *   1. 固定高度 580px 的容器放不下卡片，底部被视口截掉，看起来像"被拉伸"；
 *   2. 横向位移会**接管滚轮**，页面在那一段不能正常上下滚。
 * 现在改成普通的响应式网格：内容一样，滚轮就是滚轮。
 *
 * 保留的只有**入场动画**（滚到时逐张淡入上移）——它不接管滚动。
 */
import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { FilePdfIcon, ShieldCheckIcon, StackIcon } from '@phosphor-icons/react';

/** 干净数据文件：属性表 + 备份条 */
function FilePreview() {
  return (
    <div className="font-mono text-[10.5px] leading-[1.5]">
      <div className="mb-2 flex items-center gap-2 text-paper/45">
        <span className="text-accent">▸</span> scan-2024.tff + .tfw + .prj
      </div>
      <div className="rounded border border-paper/10">
        {[
          ['名称', '测试图斑'],
          ['编码', '1024'],
          ['面积', '1 284.6 m²'],
        ].map(([k, v]) => (
          <div
            key={k}
            className="flex justify-between border-b border-paper/8 px-2.5 py-1.5 last:border-b-0"
          >
            <span className="text-paper/45">{k}</span>
            <span className="text-paper/80">{v}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 text-accent/80">备份 scan-2024.tff.20261021-1052.bak 已生成</div>
    </div>
  );
}

/** PDF 图件：缩略的图幅 */
function SheetPreview() {
  return (
    <svg viewBox="0 0 320 150" className="h-full w-full" aria-hidden="true">
      <rect x="6" y="6" width="308" height="138" fill="#fcfaf5" fillOpacity="0.94" />
      <rect x="14" y="14" width="292" height="122" fill="none" stroke="#1c1a16" strokeOpacity="0.3" />
      <path
        d="M14 96c40-22 62 12 104-6s72-34 116-10 62 16 72 8"
        fill="none"
        stroke="#1c1a16"
        strokeOpacity="0.22"
      />
      <path d="M60 40l84-9 8 58-88 7z" fill="#2f6f5e" fillOpacity="0.18" stroke="#2f6f5e" strokeOpacity="0.55" />
      <rect x="196" y="88" width="104" height="42" fill="#fff" stroke="#1c1a16" strokeOpacity="0.3" />
      <line x1="196" y1="102" x2="300" y2="102" stroke="#1c1a16" strokeOpacity="0.2" />
      <text x="204" y="99" fontSize="8" fontFamily="ui-sans-serif, sans-serif" fill="#1c1a16" fillOpacity="0.7">
        图签 Cartouche 出图
      </text>
      <text x="204" y="116" fontSize="7" fontFamily="ui-monospace, monospace" fill="#1c1a16" fillOpacity="0.45">
        2026-10-21 · 张三
      </text>
      <rect x="24" y="116" width="26" height="5" fill="#1c1a16" fillOpacity="0.7" />
      <rect x="50" y="116" width="26" height="5" fill="none" stroke="#1c1a16" strokeOpacity="0.7" />
    </svg>
  );
}

/**
 * 兼容性自检报告的示意缩略。
 *
 * 展示的是**一份干净报告**（六段全过）——这才是交付时应有的样子。
 * 之前这里画的是"有阻断问题"的版本，容易被读成"这工具还没解决这些问题"。
 */
function ReportPreview() {
  const rows = [
    ['1. 文件格式', '栅格 · GTiff · 40×30', false],
    ['2. 坐标系', 'CGCS2000 / 3° 带', false],
    ['3. 几何有效性', '通过', false],
    ['4. 伴随文件', '.tfw .wld 齐全', false],
    ['5. ArcGIS 提示', '无', false],
    ['6. 量化摘要', '未发现阻断', false],
  ] as const;
  return (
    <div className="font-mono text-[10.5px] leading-[1.5]">
      <div className="mb-1.5 text-paper/45">兼容性自检报告 · scan-2024.tff</div>
      {rows.map(([k, v, bad]) => (
        <div
          key={k}
          className="flex items-center justify-between border-b border-paper/8 py-0.5 last:border-b-0"
        >
          <span className="text-paper/50">{k}</span>
          <span className={bad ? 'text-warn' : 'text-accent'}>{v}</span>
        </div>
      ))}
    </div>
  );
}

const ITEMS = [
  {
    icon: StackIcon,
    tag: '干净数据文件',
    title: '格式与坐标系原样保留',
    body: '写回的是 .tff 还是 .shp，栅格 CRS 照样内嵌在世界文件里。ArcGIS Pro 打开，不多问一句。',
    meta: ['原子写入', '自动备份', '占用检测'],
    preview: <FilePreview />,
  },
  {
    icon: FilePdfIcon,
    tag: 'PDF 图件',
    title: '带图框与标题栏的成图',
    body: '图名、图号、比例尺、图例、指北针一次画全，直接进汇报材料。',
    meta: ['A4 横竖版', '150 DPI', '矢量底图 + 栅格底图'],
    preview: <SheetPreview />,
  },
  {
    icon: ShieldCheckIcon,
    tag: '兼容性自检报告',
    title: '转给同事就能确认',
    body: '六段式：文件格式、坐标系、几何有效性、伴随文件、在 ArcGIS 里打开要注意什么、量化摘要。',
    meta: ['R-CRS-001 阻断项', '侧车文件清单', '几何有效性'],
    preview: <ReportPreview />,
  },
];

export function Deliverables() {
  const gridRef = useRef<HTMLDivElement | null>(null);

  // 入场动画：滚到时逐张淡入上移。**不 pin、不接管滚轮**。
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    gsap.registerPlugin(ScrollTrigger);
    const ctx = gsap.context(() => {
      const cards = gsap.utils.toArray<HTMLElement>('[data-pipeline="item"]', grid);
      if (cards.length === 0) return;
      gsap.from(cards, {
        y: 28,
        autoAlpha: 0,
        duration: 0.7,
        ease: 'power3.out',
        stagger: 0.1,
        scrollTrigger: { trigger: grid, start: 'top 85%' },
      });
    }, grid);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={gridRef}
      className="mx-auto mt-12 grid max-w-6xl grid-cols-1 gap-4 px-5 sm:grid-cols-2 sm:px-8 lg:grid-cols-3"
    >
      {ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <article
            key={item.title}
            data-pipeline="item"
            className="group relative flex flex-col overflow-hidden rounded-panel border border-paper/12 bg-paper/6 p-7 backdrop-blur-sm transition-colors duration-500 hover:border-paper/25 hover:bg-paper/10"
          >
            <div className="mb-6 flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-paper/10 text-paper">
                <Icon size={19} weight="duotone" />
              </span>
              <span className="font-mono text-[11px] tracking-[0.16em] text-paper/50 uppercase">
                {item.tag}
              </span>
            </div>
            <h3 className="font-display text-[21px] leading-snug font-semibold tracking-tight text-paper">
              {item.title}
            </h3>
            <p className="mt-3 max-w-[38ch] text-[14.5px] leading-relaxed text-paper/65">
              {item.body}
            </p>

            {/* 交付物的示意缩略：让卡片说的是"具体的东西"，不是抽象描述 */}
            <div className="mt-7 h-48 shrink-0 overflow-hidden rounded-lg border border-paper/12 bg-ink/55 p-4">
              {item.preview}
            </div>

            {/* mt-auto：正文行数不同也不影响标签贴底对齐 */}
            <ul className="mt-auto flex flex-wrap gap-2 pt-6">
              {item.meta.map((m) => (
                <li
                  key={m}
                  className="rounded-full border border-paper/15 px-2.5 py-1 font-mono text-[11.5px] text-paper/60"
                >
                  {m}
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </div>
  );
}
