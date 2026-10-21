import Link from 'next/link';
import {
  ArrowRightIcon,
  CheckCircleIcon,
  CompassIcon,
  FilePdfIcon,
  GaugeIcon,
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
 * 结构按 AIDA：导航 → 注意（Hero）→ 兴趣（Bento）→ 欲望（工序横移 + 闸门堆叠）→ 行动（CTA）。
 *
 * 这里是**纯静态**的：所有滚动编排、磁性按钮、动态图形都在独立的
 * 'use client' 叶子组件里（见 ./motion），服务端组件只负责语义结构。
 */

const CAPABILITIES = [
  {
    icon: ShieldCheckIcon,
    kicker: '四道闸门',
    title: 'AI 只出方案，不碰你的文件',
    body: '模型唯一合法产物是一份操作计划。执行由确定性引擎完成，Schema 校验、前置校验、量化影响报告、逐项确认，一步都省不掉。',
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
    title: '说清楚动了多少',
    body: '影响像元数、涉及要素数、净面积变化、拓扑检查结果，逐项列出来给你看。',
    span: 'md:col-span-2 lg:col-span-2',
    tone: 'paper',
  },
  {
    icon: FilePdfIcon,
    kicker: '交差材料',
    title: '转给同事就能用',
    body: '带图框与标题栏的 PDF 图件，加上自检报告——对方不用装这个软件也能确认文件没问题。',
    span: 'md:col-span-2 lg:col-span-2',
    tone: 'paper',
  },
  {
    icon: LockKeyIcon,
    kicker: '保密',
    title: '图件不出本机',
    body: '不连在线底图，不上传数据。密钥加密存本地，模型调用前先给你看要发什么。',
    span: 'md:col-span-2 lg:col-span-2',
    tone: 'ink',
  },
] as const;

const GATES = [
  {
    n: '01',
    title: 'Schema 校验',
    body: '操作计划必须严格符合契约。字段缺失、类型不对、引用了不存在的图层——在碰你的数据之前就被挡下来。',
  },
  {
    n: '02',
    title: '前置校验',
    body: '坐标系是否一致、分辨率是否对齐、目标是否被占用、几何是否有效。条件不满足就换方案，不硬来。',
  },
  {
    n: '03',
    title: '量化影响报告',
    body: '这次会改多少像元、涉及多少要素、净面积变化多少、拓扑会不会破。数字摆出来，你自己判断值不值。',
  },
  {
    n: '04',
    title: '人工确认',
    body: '每一项改动都要你点头。没有静默落盘，没有"顺手替你改了"。',
  },
];

const FORMATS = [
  '.tff',
  '.shp',
  '.gdb',
  '.gpkg',
  '.asc',
  '.bil',
  '.img',
  '.geojson',
  '.kml',
  '.gml',
  '.vrt',
  '.png',
];

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
              className="flex items-center gap-2.5 text-[13.5px] font-medium tracking-tight text-ink"
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-accent text-paper">
                <CompassIcon size={15} weight="bold" />
              </span>
              图签 Cartouche
            </Link>
            <span className="hidden h-4 w-px bg-line-2 sm:block" />
            <span className="hidden font-mono text-[11.5px] tracking-wide text-ink-3 sm:block">
              AI 地图修改工作台
            </span>
            <span className="flex-1" />
            <a
              href="#gates"
              className="rounded-full px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:text-ink"
            >
              工作方式
            </a>
            <a
              href="#deliverables"
              className="hidden rounded-full px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:text-ink sm:block"
            >
              交付物
            </a>
            <MagneticLink
              href="canvas.html"
              className="rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-paper shadow-lift transition-colors hover:bg-accent-deep"
            >
              打开画布
            </MagneticLink>
          </nav>
        </header>

        {/* ── 注意：Hero ── */}
        <section className="relative px-5 pt-36 pb-24 sm:px-8 sm:pt-44">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[720px] overflow-hidden"
          >
            <CartouchePreview />
            <div className="absolute inset-0 bg-[radial-gradient(130%_92%_at_50%_20%,rgba(244,241,234,0)_0%,rgba(244,241,234,0.22)_48%,rgba(244,241,234,0.68)_84%,var(--color-paper)_100%)]" />
          </div>

          <div className="mx-auto max-w-6xl text-center">
            <p
              data-hero="eyebrow"
              className="font-mono text-[11.5px] tracking-[0.2em] text-ink-3 uppercase"
            >
              本机运行 · 数据不出本机 · 不依赖商业 GIS 授权
            </p>

            <h1
              data-hero="title"
              className="font-display mx-auto mt-7 max-w-6xl text-balance text-[clamp(2.4rem,5.4vw,4.6rem)] leading-[1.04] font-bold tracking-[-0.03em] text-ink"
            >
              改一处标注，
              <br className="sm:hidden" />
              不必先学一整套 ArcGIS
            </h1>

            <p
              data-hero="body"
              className="mx-auto mt-7 max-w-[62ch] text-pretty text-[17px] leading-relaxed text-ink-2"
            >
              用一句话说清要改什么，图签给出可核对的修改方案和影响范围；你确认后由确定性引擎写回原图件。
              ArcGIS 照常打开，全程留痕，交付材料一并给出。
            </p>

            <div data-hero="cta" className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <MagneticLink
                href="canvas.html"
                className="group inline-flex items-center gap-2 rounded-full bg-ink px-6 py-3 text-[14.5px] font-medium text-paper shadow-lift transition-colors hover:bg-accent-deep"
              >
                打开地图画布
                <ArrowRightIcon
                  size={16}
                  weight="bold"
                  className="transition-transform duration-300 group-hover:translate-x-1"
                />
              </MagneticLink>
              <MagneticLink
                href="#gates"
                className="inline-flex items-center gap-2 rounded-full border border-line-2 bg-surface px-6 py-3 text-[14.5px] font-medium text-ink transition-colors hover:border-ink-4"
              >
                它怎么保证不出错
              </MagneticLink>
            </div>
          </div>
        </section>

        {/* ── 兴趣：Bento 能力矩阵（无空格子，grid-flow-dense） ── */}
        <section className="px-5 py-24 sm:px-8 sm:py-32" id="capabilities">
          <div className="mx-auto max-w-6xl">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-4 lg:grid-cols-6">
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
                        dark ? 'text-paper/55' : 'text-ink-4'
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
                        dark ? 'text-paper/72' : 'text-ink-2'
                      }`}
                    >
                      {c.body}
                    </p>
                  </article>
                );
              })}
            </div>

            {/* 格式支持：错落列表（staggered list） */}
            <div className="mt-16 grid grid-cols-1 gap-8 border-t border-line pt-12 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <div>
                <h2 className="font-display text-[clamp(1.6rem,2.6vw,2.15rem)] leading-tight font-bold tracking-[-0.02em] text-balance">
                  打开什么格式，就改什么格式
                </h2>
                <p className="mt-4 max-w-[46ch] text-[15px] leading-relaxed text-ink-2">
                  不做中间格式转换，坐标系、原样保留。写回之后 ArcGIS Pro 照常打开，
                  栅格的坐标系照样内嵌在世界文件里。
                </p>
              </div>
              <ul data-stagger="list" className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                {FORMATS.map((f) => (
                  <li
                    key={f}
                    className="flex items-center gap-2 border-b border-line/70 py-2 font-mono text-[13.5px] text-ink-2"
                  >
                    <CheckCircleIcon size={14} weight="fill" className="text-accent" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ── 欲望：交付物三联卡（普通网格，滚轮不接管） ── */}
        <section id="deliverables" className="relative bg-ink py-24 text-paper sm:py-32">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <p className="font-mono text-[11.5px] tracking-[0.2em] text-paper/50 uppercase">
              交差用得上的三样东西
            </p>
            <h2 className="font-display mt-5 max-w-3xl text-balance text-[clamp(1.8rem,3.4vw,2.9rem)] leading-[1.12] font-bold tracking-[-0.025em]">
              改完图，你还要能交代清楚
            </h2>
          </div>
          <Deliverables />
        </section>

        {/* ── 欲望：四道闸门（pin + 堆叠） ── */}
        <section id="gates" className="px-5 py-24 sm:px-8 sm:py-32">
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-14 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <div className="md:sticky md:top-32 md:self-start">
              <p className="font-mono text-[11.5px] tracking-[0.2em] text-ink-4 uppercase">
                一条都不省
              </p>
              <h2 className="font-display mt-5 text-[clamp(1.8rem,3.4vw,2.9rem)] leading-[1.12] font-bold tracking-[-0.025em] text-balance">
                凭什么敢让 AI 碰你的图
              </h2>
              <p className="mt-5 max-w-[44ch] text-[15px] leading-relaxed text-ink-2">
                因为它碰不到。四道闸门把"出方案"和"落盘"彻底分开：
                模型写的每一步都要先过校验，再给你看影响，最后等你点头。
              </p>
            </div>
            <GateStack gates={GATES} />
          </div>
        </section>

        {/* ── 行动 ── */}
        <section className="px-5 pb-28 sm:px-8 sm:pb-36">
          <div className="rim-light relative mx-auto max-w-6xl overflow-hidden rounded-panel bg-ink px-7 py-16 text-paper shadow-diffuse sm:px-14 sm:py-20">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-24 -right-16 h-72 w-72 rounded-full bg-accent/35 blur-3xl"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-amber/22 blur-3xl"
            />
            <div className="relative grid grid-cols-1 gap-10 md:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)] md:items-end">
              <div>
                <p className="font-mono text-[11.5px] tracking-[0.2em] text-paper/50 uppercase">
                  装在你自己电脑上
                </p>
                <h2 className="font-display mt-5 max-w-[18ch] text-balance text-[clamp(1.9rem,3.6vw,3.1rem)] leading-[1.1] font-bold tracking-[-0.03em]">
                  把工作区的图件拖进来，先看一眼
                </h2>
                <p className="mt-5 max-w-[48ch] text-[15px] leading-relaxed text-paper/70">
                  画布直接读你工作区里的文件：栅格按视口出图、矢量点开查属性，
                  一键出带图框的 PDF 和自检报告。数据全程留在本机。
                </p>
              </div>
              <div className="flex flex-col items-start gap-4 md:items-end">
                <MagneticLink
                  href="canvas.html"
                  className="group inline-flex items-center gap-2 rounded-full bg-paper px-6 py-3 text-[14.5px] font-semibold text-ink shadow-lift transition-colors hover:bg-accent hover:text-paper"
                >
                  打开地图画布
                  <ArrowRightIcon
                    size={16}
                    weight="bold"
                    className="transition-transform duration-300 group-hover:translate-x-1"
                  />
                </MagneticLink>
                <p className="font-mono text-[11.5px] text-paper/45">
                  Apache-2.0 · 引擎本地运行 · 密钥不出本机
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line px-5 py-10 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 text-[12.5px] text-ink-3 sm:flex-row sm:items-center">
          <span className="flex items-center gap-2 text-ink">
            <MapTrifoldIcon size={15} weight="duotone" className="text-accent" />
            图签 Cartouche
          </span>
          <span className="hidden h-3 w-px bg-line-2 sm:block" />
          <span className="font-mono">Apache-2.0</span>
          <span className="flex-1" />
          <span>图签 = 工程制图的图签；cartouche = 西方地图上的题签框</span>
        </div>
      </footer>
    </>
  );
}
