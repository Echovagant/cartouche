import {
  ArrowRightIcon,
  CheckCircleIcon,
  DownloadSimpleIcon,
  GitBranchIcon,
  MapTrifoldIcon,
} from '@phosphor-icons/react/dist/ssr';
import { CartouchePreview } from './motion/CartouchePreview';
import { MagneticLink } from './motion/MagneticLink';
import { Deliverables } from './motion/Deliverables';
import { GateStack } from './motion/GateStack';
import { ScrollChoreography } from './motion/ScrollChoreography';
import { ConfirmCardBody, formatPixelGate } from './motion/ConfirmCardBody';
import { SiteHeader } from './motion/SiteHeader';

/**
 * 落地页（服务端组件）。
 *
 * 结构按 S1–S8 八段排（表面色是唯一的分段手段）：
 *   S1 纸  Hero：改一处图斑
 *   S2 墨  确认卡：改前先看清
 *   S3 纸  呼吸段：一个数字
 *   S4 纸  四道闸门
 *   S5 墨  交付物三件实物
 *   S6 纸  装 → 登记 → 改一笔
 *   S7 纸  格式窄带（紧贴 S6，不另起表面）
 *   S8 墨  开源 · 下载 · 图签
 *
 * 这里是**纯静态**的：所有滚动编排、磁性按钮、动态图形都在独立的
 * 'use client' 叶子组件里（见 ./motion），服务端组件只负责语义结构。
 *
 * ── 承诺纪律（本页的第一约束）────────────────────────────────────
 * 只写**已经交付**的能力。每写一句承诺，都要能在代码里指出对应的实现。
 * 反例（2026-10-22 删掉的）："用一句话说清要改什么" —— 那条 AI 链路
 * 还没有界面，写在首页就是骗人；"12 个格式一视同仁打勾" —— 其中 6 个
 * 矢量格式根本不能改，6 个栅格格式改完会换成 GeoTIFF。
 * 另一条：**不伪造数据**。页面上出现过的面积、坐标、操作人、日期都是编的，
 * 现在一律换成真实运行的录制值或真实截图。
 */

/* ── 导航 ── */

const NAV = [
  { href: '#s4', label: '能做什么' },
  { href: '#s2', label: '改前确认' },
  { href: '#s5', label: '改后交付' },
  { href: '#s6', label: '怎么用' },
  { href: '#s8', label: '下载' },
] as const;

/* ── 改图之前要给你看的四行（就是工具里的确认卡） ── */

const GATES = [
  {
    n: '01',
    title: '将影响的像元',
    body: '这次会改多少像元、占全图百分之几。数字是算出来的，不是估的。',
  },
  {
    n: '02',
    title: '目标文件',
    body: '改的是哪一个文件，写在图上。你要改的那张，和工具要动的那张，是同一张。',
  },
  {
    n: '03',
    title: '将生成的备份',
    body: '备份叫什么名字、放在哪，一并写清。回滚就是把它复制回去。',
  },
  {
    n: '04',
    title: '操作类型',
    body: '涂色 / 擦除 / 调色，不含糊。你知道自己在干什么。',
  },
];

/**
 * 确认卡上那四行的**录制值**。
 *
 * 来源：2026-10-22 一次真实涂色操作的执行前确认卡（截图见
 * web/public/site/confirm-card.jpg，与本段展示的是同一次运行）。
 * 数值口径与画布里的格式化函数完全一致（formatPixelGate），
 * 不另写一套，免得两边说法不一样。
 */
const RECORDED_GATES = [
  { label: '将影响的像元', value: formatPixelGate(165, 1200, 165 / 1200) },
  { label: '目标文件', value: '底图.tff' },
  { label: '将生成的备份', value: '底图.tff.bak.<yyyyMMdd-HHmmss>（与原文件同目录）' },
  { label: '操作类型', value: '涂色' },
];

/* ── 怎么用：三步 ── */

const STEPS = [
  {
    n: '01',
    title: '装',
    body: '需要 Node.js 22 或更高，外加 GDAL 命令行。装完先自检一下，缺什么它会直接说。',
    code: [
      '# 装 GDAL（Windows 走国内镜像的 conda-forge 通道）',
      'powershell -ExecutionPolicy Bypass -File scripts/setup-conda-gdal.ps1',
      '',
      'npm install',
      'npm run doctor      # 自检：Node / GDAL / 驱动 / 就绪度',
    ],
  },
  {
    n: '02',
    title: '登记',
    body: '一个项目 = 一次交差任务。把你放图件的文件夹登记进来，工具在**旁边**建一个 .cartouche/ 放清单、产出物与留痕，你的图件一个字节都不会被搬动或改写。',
    code: [
      '# 起引擎（另开一个终端）',
      'npm run dev:server',
      '',
      '# 构建并打开画布',
      'npm run build:web',
      'npm run serve:web    # http://127.0.0.1:8080/canvas.html',
    ],
  },
  {
    n: '03',
    title: '改一笔',
    body: '选中栅格图层，用画笔或框选拖一下，确认卡会先告诉你影响面。确认之后：原图件就地改好、自动备份、地图刷新、PDF 落进产出物、留痕追加一行。',
    code: [
      '# 画布上：查看 / 画笔 / 框选 / 调色',
      '# → 拖一下 → 确认卡 → 确认执行',
      '',
      '# 产出物在 .cartouche/outputs/',
      '# 留痕在 .cartouche/history.jsonl，一行一次操作',
    ],
  },
];

/* ── 格式支持：按"能不能改"分三组，不打太极 ── */

const WRITABLE = [
  { ext: '.tff', note: 'GeoTIFF 内容 + .tfw/.prj 伴随文件' },
  { ext: '.tif', note: 'GeoTIFF' },
];

const READONLY_RASTER = [
  { ext: '.img', note: 'Erdas Imagine' },
  { ext: '.vrt', note: 'GDAL 虚拟栅格' },
  { ext: '.asc', note: 'ESRI ASCII Grid' },
  { ext: '.bil', note: 'Band Interleaved by Line' },
  { ext: '.png', note: '位图' },
];

const READONLY_VECTOR = [
  { ext: '.shp', note: 'Shapefile' },
  { ext: '.gdb', note: 'File Geodatabase' },
  { ext: '.gpkg', note: 'GeoPackage' },
  { ext: '.geojson', note: 'GeoJSON' },
  { ext: '.kml', note: 'KML' },
  { ext: '.gml', note: 'GML' },
];

/* ── 关于 ── */

const ABOUT = [
  {
    title: '图签是什么',
    body: '工程制图里，图签是贴在图纸角上那块写着图名、编号、比例尺、审核人的牌子。西方地图上同样的东西叫 cartouche——一块题签框。',
  },
  {
    title: '本机运行',
    body: '引擎只监听回环地址，图件的读写都在你自己的文件夹里。数据不出本机，也不做遥测。',
  },
  {
    title: '不依赖商业授权',
    body: '引擎是纯 TypeScript + GDAL 命令行，界面是静态导出的前端，不含自动更新。装好就能用，不需要另外买许可证。',
  },
  {
    title: '能不能在 ArcGIS 里打开',
    body: '能。写回的是原图件，伴随文件（.prj / .cpg / .tfw / .wld）随主文件一起读写，坐标系原样保留。',
  },
];

export default function Home() {
  return (
    <>
      <ScrollChoreography />

      <main className="w-full max-w-full overflow-x-hidden">
        {/* ── 导航：悬浮玻璃药丸（<900px 折叠进汉堡） ── */}
        <SiteHeader items={NAV} />

        {/* ═══ S1 · Hero：改一处图斑 ═══════════════════════════════ */}
        <section id="s1" className="relative px-5 pt-32 pb-24 sm:px-8 sm:pt-40">
          <div className="mx-auto max-w-[1440px]">
            <div className="max-w-[62ch]">
              <p
                data-hero="eyebrow"
                className="reveal font-mono text-eyebrow text-ink-2 uppercase"
              >
                本机运行 · 数据不出本机 · 不依赖商业 GIS 授权
              </p>

              <h1
                data-hero="title"
                className="reveal font-display mt-7 text-balance text-display-1 text-ink"
              >
                改一处图斑，改前先看清，改后能退回。
              </h1>

              <p
                data-hero="body"
                className="reveal mt-7 max-w-[52ch] text-pretty text-lead text-ink-2"
              >
                装在你自己的电脑上，打开图件所在的文件夹，画一笔——确认卡先告诉你改了什么、
                原图退不退得回去，然后原样写回。
              </p>

              <div data-hero="cta" className="mt-9 flex flex-wrap items-center gap-3">
                <MagneticLink
                  href="#s6"
                  className="reveal group inline-flex min-h-11 items-center gap-2 rounded-full bg-ink px-6 py-3 text-[14.5px] font-medium whitespace-nowrap text-paper transition-colors hover:bg-accent-deep"
                >
                  看三步怎么跑起来
                  <ArrowRightIcon
                    aria-hidden="true"
                    size={16}
                    weight="bold"
                    className="transition-transform duration-[var(--duration-fast)] group-hover:translate-x-1"
                  />
                </MagneticLink>
                <a
                  href="canvas.html"
                  className="reveal inline-flex min-h-11 items-center gap-2 rounded-full border border-ink-3 bg-surface px-6 py-3 text-[14.5px] font-medium whitespace-nowrap text-ink transition-colors hover:border-ink-2"
                >
                  直接打开画布
                </a>
              </div>
            </div>

            {/* 图幅：占右侧 60% 宽，图签框特写贴在右下角 */}
            <div data-hero="figure" className="reveal relative mt-14 w-full lg:ml-auto lg:w-[62%]">
              <div className="relative aspect-[1440/760] w-full overflow-hidden rounded-panel border border-line bg-surface">
                <CartouchePreview />
              </div>
              <figure className="absolute -bottom-7 right-5 w-[210px] rotate-[-1.5deg] overflow-hidden rounded-panel border border-line bg-surface shadow-product sm:right-8 sm:w-[250px]">
                <img
                  src="./site/confirm-card.jpg"
                  alt="确认卡：执行前写明将影响的像元数、目标文件、将生成的备份名与操作类型"
                  width={556}
                  height={398}
                  loading="eager"
                  decoding="async"
                  className="w-full"
                />
              </figure>
            </div>
          </div>
        </section>

        {/* ═══ S2 · 确认卡：改前先看清 ═════════════════════════════ */}
        <section
          id="s2"
          data-surface-section="dark"
          className="page-vignette relative overflow-hidden bg-ink py-24 text-paper sm:py-32"
        >
          <div className="relative z-10 mx-auto grid max-w-[1440px] grid-cols-1 gap-12 px-5 sm:px-8 lg:grid-cols-[minmax(0,0.4fr)_minmax(0,0.6fr)] lg:gap-16">
            <div data-s2="head" className="reveal lg:sticky lg:top-32 lg:self-start">
              <p className="font-mono text-eyebrow text-paper/85 uppercase">改前先看清</p>
              <h2 className="font-display mt-6 text-balance text-display-2 text-paper">
                改之前，先把这四行摆出来
              </h2>
              <p className="mt-6 max-w-[40ch] text-lead text-paper/85">
                你不点头，它连临时文件都不建。
              </p>

              <p className="mt-8 font-mono text-[clamp(1.5rem,2.6vw,2.15rem)] leading-tight font-semibold text-accent-lit tnum">
                {formatPixelGate(165, 1200, 165 / 1200)}
              </p>
              <p className="mt-3 max-w-[38ch] text-body-sm leading-relaxed text-paper/85">
                这是一次真实涂色操作的预演结果：全图 1,200 个像元里，这次会改 165 个。
                目标文件、备份叫什么、放在哪，都写在同一张卡上。
              </p>

              <a
                href="canvas.html"
                className="mt-8 inline-flex min-h-11 items-center gap-2 text-[14px] font-medium text-paper underline decoration-paper/40 underline-offset-4 transition-colors hover:decoration-paper"
              >
                打开画布看真的
                <ArrowRightIcon aria-hidden="true" size={15} weight="bold" />
              </a>
            </div>

            <div data-s2="container" className="reveal">
              <ConfirmCardBody
                variant="ink"
                title="确认这次改动"
                opLabel="raster.paint"
                gates={RECORDED_GATES}
                reveal
              >
                <p
                  data-s2="caption"
                  className="reveal mt-4 font-mono text-[12px] leading-relaxed text-paper/85"
                >
                  示例：2026-10-22 的一次真实涂色操作
                </p>
              </ConfirmCardBody>
            </div>
          </div>
        </section>

        {/* ═══ S3 · 呼吸段：一个数字 ═══════════════════════════════ */}
        <section id="s3" className="bg-paper px-5 py-20 sm:px-8 sm:py-28">
          <div className="mx-auto max-w-[1200px]">
            <p data-s3="denial" className="reveal text-[clamp(1.05rem,1.7vw,1.4rem)] font-medium text-ink-2">
              不是「已修改」
            </p>

            <p
              data-s3="figure"
              className="reveal mt-6 flex flex-wrap items-baseline gap-x-5 gap-y-2 font-mono text-hero-figure text-ink tnum"
            >
              1 170 <span className="text-ink-4">/</span> 1 200
              <span className="font-mono text-[clamp(1rem,1.7vw,1.45rem)] font-medium text-ink-2">
                （97.5%）
              </span>
            </p>

            <p data-s3="note" className="reveal mt-6 max-w-[48ch] text-body text-ink-2">
              一次真实涂色操作的预演结果：全图 1,200 个像元里会改 1,170 个。
              数字是算出来的，不是估的——摆出来，你自己判断值不值。
            </p>
          </div>
        </section>

        {/* 分隔原语：S3 与 S4 同表面，靠它断开 */}
        <div
          data-sep
          aria-hidden="true"
          className="homepage-separator mx-auto my-16 h-px max-w-6xl sm:my-24"
        />

        {/* ═══ S4 · 四道闸门 ═══════════════════════════════════════ */}
        <section id="s4" className="bg-paper px-5 pb-20 sm:px-8 sm:pb-28">
          <div className="mx-auto grid max-w-[1440px] grid-cols-1 gap-14 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <div data-section-head className="reveal md:sticky md:top-32 md:self-start">
              <p className="font-mono text-eyebrow text-ink-2 uppercase">一条都不省</p>
              <h2 className="font-display mt-6 text-balance text-display-2 text-ink">
                你不点头，它连临时文件都不建
              </h2>
              <p className="mt-6 max-w-[44ch] text-lead text-ink-2">
                这四行就是工具里的执行前确认卡。数字不是估的，文件也不是先改了再问你。
              </p>
            </div>
            <GateStack gates={GATES} />
          </div>
        </section>

        {/* ═══ S5 · 交付物三件实物 ═════════════════════════════════ */}
        <section
          id="s5"
          data-surface-section="dark"
          className="page-vignette relative overflow-hidden bg-ink py-24 text-paper sm:py-32"
        >
          <div className="relative z-10 mx-auto max-w-[1440px] px-5 sm:px-8">
            <div data-section-head className="reveal">
              <p className="font-mono text-eyebrow text-paper/85 uppercase">
                交差用得上的三样东西
              </p>
              <h2 className="font-display mt-6 max-w-3xl text-balance text-display-2 text-paper">
                改完图，你还要能交代清楚
              </h2>
            </div>
          </div>
          <Deliverables />
        </section>

        {/* ═══ S6 · 装 → 登记 → 改一笔 ══════════════════════════════ */}
        <section id="s6" className="bg-paper px-5 pt-20 pb-16 sm:px-8 sm:pt-28 sm:pb-16">
          <div className="mx-auto max-w-[1200px]">
            <div data-section-head className="reveal">
              <p className="font-mono text-eyebrow text-ink-2 uppercase">三步</p>
              <h2 className="font-display mt-6 max-w-3xl text-balance text-display-2 text-ink">
                装上，登记，改一笔
              </h2>
            </div>

            <ol className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-3">
              {STEPS.map((s) => (
                <li
                  key={s.n}
                  data-step="item"
                  className="reveal flex flex-col rounded-panel border border-line bg-surface p-6"
                >
                  <span className="font-mono text-[13px] tracking-[0.14em] text-accent">{s.n}</span>
                  <h3 className="font-display mt-2.5 text-[20px] font-semibold tracking-tight text-ink">
                    {s.title}
                  </h3>
                  <p className="mt-3 text-[14px] leading-relaxed text-ink-2">{s.body}</p>
                  <pre
                    data-step="code"
                    className="reveal mt-5 flex-1 overflow-x-auto rounded-lg border border-line bg-paper px-4 py-3 font-mono text-[11.5px] leading-[1.7] text-ink-2"
                  >
                    {s.code.join('\n')}
                  </pre>
                </li>
              ))}
            </ol>

            <p className="mt-6 text-[13.5px] leading-relaxed text-ink-3">
              画布必须用 http 打开：Chrome 禁止从 file:// 构造 Web Worker，MapLibre
              起不来，地图会一片空白。
            </p>
          </div>
        </section>

        {/* ═══ S7 · 格式窄带（紧贴 S6，不另起表面） ═════════════════ */}
        <section id="s7" className="bg-paper px-5 pb-20 pt-16 sm:px-8 sm:pb-28 sm:pt-16">
          <div className="mx-auto max-w-[1200px]">
            <div data-section-head className="reveal">
              <p className="font-mono text-eyebrow text-ink-2 uppercase">格式支持</p>
              <h2 className="font-display mt-6 max-w-3xl text-balance text-display-2 text-ink">
                打开就能看，能改的在这里
              </h2>
              <p className="mt-6 max-w-[56ch] text-lead text-ink-2">
                不做中间格式转换，坐标系原样保留。下面按「能不能改」分开写，不含糊。
              </p>
            </div>

            <div className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-3">
              {/* 能改 */}
              <div data-format="group" className="reveal rounded-panel border border-accent bg-accent-soft p-6">
                <div className="flex items-center gap-2">
                  <CheckCircleIcon aria-hidden="true" size={17} weight="fill" className="text-accent" />
                  <h3 className="font-display text-[17px] font-semibold text-ink">
                    能改 · 原样写回
                  </h3>
                </div>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">
                  写回的是原图件，格式、坐标系、伴随文件（.prj / .cpg / .tfw / .wld）都跟着走。
                  ArcGIS 打开不报「坐标系未知」。
                </p>
                <ul className="mt-5 space-y-2">
                  {WRITABLE.map((f) => (
                    <li key={f.ext} data-format="row" className="flex items-baseline gap-2.5">
                      <span className="font-mono text-[13.5px] font-medium text-ink">{f.ext}</span>
                      <span className="text-[12.5px] text-ink-3">{f.note}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* 只读栅格 */}
              <div data-format="group" className="reveal rounded-panel border border-line bg-surface p-6">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="grid h-[17px] w-[17px] place-items-center rounded-full border border-ink-4 text-[10px] leading-none text-ink-3"
                  >
                    ○
                  </span>
                  <h3 className="font-display text-[17px] font-semibold text-ink">
                    能看能导出 · 不改
                  </h3>
                </div>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">
                  能打开、能出图、能查属性、能导出。写回统一产出 GeoTIFF，改了会换格式，
                  所以工具会明确拒绝，而不是把文件改坏。
                </p>
                <ul className="mt-5 space-y-2">
                  {READONLY_RASTER.map((f) => (
                    <li key={f.ext} data-format="row" className="flex items-baseline gap-2.5">
                      <span className="font-mono text-[13.5px] font-medium text-ink-2">{f.ext}</span>
                      <span className="text-[12.5px] text-ink-3">{f.note}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* 只读矢量 */}
              <div data-format="group" className="reveal rounded-panel border border-line bg-surface p-6">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="grid h-[17px] w-[17px] place-items-center rounded-full border border-ink-4 text-[10px] leading-none text-ink-3"
                  >
                    ○
                  </span>
                  <h3 className="font-display text-[17px] font-semibold text-ink">
                    矢量 · 只读
                  </h3>
                </div>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">
                  能出图、能查属性、能导出。矢量编辑还没做——不假装能做，工具会直接说这个操作尚未支持。
                </p>
                <ul className="mt-5 space-y-2">
                  {READONLY_VECTOR.map((f) => (
                    <li key={f.ext} data-format="row" className="flex items-baseline gap-2.5">
                      <span className="font-mono text-[13.5px] font-medium text-ink-2">{f.ext}</span>
                      <span className="text-[12.5px] text-ink-3">{f.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ═══ S8 · 开源 · 下载 · 图签 ══════════════════════════════ */}
        <section
          id="s8"
          data-surface-section="dark"
          className="page-vignette relative overflow-hidden bg-ink py-24 text-paper sm:py-32"
        >
          <div className="relative z-10 mx-auto max-w-[1440px] px-5 sm:px-8">
            <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-16">
              {/* 左：下载 / 源码 / 许可 / 不含什么 */}
              <div
                data-s8="panel"
                className="reveal relative overflow-hidden rounded-panel border border-ink-line bg-ink-surface p-7 sm:p-10"
              >
                {/* 全站只剩这一个光斑 */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -top-24 -right-16 h-72 w-72 rounded-full bg-accent/18 blur-[80px]"
                />
                <div className="relative">
                  <p className="font-mono text-eyebrow text-paper/85 uppercase">许可与下载</p>
                  <h2 className="font-display mt-6 max-w-[20ch] text-balance text-display-2 text-paper">
                    开源，Apache-2.0
                  </h2>
                  <p className="mt-6 max-w-[52ch] text-body leading-relaxed text-paper/85">
                    整个仓库都能拿走改。下载包里有引擎、前端产物和安装脚本；自己 clone
                    也一样，跑 <span className="font-mono text-[13px]">npm install</span> 就完事。
                  </p>

                  <div className="mt-8 flex flex-wrap gap-3">
                    <a
                      href="https://github.com/Echovagant/cartouche/releases"
                      className="group inline-flex min-h-11 items-center gap-2 rounded-full bg-paper px-6 py-3 text-[14.5px] font-semibold whitespace-nowrap text-ink transition-colors hover:bg-accent hover:text-paper"
                    >
                      <DownloadSimpleIcon aria-hidden="true" size={16} weight="bold" />
                      下载
                      <ArrowRightIcon
                        aria-hidden="true"
                        size={16}
                        weight="bold"
                        className="transition-transform duration-[var(--duration-fast)] group-hover:translate-x-1"
                      />
                    </a>
                    <a
                      href="https://github.com/Echovagant/cartouche"
                      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-paper/50 px-6 py-3 text-[14.5px] font-medium whitespace-nowrap text-paper transition-colors hover:border-paper/70"
                    >
                      <GitBranchIcon aria-hidden="true" size={16} weight="bold" />
                      源码
                    </a>
                  </div>

                  <dl className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2">
                    <div>
                      <dt className="font-mono text-[11px] tracking-[0.16em] text-paper/85 uppercase">
                        前置条件
                      </dt>
                      <dd className="mt-1.5 text-[14px] leading-relaxed text-paper/90">
                        Node.js ≥ 22、GDAL 命令行。Windows 上装 GDAL 有现成脚本。
                      </dd>
                    </div>
                    <div>
                      <dt className="font-mono text-[11px] tracking-[0.16em] text-paper/85 uppercase">
                        许可
                      </dt>
                      <dd className="mt-1.5 text-[14px] leading-relaxed text-paper/90">
                        Apache-2.0。第三方组件许可见仓库里的 NOTICE。
                      </dd>
                    </div>
                    <div>
                      <dt className="font-mono text-[11px] tracking-[0.16em] text-paper/85 uppercase">
                        不含什么
                      </dt>
                      <dd className="mt-1.5 text-[14px] leading-relaxed text-paper/90">
                        不含、不分发任何 Esri 专有软件或数据。ArcGIS 是 Esri 的注册商标。
                      </dd>
                    </div>
                    <div>
                      <dt className="font-mono text-[11px] tracking-[0.16em] text-paper/85 uppercase">
                        要加模型
                      </dt>
                      <dd className="mt-1.5 text-[14px] leading-relaxed text-paper/90">
                        密钥用 DPAPI 加密存在本机，从不明文落盘。见
                        <a href="ai.html" className="text-paper underline underline-offset-4">
                          AI 接入
                        </a>
                        。
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>

              {/* 右：图签框特写 + 4 条 About */}
              <div>
                <div
                  data-s8="closeup"
                  className="reveal relative overflow-hidden rounded-panel border border-ink-line bg-ink-surface p-6"
                >
                  {/* 全图 12% 透明度作底 */}
                  <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-[0.12]">
                    <CartouchePreview variant="full" />
                  </div>
                  <div className="relative">
                    <div className="aspect-[404/112] w-full">
                      <CartouchePreview variant="sheet" />
                    </div>
                  </div>
                </div>

                <dl className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2">
                  {ABOUT.map((a) => (
                    <div key={a.title} data-s8="about" className="reveal">
                      <dt className="font-display text-[16px] font-semibold text-paper">{a.title}</dt>
                      <dd className="mt-2 text-body-sm leading-relaxed text-paper/85">{a.body}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ── 页脚：承担全站导航 + 口径脚注 ── */}
      <footer className="border-t border-line bg-paper px-5 py-12 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4 lg:grid-cols-6">
            <div className="col-span-2">
              <span className="flex items-center gap-2 text-ink">
                <MapTrifoldIcon aria-hidden="true" size={16} weight="duotone" className="text-accent" />
                <span className="font-display text-[15px] font-semibold">图签 Cartouche</span>
              </span>
              <p className="mt-3 max-w-[34ch] text-[12.5px] leading-relaxed text-ink-3">
                跑在本机的地图出图工具。改图、出图、自检、留痕，数据全程留在你机器上。
              </p>
            </div>
            {[
              {
                title: '产品',
                links: [
                  { label: '能做什么', href: '#s4' },
                  { label: '改前确认', href: '#s2' },
                  { label: '改后交付', href: '#s5' },
                ],
              },
              {
                title: '细节',
                links: [
                  { label: '怎么用', href: '#s6' },
                  { label: '格式支持', href: '#s7' },
                  { label: 'AI 接入（开发中）', href: 'ai.html' },
                ],
              },
              {
                title: '获取',
                links: [
                  { label: '下载', href: '#s8' },
                  { label: '源码', href: 'https://github.com/Echovagant/cartouche' },
                  { label: '画布', href: 'canvas.html' },
                ],
              },
              {
                title: '关于',
                links: [
                  { label: '项目说明', href: '#s8' },
                  { label: '许可', href: 'https://github.com/Echovagant/cartouche/blob/main/LICENSE' },
                ],
              },
            ].map((col) => (
              <div key={col.title}>
                <p className="font-mono text-[12px] tracking-[0.16em] text-ink-2 uppercase">
                  {col.title}
                </p>
                <ul className="mt-2 space-y-0.5">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      <a
                        href={l.href}
                        className="inline-flex min-h-11 min-w-11 items-center text-label text-ink-2 transition-colors hover:text-ink"
                      >
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* 口径脚注：数据从哪来、到什么时候、什么会变 */}
          <div className="mt-8 border-t border-line pt-6 text-[12.5px] leading-relaxed text-ink-3">
            <p>
              口径说明：页面上的像元数与百分比来自 2026-10-22
              的一次真实运行记录。不同数据源的像元大小与精度不同，像元数、影响面与比例尺会随之变化。
              功能仍在开发中，页面所述能力以仓库当前实现为准。
            </p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <span className="font-mono">Apache-2.0</span>
              <span className="hidden h-3 w-px bg-line-2 sm:block" />
              <span>引擎本地运行 · 密钥不出本机</span>
              <span className="flex-1" />
              <span>图签 = 工程制图的图签；cartouche = 西方地图上的题签框</span>
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}
