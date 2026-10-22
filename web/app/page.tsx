import Link from 'next/link';
import {
  ArrowRightIcon,
  CheckCircleIcon,
  CompassIcon,
  DownloadSimpleIcon,
  FilePdfIcon,
  GaugeIcon,
  GitBranchIcon,
  LockKeyIcon,
  MapTrifoldIcon,
  ShieldCheckIcon,
  StackIcon,
} from '@phosphor-icons/react/dist/ssr';
import { CartouchePreview } from './motion/CartouchePreview';
import { MagneticLink } from './motion/MagneticLink';
import { Deliverables } from './motion/Deliverables';
import { GateStack } from './motion/GateStack';
import { ScrollChoreography } from './motion/ScrollChoreography';

/**
 * 落地页（服务端组件）。
 *
 * 结构按 AIDA：导航 → 注意（Hero）→ 兴趣（能做什么）→ 欲望（怎么用 / 交付物 / 改前确认）
 * → 行动（许可与下载）→ 关于。
 *
 * 这里是**纯静态**的：所有滚动编排、磁性按钮、动态图形都在独立的
 * 'use client' 叶子组件里（见 ./motion），服务端组件只负责语义结构。
 *
 * ── 承诺纪律（本页的第一约束）────────────────────────────────────
 * 只写**已经交付**的能力。每写一句承诺，都要能在代码里指出对应的实现。
 * 反例（2026-10-22 删掉的）："用一句话说清要改什么" —— 那条 AI 链路
 * 还没有界面，写在首页就是骗人；"12 个格式一视同仁打勾" —— 其中 6 个
 * 矢量格式根本不能改，6 个栅格格式改完会换成 GeoTIFF。
 */

/* ── 导航 ── */

const NAV = [
  { href: '#what', label: '能做什么' },
  { href: '#how', label: '怎么用' },
  { href: '#formats', label: '格式支持' },
  { href: '#download', label: '下载' },
] as const;

/* ── 能做什么 ── */

const CAPABILITIES = [
  {
    icon: ShieldCheckIcon,
    kicker: '执行前',
    title: '先写确认卡，再动手',
    body: '四行数字先摆出来：影响像元、目标文件、备份叫什么、这次是什么操作。你不点头，文件一个字节都不动。',
    span: 'md:col-span-2 lg:col-span-3',
    tone: 'ink',
  },
  {
    icon: StackIcon,
    kicker: '写回',
    title: '改坏了能退回去',
    body: '临时文件 → 校验 → 原子替换 → 自动备份。写到一半失败，原文件一个字节都不动。',
    span: 'md:col-span-2 lg:col-span-3',
    tone: 'paper',
  },
  {
    icon: GaugeIcon,
    kicker: '影响报告',
    title: '动了多少，写成数字',
    body: '不是"已修改"，是"1 170 / 1 200 像元（97.5%）"。数字摆出来，你自己判断值不值。',
    span: 'md:col-span-2 lg:col-span-2',
    tone: 'paper',
  },
  {
    icon: FilePdfIcon,
    kicker: '交差材料',
    title: '转给同事就能用',
    body: '带图框与标题栏的 PDF 图件，加上六段式自检报告——对方不用装这个软件也能确认文件没问题。',
    span: 'md:col-span-2 lg:col-span-2',
    tone: 'paper',
  },
  {
    icon: LockKeyIcon,
    kicker: '保密',
    title: '图件不出本机',
    body: '服务只监听回环地址；模型密钥用 DPAPI 加密存在仓库之外，从不明文落盘。',
    span: 'md:col-span-2 lg:col-span-2',
    tone: 'ink',
  },
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
] as const;

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
    title: '它替代什么',
    body: '不改图、出图交差这一段高频工作，替代 ArcGIS Pro 的日常用法；空间分析、3D 场景、高级符号化这些专业制图能力，不在范围内。',
  },
  {
    title: '和 ArcGIS 什么关系',
    body: '不冲突。写回的是原图件，伴随文件（.prj / .cpg / .tfw / .wld）随主文件一起读写，ArcGIS 照常打开。',
  },
  {
    title: '里面是什么',
    body: '引擎是纯 TypeScript + GDAL 命令行；界面是静态导出的前端，不连后台、不做遥测、不含自动更新。',
  },
] as const;

export default function Home() {
  return (
    <>
      <ScrollChoreography />

      <main className="w-full max-w-full overflow-x-hidden">
        {/* ── 导航：悬浮玻璃药丸 ── */}
        <header className="fixed inset-x-0 top-0 z-50 px-4 pt-4 sm:px-6">
          <nav className="glass mx-auto flex max-w-6xl items-center gap-3 rounded-full px-4 py-2.5 sm:px-5">
            <Link
              href="./"
              className="flex shrink-0 items-center gap-2.5 text-[13.5px] font-medium tracking-tight whitespace-nowrap text-ink"
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-accent text-paper">
                <CompassIcon size={15} weight="bold" />
              </span>
              图签 Cartouche
            </Link>
            <span className="hidden h-4 w-px bg-line-2 sm:block" />
            <span className="hidden font-mono text-[12px] tracking-wide whitespace-nowrap text-ink-2 sm:block">
              本机运行的出图工具
            </span>
            <span className="flex-1" />
            {NAV.map((item, i) => (
              <a
                key={item.href}
                href={item.href}
                className={`rounded-full px-3 py-1.5 text-[13px] whitespace-nowrap text-ink-2 transition-colors hover:text-ink ${
                  // 手机上只留两节，其余交给页脚导航
                  i >= 2 ? 'hidden md:block' : 'hidden sm:block'
                }`}
              >
                {item.label}
              </a>
            ))}
            <a
              href="ai.html"
              className="hidden rounded-full px-3 py-1.5 text-[13px] whitespace-nowrap text-ink-2 transition-colors hover:text-ink sm:block"
            >
              AI 接入
            </a>
            <MagneticLink
              href="canvas.html"
              className="shrink-0 rounded-full bg-accent px-4 py-2 text-[13px] font-medium whitespace-nowrap text-paper shadow-lift transition-colors hover:bg-accent-deep"
            >
              打开画布
            </MagneticLink>
          </nav>
        </header>

        {/* ── 注意：Hero ── */}
        <section className="relative px-5 pt-32 pb-20 sm:px-8 sm:pt-40">
          <div className="mx-auto max-w-6xl text-center">
            <p
              data-hero="eyebrow"
              className="font-mono text-[12px] tracking-[0.2em] text-ink-2 uppercase"
            >
              本机运行 · 数据不出本机 · 不依赖商业 GIS 授权
            </p>

            <h1
              data-hero="title"
              className="font-display mx-auto mt-7 max-w-5xl text-balance text-[clamp(2.3rem,5.2vw,4.4rem)] leading-[1.05] font-bold tracking-[-0.03em] text-ink"
            >
              改一处图斑，
              <br className="sm:hidden" />
              不必先学一整套 ArcGIS
            </h1>

            <p
              data-hero="body"
              className="mx-auto mt-7 max-w-[58ch] text-pretty text-[17px] leading-relaxed text-ink-2"
            >
              装在你自己电脑上，打开放图件的文件夹。画一笔、确认一下，
              <span className="text-ink">原图件就地改好</span>，ArcGIS 照常打开。
              改了什么、动了多少、备份在哪，都写在动手之前。
            </p>

            <div data-hero="cta" className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <MagneticLink
                href="#how"
                className="group inline-flex items-center gap-2 rounded-full bg-ink px-6 py-3 text-[14.5px] font-medium whitespace-nowrap text-paper shadow-lift transition-colors hover:bg-accent-deep"
              >
                看三步怎么跑起来
                <ArrowRightIcon
                  size={16}
                  weight="bold"
                  className="transition-transform duration-300 group-hover:translate-x-1"
                />
              </MagneticLink>
              <MagneticLink
                href="canvas.html"
                className="inline-flex items-center gap-2 rounded-full border border-line-2 bg-surface px-6 py-3 text-[14.5px] font-medium whitespace-nowrap text-ink transition-colors hover:border-ink-4"
              >
                直接打开画布
              </MagneticLink>
            </div>
          </div>

          {/* 真实产品截图带：确认卡 / 带图框成图 / 六段自检报告。
              这三张是工具真的会给你看的东西，不是示意图。 */}
          <div className="mx-auto mt-16 max-w-6xl sm:mt-20">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <figure className="overflow-hidden rounded-panel border border-line bg-surface shadow-lift">
                <img
                  src="./site/confirm-card.jpg"
                  alt="确认卡：执行前写明将影响的像元数、目标文件、将生成的备份名与操作类型"
                  width={556}
                  height={398}
                  loading="eager"
                  className="w-full"
                />
                <figcaption className="border-t border-line px-5 py-4">
                  <p className="font-mono text-[12px] tracking-[0.16em] text-ink-2 uppercase">
                    动手之前
                  </p>
                  <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
                    确认卡：影响像元、目标文件、备份名、操作类型，四行写清才让你点头。
                  </p>
                </figcaption>
              </figure>

              <figure className="overflow-hidden rounded-panel border border-line bg-surface shadow-lift">
                <img
                  src="./site/canvas-frame.jpg"
                  alt="出图工作台：栅格与矢量叠在图框中，图名、操作人、图例、比例尺与出图时间都在图面上"
                  width={1400}
                  height={702}
                  loading="eager"
                  className="w-full"
                />
                <figcaption className="border-t border-line px-5 py-4">
                  <p className="font-mono text-[12px] tracking-[0.16em] text-ink-2 uppercase">
                    工作台
                  </p>
                  <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
                    出图工作台：栅格与矢量叠着看，图名、操作人、图例、比例尺、出图时间都印在图框里。
                  </p>
                </figcaption>
              </figure>

              <figure className="overflow-hidden rounded-panel border border-line bg-surface shadow-lift sm:col-span-2 lg:col-span-1">
                <img
                  src="./site/report.jpg"
                  alt="六段式兼容性自检报告：文件格式、坐标系、几何有效性、伴随文件、在 ArcGIS 里打开要注意什么、量化摘要"
                  width={1400}
                  height={702}
                  loading="eager"
                  className="w-full"
                />
                <figcaption className="border-t border-line px-5 py-4">
                  <p className="font-mono text-[12px] tracking-[0.16em] text-ink-2 uppercase">
                    六段式自检报告
                  </p>
                  <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
                    缺什么、会出什么问题、怎么改，逐条写清——不用等打开 ArcGIS 才发现坐标系未知。
                  </p>
                </figcaption>
              </figure>
            </div>
          </div>
        </section>

        {/* ── 兴趣：能做什么 ── */}
        <section className="px-5 py-20 sm:px-8 sm:py-28" id="what">
          <div className="mx-auto max-w-6xl">
            <p className="font-mono text-[12px] tracking-[0.2em] text-ink-2 uppercase">
              件件有据可查
            </p>
            <h2 className="font-display mt-5 max-w-3xl text-balance text-[clamp(1.8rem,3.4vw,2.9rem)] leading-[1.12] font-bold tracking-[-0.025em] text-ink">
              改图这件事，能被核对
            </h2>
            <p className="mt-5 max-w-[52ch] text-[15px] leading-relaxed text-ink-2">
              下面每一条都能在代码里指到对应实现。下面这五张，是工具真的做得出来的事。
            </p>

            <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-4 lg:grid-cols-6">
              {CAPABILITIES.map((c) => {
                const Icon = c.icon;
                const dark = c.tone === 'ink';
                return (
                  <article
                    key={c.title}
                    data-bento="cell"
                    className={`group relative overflow-hidden rounded-panel border p-7 transition-transform duration-500 ease-out hover:-translate-y-1 ${
                      c.span
                    } ${
                      dark
                        ? 'border-ink/85 bg-ink text-paper shadow-diffuse'
                        : 'border-line bg-surface shadow-lift'
                    }`}
                  >
                    <div
                      className={`mb-6 grid h-10 w-10 place-items-center rounded-full ${
                        dark ? 'bg-paper/12 text-paper' : 'bg-accent-soft text-accent'
                      }`}
                    >
                      <Icon size={19} weight="duotone" />
                    </div>
                    <p
                      className={`font-mono text-[11px] tracking-[0.16em] uppercase ${
                        dark ? 'text-paper/70' : 'text-ink-3'
                      }`}
                    >
                      {c.kicker}
                    </p>
                    <h3
                      className={`font-display mt-2.5 text-[19px] leading-snug font-semibold tracking-tight ${
                        dark ? 'text-paper' : 'text-ink'
                      }`}
                    >
                      {c.title}
                    </h3>
                    <p
                      className={`mt-3 max-w-[46ch] text-[14.5px] leading-relaxed ${
                        dark ? 'text-paper/80' : 'text-ink-2'
                      }`}
                    >
                      {c.body}
                    </p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── 欲望：改图之前要给你看的四行 ── */}
        <section className="px-5 py-20 sm:px-8 sm:py-28" id="gates">
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-14 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <div className="md:sticky md:top-32 md:self-start">
              <p className="font-mono text-[12px] tracking-[0.2em] text-ink-2 uppercase">
                一条都不省
              </p>
              <h2 className="font-display mt-5 text-[clamp(1.8rem,3.4vw,2.9rem)] leading-[1.12] font-bold tracking-[-0.025em] text-balance text-ink">
                动手之前，先看这四行
              </h2>
              <p className="mt-5 max-w-[44ch] text-[15px] leading-relaxed text-ink-2">
                这四行就是工具里的执行前确认卡。数字不是估的，文件也不是先改了再问你。
                你不点头，它连临时文件都不会建。
              </p>
            </div>
            <GateStack gates={GATES} />
          </div>
        </section>

        {/* ── 欲望：怎么用（三步） ── */}
        <section className="px-5 py-20 sm:px-8 sm:py-28" id="how">
          <div className="mx-auto max-w-6xl">
            <p className="font-mono text-[12px] tracking-[0.2em] text-ink-2 uppercase">
              三步
            </p>
            <h2 className="font-display mt-5 max-w-3xl text-balance text-[clamp(1.8rem,3.4vw,2.9rem)] leading-[1.12] font-bold tracking-[-0.025em] text-ink">
              装上，登记，改一笔
            </h2>

            <ol className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-3">
              {STEPS.map((s) => (
                <li
                  key={s.n}
                  data-bento="cell"
                  className="flex flex-col rounded-panel border border-line bg-surface p-6 shadow-lift"
                >
                  <span className="font-mono text-[13px] tracking-[0.14em] text-accent">{s.n}</span>
                  <h3 className="font-display mt-2.5 text-[20px] font-semibold tracking-tight text-ink">
                    {s.title}
                  </h3>
                  <p className="mt-3 text-[14px] leading-relaxed text-ink-2">{s.body}</p>
                  <pre className="mt-5 flex-1 overflow-x-auto rounded-lg border border-line bg-paper px-4 py-3 font-mono text-[11.5px] leading-[1.7] text-ink-2">
                    {s.code.join('\n')}
                  </pre>
                </li>
              ))}
            </ol>

            <p className="mt-6 text-[13.5px] leading-relaxed text-ink-3">
              画布必须用 http 打开：Chrome 禁止从 file:// 构造 Web Worker，MapLibre 起不来，地图会一片空白。
            </p>
          </div>
        </section>

        {/* ── 欲望：交付物 ── */}
        <section id="deliverables" className="relative bg-ink py-20 text-paper sm:py-28">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <p className="font-mono text-[11.5px] tracking-[0.2em] text-paper/70 uppercase">
              交差用得上的三样东西
            </p>
            <h2 className="font-display mt-5 max-w-3xl text-balance text-[clamp(1.8rem,3.4vw,2.9rem)] leading-[1.12] font-bold tracking-[-0.025em]">
              改完图，你还要能交代清楚
            </h2>
          </div>
          <Deliverables />
        </section>

        {/* ── 格式支持 ── */}
        <section className="px-5 py-20 sm:px-8 sm:py-28" id="formats">
          <div className="mx-auto max-w-6xl">
            <p className="font-mono text-[12px] tracking-[0.2em] text-ink-2 uppercase">
              格式支持
            </p>
            <h2 className="font-display mt-5 max-w-3xl text-balance text-[clamp(1.8rem,3.4vw,2.9rem)] leading-[1.12] font-bold tracking-[-0.025em] text-ink">
              打开就能看，能改的在这里
            </h2>
            <p className="mt-5 max-w-[56ch] text-[15px] leading-relaxed text-ink-2">
              不做中间格式转换，坐标系原样保留。下面按「能不能改」分开写，不含糊。
            </p>

            <div className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-3">
              {/* 能改 */}
              <div className="rounded-panel border border-accent/40 bg-accent-soft/45 p-6">
                <div className="flex items-center gap-2">
                  <CheckCircleIcon size={17} weight="fill" className="text-accent" />
                  <h3 className="font-display text-[17px] font-semibold text-ink">
                    能改 · 原样写回
                  </h3>
                </div>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">
                  写回的是原图件，格式、坐标系、伴随文件（.prj / .cpg / .tfw / .wld）都跟着走。
                  ArcGIS 打开不报"坐标系未知"。
                </p>
                <ul className="mt-5 space-y-2">
                  {WRITABLE.map((f) => (
                    <li key={f.ext} className="flex items-baseline gap-2.5">
                      <span className="font-mono text-[13.5px] font-medium text-ink">{f.ext}</span>
                      <span className="text-[12.5px] text-ink-3">{f.note}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* 只读栅格 */}
              <div className="rounded-panel border border-line bg-surface p-6 shadow-lift">
                <div className="flex items-center gap-2">
                  <span className="grid h-[17px] w-[17px] place-items-center rounded-full border border-ink-4 text-[10px] leading-none text-ink-3">
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
                    <li key={f.ext} className="flex items-baseline gap-2.5">
                      <span className="font-mono text-[13.5px] font-medium text-ink-2">{f.ext}</span>
                      <span className="text-[12.5px] text-ink-3">{f.note}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* 只读矢量 */}
              <div className="rounded-panel border border-line bg-surface p-6 shadow-lift">
                <div className="flex items-center gap-2">
                  <span className="grid h-[17px] w-[17px] place-items-center rounded-full border border-ink-4 text-[10px] leading-none text-ink-3">
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
                    <li key={f.ext} className="flex items-baseline gap-2.5">
                      <span className="font-mono text-[13.5px] font-medium text-ink-2">{f.ext}</span>
                      <span className="text-[12.5px] text-ink-3">{f.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ── 行动：许可与下载 ── */}
        <section className="px-5 py-20 sm:px-8 sm:py-28" id="download">
          <div className="rim-light relative mx-auto max-w-6xl overflow-hidden rounded-panel bg-ink px-7 py-14 text-paper shadow-diffuse sm:px-14 sm:py-16">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-24 -right-16 h-72 w-72 rounded-full bg-accent/35 blur-3xl"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-amber/22 blur-3xl"
            />
            <div className="relative grid grid-cols-1 gap-10 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] md:items-start">
              <div>
                <p className="font-mono text-[11.5px] tracking-[0.2em] text-paper/70 uppercase">
                  许可与下载
                </p>
                <h2 className="font-display mt-5 max-w-[20ch] text-balance text-[clamp(1.9rem,3.6vw,3.1rem)] leading-[1.1] font-bold tracking-[-0.03em]">
                  开源，Apache-2.0
                </h2>
                <p className="mt-5 max-w-[52ch] text-[15px] leading-relaxed text-paper/85">
                  整个仓库都能拿走改。下载包里有引擎、前端产物和安装脚本；自己 clone 也一样，
                  跑 <span className="font-mono text-[13px]">npm install</span> 就完事。
                </p>
                <div className="mt-7 flex flex-wrap gap-3">
                  <MagneticLink
                    href="https://github.com/Echovagant/cartouche/releases"
                    className="group inline-flex items-center gap-2 rounded-full bg-paper px-6 py-3 text-[14.5px] font-semibold whitespace-nowrap text-ink shadow-lift transition-colors hover:bg-accent hover:text-paper"
                  >
                    <DownloadSimpleIcon size={16} weight="bold" />
                    下载
                    <ArrowRightIcon
                      size={16}
                      weight="bold"
                      className="transition-transform duration-300 group-hover:translate-x-1"
                    />
                  </MagneticLink>
                  <MagneticLink
                    href="https://github.com/Echovagant/cartouche"
                    className="inline-flex items-center gap-2 rounded-full border border-paper/25 px-6 py-3 text-[14.5px] font-medium whitespace-nowrap text-paper transition-colors hover:border-paper/60"
                  >
                    <GitBranchIcon size={16} weight="bold" />
                    源码
                  </MagneticLink>
                </div>
              </div>

              <dl className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-1">
                <div>
                  <dt className="font-mono text-[11px] tracking-[0.16em] text-paper/70 uppercase">
                    前置条件
                  </dt>
                  <dd className="mt-1.5 text-[14px] leading-relaxed text-paper/90">
                    Node.js ≥ 22、GDAL 命令行。Windows 上装 GDAL 有现成脚本。
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[11px] tracking-[0.16em] text-paper/70 uppercase">
                    许可
                  </dt>
                  <dd className="mt-1.5 text-[14px] leading-relaxed text-paper/90">
                    Apache-2.0。第三方组件许可见仓库里的 NOTICE。
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[11px] tracking-[0.16em] text-paper/70 uppercase">
                    不含什么
                  </dt>
                  <dd className="mt-1.5 text-[14px] leading-relaxed text-paper/90">
                    不含、不分发任何 Esri 专有软件或数据。ArcGIS 是 Esri 的注册商标。
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[11px] tracking-[0.16em] text-paper/70 uppercase">
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
        </section>

        {/* ── 关于 ── */}
        <section className="px-5 py-20 sm:px-8 sm:py-28" id="about">
          <div className="mx-auto max-w-6xl">
            <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div>
                <p className="font-mono text-[12px] tracking-[0.2em] text-ink-2 uppercase">
                  关于
                </p>
                <h2 className="font-display mt-5 text-[clamp(1.8rem,3.4vw,2.9rem)] leading-[1.12] font-bold tracking-[-0.025em] text-balance text-ink">
                  图签，是贴在图角上那块牌子
                </h2>
                <p className="mt-5 max-w-[46ch] text-[15px] leading-relaxed text-ink-2">
                  图签 = 工程制图的图签；cartouche = 西方地图上的题签框。
                  名字是这么来的，做的还是那件实事：让改图和出图这两件事，
                  在你自己的电脑上就能走完。
                </p>
                <div className="mt-8 overflow-hidden rounded-panel border border-line bg-surface shadow-lift">
                  <CartouchePreview />
                </div>
              </div>

              <dl className="grid grid-cols-1 gap-8 sm:grid-cols-2">
                {ABOUT.map((a) => (
                  <div key={a.title}>
                    <dt className="font-display text-[17px] font-semibold text-ink">{a.title}</dt>
                    <dd className="mt-2 text-[14px] leading-relaxed text-ink-2">{a.body}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>
      </main>

      {/* ── 页脚：承担全站导航 ── */}
      <footer className="border-t border-line bg-paper px-5 py-12 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4 lg:grid-cols-6">
            <div className="col-span-2">
              <span className="flex items-center gap-2 text-ink">
                <MapTrifoldIcon size={16} weight="duotone" className="text-accent" />
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
                  { label: '能做什么', href: '#what' },
                  { label: '怎么用', href: '#how' },
                  { label: '交付物', href: '#deliverables' },
                ],
              },
              {
                title: '细节',
                links: [
                  { label: '改前确认', href: '#gates' },
                  { label: '格式支持', href: '#formats' },
                  { label: 'AI 接入', href: 'ai.html' },
                ],
              },
              {
                title: '获取',
                links: [
                  { label: '下载', href: '#download' },
                  { label: '源码', href: 'https://github.com/Echovagant/cartouche' },
                  { label: '画布', href: 'canvas.html' },
                ],
              },
              {
                title: '关于',
                links: [
                  { label: '项目说明', href: '#about' },
                  { label: '许可', href: 'https://github.com/Echovagant/cartouche/blob/main/LICENSE' },
                ],
              },
            ].map((col) => (
              <div key={col.title}>
                <p className="font-mono text-[12px] tracking-[0.16em] text-ink-2 uppercase">
                  {col.title}
                </p>
                <ul className="mt-3 space-y-2">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      <a
                        href={l.href}
                        className="text-[13px] text-ink-2 transition-colors hover:text-ink"
                      >
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-10 flex flex-col gap-3 border-t border-line pt-6 text-[12.5px] text-ink-3 sm:flex-row sm:items-center">
            <span className="font-mono">Apache-2.0</span>
            <span className="hidden h-3 w-px bg-line-2 sm:block" />
            <span>引擎本地运行 · 密钥不出本机</span>
            <span className="flex-1" />
            <span>图签 = 工程制图的图签；cartouche = 西方地图上的题签框</span>
          </div>
        </div>
      </footer>
    </>
  );
}
