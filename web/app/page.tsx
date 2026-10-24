import {
  ArrowDownIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  DownloadSimpleIcon,
  GitBranchIcon,
  MapTrifoldIcon,
} from '@phosphor-icons/react/dist/ssr';
import { MagneticLink } from './motion/MagneticLink';
import { Deliverables } from './motion/Deliverables';
import { GateStack } from './motion/GateStack';
import { ScrollChoreography } from './motion/ScrollChoreography';
import { formatPixelGate } from './motion/ConfirmCardBody';
import { SiteHeader } from './motion/SiteHeader';

/**
 * 落地页（服务端组件）。
 *
 * 结构按 S1–S8 八段排（表面色是唯一的分段手段）：
 *   S1 纸  Hero：首帧就是一张成品图面
 *   S2 墨  确认卡：改前先看清
 *   S3 厚纸 呼吸段：一个数字（全页唯一的真空段）
 *   S4 纸  四道闸门
 *   S5 墨  交付物三件实物
 *   S6 纸  装 → 登记 → 改一笔
 *   S7 纸  格式窄带（厚纸过渡带之后）
 *   S8 墨  开源 · 下载 · 图签框
 *
 * 这里是**纯静态**的：所有滚动编排、磁性按钮都在独立的 'use client'
 * 叶子组件里（见 ./motion），服务端组件只负责语义结构。
 *
 * ── 承诺纪律（本页的第一约束）────────────────────────────────────
 * 只写**已经交付**的能力。每写一句承诺，都要能在代码里指出对应的实现。
 * 反例（2026-10-22 删掉的）："用一句话说清要改什么" —— 那条 AI 链路
 * 当时还没有界面，写在首页就是骗人；"12 个格式一视同仁打勾" —— 其中 6 个
 * 矢量格式根本不能改，6 个栅格格式改完会换成 GeoTIFF。
 * 另一条：**不伪造数据**。页面上出现过的面积、坐标、操作人、日期都是编的，
 * 现在一律换成真实运行的录制值或真实截图。
 * 第三条（2026-10-24 晚，此条已作废）：当时写的是「矢量编辑仍未实现，
 * 所以官网按『矢量 · 只读』写」。现在**矢量编辑已经实现**（重投影、改字段名、
 * 值重编码、加字段、按位置连接、改属性、删要素…），GeoPackage 也能写回了 ——
 * 官网「格式支持」一屏已按实际能力重写。
 * 第四条（2026-10-24）：「用一句话改图」现在**有界面了**（画布上能发起，
 * AI 工作台里能提议 → 预演 → 确认 → 落盘），矢量 op 也接上了，
 * 所以首页不再挂「开发中」徽标，改成**一屏把三层分工说清楚**：
 * AI 只翻译意图、引擎算与写、你点头。
 * ——徽标表达的是"我们没测过"，不是"这功能弱"；能说清分工就不必靠徽标。
 * 第五条（2026-10-24）：**真实模型那条链路已经跑过了**——真 key 实测，
 * 4 类明确需求各 10 遍共 40 次提议全部命中正确的操作，歧义输入 10/10 被模型
 * 拒绝对并说清缺什么。所以 AI 工作台页面里那句话从「还没跑过」换成了实测数字。
 */

/* ── 导航 ── */

const NAV = [
  { href: '#s4', label: '能做什么' },
  { href: '#s-ai', label: '一句话改图' },
  { href: '#s2', label: '改前确认' },
  { href: '#s5', label: '改后交付' },
  { href: '#s6', label: '怎么用' },
  { href: '#s8', label: '下载' },
] as const;

/* ── 两次真实运行留下的像元口径 ──────────────────────────────────────
   涂色那次的执行前确认卡（截图见 web/public/site/confirm-card.jpg）：
     全图 1,200 个像元，这次会改 165 个（13.8%）。
   调色那次的预演结果：全图 1,200 个像元，会改 1,170 个（97.5%）。
   两个数字都来自真实运行，不是估的；口径脚注在页脚。 */

const PAINT_AFFECTED = 165;
const PAINT_TOTAL = 1200;
const RECOLOR_AFFECTED = 1170;

/**
 * 像元影响面的两段数字（不带百分比）。
 *
 * 数字与画布的 formatPixelGate 同源（同一个 toLocaleString 口径），
 * 免得官网和画布两处说法不一样。
 */
function pixelPair(affected: number, total: number): string {
  return `${affected.toLocaleString('zh-CN')} / ${total.toLocaleString('zh-CN')} 像元`;
}

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
 * 「一句话改图」里的三层分工。
 *
 * 为什么单独一屏，而不是在别处带一句：多数人判断不了"逐轴容差 0.02 米"，
 * 但判断得了"我说一句话它就绕开了箱子"——**分工**正是那句话能说清的东西。
 * 三层各干各的活：AI 只把话翻译成计划，数值与落盘归确定性引擎，最后由你点头。
 * 写清哪一段不归谁管，比写"AI 很厉害"有用得多。
 */
const AI_ROLES = [
  {
    who: 'AI · 只翻译',
    title: '把话变成一份操作计划',
    body: '做哪个动作、作用于哪个图层、参数是什么——它产出的是一份计划，不是结果。',
    not: '它不产出任何数值：像元数、面积、条数都不是它算的。',
  },
  {
    who: '确定性引擎 · 只算与写',
    title: '数值精度由它保证',
    body: '按契约校验这份计划，预演一遍算出影响面，你确认后才按确定性规则写盘。',
    not: '精度与用哪个模型无关；换模型只换坐前面的那个人。',
  },
  {
    who: '你 · 点头',
    title: '改之前看得见',
    body: '会改多少像元、改哪个文件、备份叫什么，三样都摆在你面前；改了什么记进项目留痕。',
    not: '不点头，一个字节都不动；改错了，备份就在原文件旁边。',
  },
];

/**
 * 首屏事实条：四个**可核对**的口径。
 *
 * 数字只有一条规矩：必须能说清是哪次运行、什么参数下的。
 * 这四条的出处（不许改口径时不说出处）：
 *   - 像元影响面：2026-10-22 一次真实涂色操作的执行前确认卡
 *     （web/public/site/confirm-card.jpg），数字与画布的 formatPixelGate 同源；
 *   - 目标文件：同一次运行里写回的那个文件；
 *   - 导出规格：引擎封单页 PDF 的默认页面参数（A4 横版 841.89×595.28 pt、
 *     图纸 DPI 150，见 src/engine/export/pdf.ts），前端不传这两个值；
 *   - 0 字节上传：引擎只监听回环地址（server/src/index.ts 的 HOST 默认
 *     127.0.0.1），图件的读写都在用户自己的文件夹里，引擎里没有任何
 *     上传/遥测代码。
 */
const HERO_FACTS = [
  {
    label: '将影响的像元',
    value: pixelPair(PAINT_AFFECTED, PAINT_TOTAL),
    note: '2026-10-22 一次真实涂色操作，占全图 13.8%',
  },
  {
    label: '目标文件',
    value: '底图.tff',
    note: '同一次运行：写回的就是这一个文件',
  },
  {
    label: '导出规格',
    value: 'A4 · 单页 · PDF',
    note: '引擎封单页 PDF 的默认页面参数与图纸 DPI',
  },
  {
    label: '上传量',
    value: '0 字节',
    note: '引擎只监听回环地址，图件读写都在本机文件夹',
  },
];

/* ── 怎么用：三步 ── */

const STEPS = [
  {
    n: '01',
    title: '解压',
    body: '下载绿色压缩包，解压，双击里面的 START.cmd。不用装 Node，不用装 GDAL，不用改设置——包里已经带全了。',
    code: [
      '图签-便携版.zip',
      '  └─ 解压到任意一个文件夹（路径里有中文、有空格都行）',
      '  └─ 双击 START.cmd',
      '',
      '# 第一次打开时它会顺手播一份示例数据，',
      '# 你可以先拿它练手，再换成自己的图件。',
    ],
  },
  {
    n: '02',
    title: '登记',
    body: '一个项目 = 一次交差任务。把你放图件的文件夹登记进来，工具在旁边建一个 .cartouche/ 放清单、产出物与留痕，你的图件一个字节都不会被搬动或改写。',
    code: [
      '# 在画布上：把放图件的文件夹填进去，点「登记并新建」',
      '# 自带示例数据在',
      '  %LOCALAPPDATA%\cartouche\workspace\示例数据',
      '# 你的东西和它放在一起，删掉便携包也不会丢。',
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

/**
 * 想自己装环境、要读源码的那条路。
 *
 * 为什么留在这儿而不是删掉：确实有人不要便携包（要接流水线、要改代码）。
 * 但它是**给程序员看的**，所以只留一行指路，细节在 GitHub README。
 */
const SOURCE_HINT = {
  title: '想自己装环境、要读源码？',
  body: '需要 Node.js 22 或更高，外加 GDAL 命令行。装完先自检一下，缺什么它会直接说。',
  code: [
    'npm install && npm run doctor',
    '# 完整步骤、密钥怎么放、数据会不会被发出去：见 GitHub 仓库的 README',
  ],
};

/* ── 格式支持：按"能不能改"分三组，不打太极 ── */

const WRITABLE = [
  { ext: '.tff', note: 'GeoTIFF 内容 + .tfw/.prj 伴随文件' },
  { ext: '.tif', note: 'GeoTIFF' },
  { ext: '.shp', note: 'Shapefile（一整套文件一起写回）' },
  { ext: '.geojson', note: 'GeoJSON' },
  { ext: '.gpkg', note: 'GeoPackage（只动你指定的那一层，别的层原样留着）' },
];

const READONLY_RASTER = [
  { ext: '.img', note: 'Erdas Imagine' },
  { ext: '.vrt', note: 'GDAL 虚拟栅格' },
  { ext: '.asc', note: 'ESRI ASCII Grid' },
  { ext: '.bil', note: 'Band Interleaved by Line' },
  { ext: '.png', note: '位图' },
];

const READONLY_VECTOR = [
  { ext: '.gdb', note: 'File Geodatabase' },
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
    body: '引擎只监听回环地址，图件的读写都在你自己的文件夹里。图件与像元不出本机，也不做遥测。接上模型服务后，图层清单（名称、字段、要素数、坐标系）会发给模型服务——发送前可以先看。',
  },
  {
    title: '不依赖商业授权',
    body: '引擎是纯 TypeScript + GDAL 命令行，界面是静态导出的前端，不含自动更新。装好就能用，不需要另外买许可证。',
  },
  {
    title: '能不能在 ArcGIS 里打开',
    body: '能。写回的是原图件，坐标系原样保留；坐标系的来源与伴随文件是否齐全，由兼容性自检报告逐项写清。',
  },
];

export default function Home() {
  return (
    <>
      <ScrollChoreography />

      <main id="main" className="w-full max-w-full overflow-x-hidden">
        {/* ── 导航：首屏顶部透明，滚过 16px 才获得实体 ── */}
        <SiteHeader items={NAV} />

        {/* ═══ S1 · Hero：首帧就是一张成品图面 ═════════════════════ */}
        <section
          id="s1"
          className="relative px-5 pt-28 pb-20 sm:px-8 sm:pt-36 sm:pb-24 lg:min-h-[100vh]"
        >
          <div className="mx-auto max-w-[1440px]">
            <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:items-center lg:gap-14">
              {/* 左：字 */}
              <div className="max-w-[64ch]">
                <p
                  data-hero="eyebrow"
                  className="reveal font-mono text-eyebrow text-ink-2 uppercase"
                >
                  本地运行 · 不联网
                </p>

                {/* 产品字标用**图像**（SVG），h1 让给断言。
                    DJI / Insta360 / NIO / 理想 四家都是这么做的。 */}
                <svg
                  data-hero="wordmark"
                  viewBox="0 0 196 40"
                  width={196}
                  height={40}
                  role="img"
                  aria-label="图签 Cartouche"
                  className="reveal mt-6 h-10 w-auto"
                >
                  <text
                    x={0}
                    y={29}
                    fontSize={30}
                    fontWeight={600}
                    className="font-display"
                    style={{ fill: 'var(--color-ink)' }}
                  >
                    图签
                  </text>
                  <line
                    x1={72}
                    y1={6}
                    x2={72}
                    y2={32}
                    strokeWidth={1}
                    style={{ stroke: 'var(--color-line-2)' }}
                  />
                  <text
                    x={86}
                    y={28}
                    fontSize={17}
                    fontWeight={500}
                    className="font-mono"
                    style={{ fill: 'var(--color-ink-2)', letterSpacing: '0.06em' }}
                  >
                    Cartouche
                  </text>
                </svg>

                <h1
                  data-hero="claim"
                  className="reveal font-display mt-6 text-pretty text-display-1 text-ink"
                >
                  <span className="block">改一笔，</span>出一张能交的图
                </h1>

                <div data-hero="cta" className="reveal mt-9 flex flex-wrap items-center gap-3">
                  <MagneticLink
                    href="#s8"
                    className="group inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-6 py-3 text-[15px] font-medium whitespace-nowrap text-paper transition-colors hover:bg-accent-deep"
                  >
                    下载
                    <ArrowRightIcon
                      aria-hidden="true"
                      size={16}
                      weight="bold"
                      className="transition-transform duration-[var(--duration-slow)] group-hover:translate-x-1"
                    />
                  </MagneticLink>
                  <a
                    href="#s2"
                    className="inline-flex min-h-11 items-center gap-2 rounded-full border border-ink px-6 py-3 text-[15px] font-medium whitespace-nowrap text-ink transition-colors hover:bg-surface"
                  >
                    看看它怎么确认
                    <ArrowDownIcon aria-hidden="true" size={16} weight="bold" />
                  </a>
                </div>
              </div>

              {/* 右：成品图面。
                  **第一帧就在这里** —— 不做入场动画（首帧即高潮）。
                  这张图是**图签自己出的**：Natural Earth 底图 + 公开行政区划
                  + 主要河流，图框、图例、比例尺、指北针、标题栏全是工具画的。
                  所以外面**不再套一层 CSS 图框** —— 图面自带图框，
                  再套一层会在 8px 内形成双线，看着像画错了。
                  只留一道发丝边 + 投影，让它像一张摊在制图台上的成图。 */}
              <figure data-hero="figure" className="relative">
                <div className="relative">
                  {/* 容器 aspect 必须跟成图一致（1756/1319 ≈ 1.331），
                      再用 object-contain 兜底 —— 图面一定完整。
                      WebP 是给页面读的（509KB），PNG 是原图（4.7MB，只在
                      不支持 WebP 时才下载）。 */}
                  <div className="relative aspect-[1756/1319] w-full overflow-hidden bg-surface shadow-product ring-1 ring-line">
                    <picture>
                      <source srcSet="./site/china-sheet.webp" type="image/webp" />
                      <img
                        src="./site/china-sheet.png"
                        alt="图签自己出的图面：中国省级行政区与主要河流图，带图例、比例尺、指北针与标题栏"
                        width={1756}
                        height={1319}
                        loading="eager"
                        decoding="async"
                        fetchPriority="high"
                        className="h-full w-full object-contain"
                      />
                    </picture>
                  </div>

                  {/* 工具 → 成品 的因果：确认卡浮在图面上。
                      位置避开图面自己画的四个要素
                      （指北针右上、图例与比例尺左下、标题栏右下），
                      压住的只是底图本身。 */}
                  <figure
                    data-hero="card"
                    className="reveal absolute left-[54%] top-[24%] z-10 w-[34%] rotate-[-1.2deg] overflow-hidden rounded-panel border border-line bg-surface shadow-product"
                  >
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
                <figcaption
                  data-hero="caption"
                  className="reveal mt-5 font-mono text-body-sm text-ink-3"
                >
                  示例：中国省级行政区与主要河流图 · 图签自己出的图面
                </figcaption>
              </figure>
            </div>

            {/* ── 事实条：四个能核对的口径（数字都带出处） ── */}
            <dl
              data-hero="facts"
              className="mt-14 grid grid-cols-1 gap-x-10 gap-y-6 border-t border-line pt-7 sm:grid-cols-2 lg:grid-cols-4"
            >
              {HERO_FACTS.map((f) => (
                <div key={f.label} data-hero="fact" className="reveal">
                  <dt className="font-mono text-[13px] tracking-[0.08em] text-ink-3 uppercase">
                    {f.label}
                  </dt>
                  <dd className="mono-num mt-2 font-mono text-[16px] leading-snug font-medium text-ink">
                    {f.value}
                  </dd>
                  <p className="mt-1.5 text-body-sm leading-[1.55] text-ink-3">{f.note}</p>
                </div>
              ))}
            </dl>

            <p
              data-hero="scrollhint"
              className="reveal mt-12 flex items-center gap-2 font-mono text-body-sm text-ink-3"
            >
              <ArrowDownIcon aria-hidden="true" size={15} weight="bold" />
              往下看会看到一张能交的图
            </p>
          </div>
        </section>

        {/* ═══ S2 · 确认卡：改前先看清 ═════════════════════════════ */}
        <section
          id="s2"
          data-surface-section="dark"
          className="relative overflow-hidden bg-ink py-24 text-paper sm:py-28 lg:min-h-[95vh]"
        >
          <div className="relative z-10 mx-auto grid max-w-[1440px] grid-cols-1 gap-12 px-5 sm:px-8 lg:grid-cols-[minmax(0,0.42fr)_minmax(0,0.58fr)] lg:gap-16">
            <div data-s2="head" className="reveal lg:sticky lg:top-32 lg:self-start">
              <p className="font-mono text-eyebrow text-paper/85 uppercase">改前先看清</p>
              <h2 className="font-display mt-6 text-pretty text-display-2 text-paper">
                改坏了怎么办？
              </h2>
              <p className="mt-6 max-w-[40ch] text-lead text-paper/85">
                你不点头，它连临时文件都不建。
              </p>

              {/* 三行解读：对应卡里的三行，但**不复述卡里的字** */}
              <ul className="mt-8 max-w-[42ch] space-y-4">
                <li data-s2="note" className="reveal text-body leading-relaxed text-paper/85">
                  先算给你看，再让你点头——点头之前，它连临时文件都不落地。
                </li>
                <li data-s2="note" className="reveal text-body leading-relaxed text-paper/85">
                  动的是你指的那一个文件本身，不是另存一份给你看。
                </li>
                <li data-s2="note" className="reveal text-body leading-relaxed text-paper/85">
                  退路先写在纸上：回滚就是把那份拷贝复制回去。
                </li>
              </ul>

              <a
                href="canvas.html"
                className="mt-8 inline-flex min-h-11 items-center gap-2 text-[15px] font-medium text-paper underline decoration-paper/40 underline-offset-4 transition-colors hover:decoration-paper"
              >
                打开画布看真的
                <ArrowRightIcon aria-hidden="true" size={15} weight="bold" />
              </a>
            </div>

            {/* 真实确认卡截图（暗底原图）：**不复刻**。
                复刻成纸色卡 = 「官网说的和真东西不一样」。 */}
            <figure data-s2="figure" className="reveal">
              <img
                src="./site/confirm-card.jpg"
                alt="工具里的执行前确认卡（真实截图）：四行闸门与「取消 / 确认执行」"
                width={556}
                height={398}
                loading="lazy"
                decoding="async"
                className="w-full rounded-panel border border-ink-line"
              />
              <figcaption className="mt-4 font-mono text-body-sm leading-relaxed text-paper/85">
                示例：2026-10-22 的一次真实涂色操作 —— 这就是工具里的那张卡
              </figcaption>
            </figure>
          </div>
        </section>

        {/* ═══ S3 · 呼吸段：一个数字（全页唯一的真空段） ═══════════ */}
        <section
          id="s3"
          className="flex min-h-[70vh] items-center bg-paper-deep px-5 py-20 sm:px-8 sm:py-24"
        >
          <div className="mx-auto w-full max-w-[1200px]">
            <p data-s3="denial" className="reveal text-lead font-medium text-ink-2">
              不是「已修改」
            </p>

            <p
              data-s3="figure"
              className="reveal mt-6 flex flex-wrap items-baseline gap-x-5 gap-y-2 font-mono text-hero-figure text-ink tnum"
            >
              {RECOLOR_AFFECTED.toLocaleString('zh-CN')}{' '}
              <span className="text-ink-3">/</span> {PAINT_TOTAL.toLocaleString('zh-CN')}
              <span className="font-mono text-[clamp(1rem,1.7vw,1.45rem)] font-medium text-ink-2">
                （{((RECOLOR_AFFECTED / PAINT_TOTAL) * 100).toFixed(1)}%）
              </span>
            </p>

            <p data-s3="note" className="reveal mt-6 max-w-[48ch] text-body text-ink-2">
              一次真实<strong className="font-semibold text-ink">调色</strong>操作的预演结果：全图{' '}
              {PAINT_TOTAL.toLocaleString('zh-CN')} 个像元里会改{' '}
              {RECOLOR_AFFECTED.toLocaleString('zh-CN')} 个。数字是算出来的，不是估的——摆出来，你自己判断值不值。
            </p>

            {/* 这个数字从哪来：指向 S2 确认卡的第 1 行（机制），并说清是哪一次运行 */}
            <p data-s3="source" className="reveal mt-4 max-w-[56ch] text-body-sm leading-relaxed text-ink-3">
              这个数字从哪来 →{' '}
              <a href="#s2" className="text-ink-2 underline underline-offset-4 hover:text-ink">
                S2 确认卡的第 1 行
              </a>
              ：影响面先算出来，再让你点头。这一条是<strong className="font-semibold text-ink-2">调色</strong>那次的记录；涂色那次是{' '}
              {formatPixelGate(PAINT_AFFECTED, PAINT_TOTAL, PAINT_AFFECTED / PAINT_TOTAL)}。
            </p>
          </div>
        </section>

        {/* ═══ S4 · 四道闸门（信息密度峰） ═══════════════════════════ */}
        <section
          id="s4"
          className="bg-paper px-5 pt-16 pb-28 sm:px-8 sm:pt-20 sm:pb-36 lg:min-h-[145vh]"
        >
          <div className="mx-auto grid max-w-[1440px] grid-cols-1 gap-14 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <div data-section-head className="reveal md:sticky md:top-32 md:self-start">
              <p className="font-mono text-eyebrow text-ink-2 uppercase">一条都不省</p>
              <h2 className="font-display mt-6 text-pretty text-display-2 text-ink">
                改之前，它会先问你什么？
              </h2>
              <p className="mt-6 max-w-[44ch] text-lead text-ink-2">
                这四行就是工具里的执行前确认卡。数字不是估的，文件也不是先改了再问你。
              </p>
            </div>
            <GateStack gates={GATES} />
          </div>
        </section>

        {/* ═══ S-AI · 一句话改图，谁来做什么 ══════════════════════ */}
        <section id="s-ai" className="bg-paper px-5 py-24 sm:px-8 sm:py-28 lg:min-h-[95vh]">
          <div className="mx-auto max-w-[1440px]">
            <div data-section-head className="reveal">
              <p className="font-mono text-eyebrow text-ink-2 uppercase">谁来做哪一段</p>
              <h2 className="font-display mt-6 max-w-3xl text-pretty text-display-2 text-ink">
                一句话改图，谁来做什么？
              </h2>
              <p className="mt-6 max-w-[52ch] text-lead text-ink-2">
                你只管说想要什么。中间这几段活儿分给谁、哪一段不归谁管——
                说清楚，你就知道该信哪一段。
              </p>
            </div>

            {/* 不等宽三栏：等分栅格是 2015 年 SaaS 模板 */}
            <div className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-[1.25fr_1fr_1.15fr]">
              {AI_ROLES.map((r) => (
                <div
                  key={r.who}
                  data-ai-role="card"
                  className="reveal flex flex-col rounded-panel border border-line bg-surface p-6"
                >
                  <p className="font-mono text-[12px] tracking-[0.08em] text-ink-3">{r.who}</p>
                  <h3 className="font-display mt-2.5 text-display-3 text-ink">{r.title}</h3>
                  <p className="mt-3 text-body leading-relaxed text-ink-2">{r.body}</p>
                  <p className="mt-4 border-t border-line pt-3 text-body-sm leading-relaxed text-ink-3">
                    {r.not}
                  </p>
                </div>
              ))}
            </div>

            <p className="mt-8 max-w-[68ch] text-body-sm leading-relaxed text-ink-3">
              换掉模型不影响这套流程——引擎和运算表不变，只是坐在前面的操作员换了人。
            </p>
            <p className="mt-4 max-w-[68ch] text-body-sm leading-relaxed text-ink-3">
              图件本体一个字节都不出你的电脑。用 AI 时发走的只有上面那几行元数据，
              和你视窗内最多 200 个要素的坐标与少量属性——发出去之前，你能逐字看。
            </p>
            <p className="mt-4 max-w-[68ch] text-body-sm leading-relaxed text-ink-3">
              这条路我们用真模型反复试过：4 类不同的要求各来 10 遍，40 次全部改对了该改的东西；
              说得含糊的时候它不猜，会反问你缺哪一项。
            </p>
          </div>
        </section>

        {/* ═══ S5 · 交付物三件实物（画面强度峰） ═════════════════════ */}
        <section
          id="s5"
          data-surface-section="dark"
          className="relative overflow-hidden bg-ink py-28 text-paper sm:py-32 lg:min-h-[125vh]"
        >
          <div className="relative z-10 mx-auto max-w-[1440px] px-5 sm:px-8">
            <div data-section-head className="reveal">
              <p className="font-mono text-eyebrow text-paper/85 uppercase">
                交差用得上的三样东西
              </p>
              <h2 className="font-display mt-6 max-w-3xl text-pretty text-display-2 text-paper">
                改完，拿什么去交差？
              </h2>
            </div>
          </div>
          <Deliverables />
        </section>

        {/* ═══ S6 · 装 → 登记 → 改一笔 ══════════════════════════════ */}
        <section
          id="s6"
          className="bg-paper px-5 py-24 sm:px-8 sm:py-28 lg:min-h-[85vh]"
        >
          <div className="mx-auto max-w-[1200px]">
            <div data-section-head className="reveal">
              <p className="font-mono text-eyebrow text-ink-2 uppercase">三步</p>
              <h2 className="font-display mt-6 max-w-3xl text-pretty text-display-2 text-ink">
                怎么把它跑起来？
              </h2>
              <p className="mt-6 max-w-[56ch] text-lead text-ink-2">
                不用装任何东西——解压、双击，就能用。
              </p>
            </div>

            {/* 不等宽三栏（40 / 35 / 25）：等分栅格是 2015 年 SaaS 模板 */}
            <ol className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1.75fr_1.25fr]">
              {STEPS.map((s) => (
                <li
                  key={s.n}
                  data-step="item"
                  className="reveal flex flex-col rounded-panel border border-line bg-surface p-6"
                >
                  <span className="font-mono text-[13px] tracking-[0.08em] text-ink-3">{s.n}</span>
                  <h3 className="font-display mt-2.5 text-display-3 text-ink">
                    {s.title}
                  </h3>
                  <p className="mt-3 text-body leading-relaxed text-ink-2">{s.body}</p>
                  <pre
                    data-step="code"
                    className="reveal mt-5 flex-1 overflow-x-auto rounded-lg border border-line bg-paper px-4 py-3 font-mono text-[13px] leading-[1.7] text-ink-2"
                  >
                    {s.code.join('\n')}
                  </pre>
                </li>
              ))}
            </ol>

            <p className="mt-6 text-body-sm leading-relaxed text-ink-3">
              画布必须用 http 打开：Chrome 禁止从 file:// 构造 Web Worker，MapLibre
              起不来，地图会一片空白。
            </p>

            {/* 源码跑法：给程序员看的，细节在 GitHub README */}
            <div className="mt-4 rounded-panel border border-line bg-surface p-6">
              <h3 className="font-display text-display-3 text-ink">{SOURCE_HINT.title}</h3>
              <p className="mt-2.5 text-body leading-relaxed text-ink-2">{SOURCE_HINT.body}</p>
              <pre
                data-step="code"
                className="mt-4 overflow-x-auto rounded-lg border border-line bg-paper px-4 py-3 font-mono text-[13px] leading-[1.7] text-ink-2"
              >
                {SOURCE_HINT.code.join('\n')}
              </pre>
            </div>
          </div>
        </section>

        {/* 厚纸过渡带：s6 与 s7 之间靠表面色阶断开（不是投影、不是描边） */}
        <div aria-hidden="true" className="h-40 bg-paper-deep" />

        {/* ═══ S7 · 格式窄带 ═══════════════════════════════════════ */}
        <section id="s7" className="bg-paper px-5 pt-10 pb-28 sm:px-8 sm:pb-32 lg:min-h-[85vh]">
          <div className="mx-auto max-w-[1200px]">
            <div data-section-head className="reveal">
              <p className="font-mono text-eyebrow text-ink-2 uppercase">格式支持</p>
              <h2 className="font-display mt-6 max-w-3xl text-pretty text-display-2 text-ink">
                我的文件，能不能改？
              </h2>
              <p className="mt-6 max-w-[56ch] text-lead text-ink-2">
                不做中间格式转换，坐标系原样保留。下面按「能不能改」分开写，不含糊。
              </p>
              {/* 可照着做：把这一段名单直接复制走 */}
              <p className="mt-4 font-mono text-body-sm text-ink-3">Ctrl+C 可复制本段</p>
            </div>

            <div className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-3">
              {/* 能改 */}
              <div
                data-format="group"
                className="reveal rounded-panel border border-line border-l-[3px] border-l-accent bg-surface p-6"
              >
                <div className="flex items-center gap-2">
                  <CheckCircleIcon aria-hidden="true" size={17} weight="fill" className="text-ink-2" />
                  <h3 className="font-display text-display-3 text-ink">
                    能改 · 原样写回
                  </h3>
                </div>
                <p className="mt-2.5 text-body leading-relaxed text-ink-2">
                  写回的是原图件，格式与坐标系原样保留。
                  坐标系是内嵌还是来自伴随文件，自检报告会写明——<strong className="font-semibold text-ink">内嵌的</strong>才能在别的软件里也认出来。
                </p>
                <p className="mt-2 text-body-sm leading-relaxed text-ink-3">
                  高程那类栅格（32 位整数、单精度浮点）也能改：读进来是什么数位，写回去还是什么数位，
                  <strong className="font-semibold text-ink-2">不会被悄悄压成 8 位</strong>。
                </p>
                <ul className="mt-5 space-y-2">
                  {WRITABLE.map((f) => (
                    <li key={f.ext} data-format="row" className="flex items-baseline gap-2.5">
                      <span className="mono-num font-mono text-[14px] font-medium text-ink">{f.ext}</span>
                      <span className="text-body-sm text-ink-3">{f.note}</span>
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
                  <h3 className="font-display text-display-3 text-ink">
                    能看能导出 · 不改
                  </h3>
                </div>
                <p className="mt-2.5 text-body leading-relaxed text-ink-2">
                  能打开、能出图、能查属性、能导出。写回统一产出 GeoTIFF，改了会换格式，
                  所以工具会明确拒绝，而不是把文件改坏。
                </p>
                <ul className="mt-5 space-y-2">
                  {READONLY_RASTER.map((f) => (
                    <li key={f.ext} data-format="row" className="flex items-baseline gap-2.5">
                      <span className="mono-num font-mono text-[14px] font-medium text-ink-2">{f.ext}</span>
                      <span className="text-body-sm text-ink-3">{f.note}</span>
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
                  <h3 className="font-display text-display-3 text-ink">
                    矢量 · 只读
                  </h3>
                </div>
                <p className="mt-2.5 text-body leading-relaxed text-ink-2">
                  这几个格式我们只读不写：能出图、能查属性、能导出。
                  要改它们，先另存成上面那几种之一。
                </p>
                <ul className="mt-5 space-y-2">
                  {READONLY_VECTOR.map((f) => (
                    <li key={f.ext} data-format="row" className="flex items-baseline gap-2.5">
                      <span className="mono-num font-mono text-[14px] font-medium text-ink-2">{f.ext}</span>
                      <span className="text-body-sm text-ink-3">{f.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* 台阶：s8 之前留一段厚纸，「落地」有落下去的感觉 */}
        <div aria-hidden="true" className="h-24 bg-paper-deep" />

        {/* ═══ S8 · 开源 · 下载 · 图签框 ══════════════════════════════ */}
        <section
          id="s8"
          data-surface-section="dark"
          className="relative overflow-hidden bg-ink py-24 text-paper sm:py-28 lg:min-h-[75vh]"
        >
          <div className="relative z-10 mx-auto max-w-[1440px] px-5 sm:px-8">
            <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-16">
              {/* 左：下载 / 源码 / 许可 / 不含什么 */}
              <div
                data-s8="panel"
                className="reveal relative overflow-hidden rounded-panel border border-ink-line bg-ink-surface p-7 sm:p-10"
              >
                <div className="relative">
                  <p className="font-mono text-eyebrow text-paper/85 uppercase">许可与下载</p>
                  <h2 className="font-display mt-6 max-w-[20ch] text-pretty text-display-2 text-paper">
                    能拿走自己改吗？
                  </h2>
                  <p className="mt-6 max-w-[52ch] text-body leading-relaxed text-paper/85">
                    不用装任何东西：下载<strong className="font-semibold text-paper">绿色便携包</strong>，
                    解压，双击 <span className="font-mono text-[14px]">START.cmd</span> 就能用——
                    Node 与 GDAL 都在包里了。里面还带一份示例数据，你的工作区放在
                    <span className="font-mono text-[14px]">%LOCALAPPDATA%</span> 下，删掉这个包也不丢图件。
                  </p>
                  <p className="mt-3 max-w-[52ch] text-body-sm leading-relaxed text-paper/70">
                    整个仓库也都能拿走改。自己在本地跑的话，需要 Node.js ≥ 22 与 GDAL 命令行，
                    装完跑 <span className="font-mono text-[14px]">npm install</span> 就完事——
                    详细步骤见 GitHub 仓库的 README。
                  </p>

                  <div className="mt-8 flex flex-wrap gap-3">
                    <a
                      href="https://github.com/Echovagant/cartouche/releases"
                      className="group inline-flex min-h-11 items-center gap-2 rounded-full bg-paper px-6 py-3 text-[15px] font-semibold whitespace-nowrap text-ink transition-colors hover:bg-surface"
                    >
                      <DownloadSimpleIcon aria-hidden="true" size={16} weight="bold" />
                      下载
                      <ArrowRightIcon
                        aria-hidden="true"
                        size={16}
                        weight="bold"
                        className="transition-transform duration-[var(--duration-slow)] group-hover:translate-x-1"
                      />
                    </a>
                    <a
                      href="https://github.com/Echovagant/cartouche"
                      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-paper/50 px-6 py-3 text-[15px] font-medium whitespace-nowrap text-paper transition-colors hover:border-paper/70"
                    >
                      <GitBranchIcon aria-hidden="true" size={16} weight="bold" />
                      源码
                    </a>
                  </div>

                  <dl className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2">
                    <div>
                      <dt className="font-mono text-[13px] tracking-[0.08em] text-paper/85 uppercase">
                        前置条件
                      </dt>
                      <dd className="mt-1.5 text-body leading-relaxed text-paper/85">
                        用便携包：没有前置条件，解压就能用。
                        <br />
                        自己跑源码：Node.js ≥ 22、GDAL 命令行，Windows 上有现成安装脚本。
                      </dd>
                    </div>
                    <div>
                      <dt className="font-mono text-[13px] tracking-[0.08em] text-paper/85 uppercase">
                        许可
                      </dt>
                      <dd className="mt-1.5 text-body leading-relaxed text-paper/85">
                        Apache-2.0。第三方组件许可见仓库里的 NOTICE。
                      </dd>
                    </div>
                    <div>
                      <dt className="font-mono text-[13px] tracking-[0.08em] text-paper/85 uppercase">
                        不含什么
                      </dt>
                      <dd className="mt-1.5 text-body leading-relaxed text-paper/85">
                        不含、不分发任何 Esri 专有软件或数据。ArcGIS 是 Esri 的注册商标。
                      </dd>
                    </div>
                    <div>
                      <dt className="font-mono text-[13px] tracking-[0.08em] text-paper/85 uppercase">
                        要加模型
                      </dt>
                      <dd className="mt-1.5 text-body leading-relaxed text-paper/85">
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

              {/* 右：图签框特写（真实工作台截图的裁切）+ 4 条 About */}
              <div>
                <div
                  data-s8="closeup"
                  className="reveal relative overflow-hidden rounded-panel border border-ink-line bg-ink-surface p-6"
                >
                  <div className="aspect-[326/78] w-full">
                    {/* 真实工作台截图的一角：图签（标题栏）特写。
                        不画示意图——官网说的要和真东西一样。 */}
                    <svg
                      viewBox="904 702 326 78"
                      className="h-full w-full"
                      role="img"
                      aria-label="出图工作台图面右下角的图签特写：图名、出图时间与操作人"
                    >
                      <image
                        href="./site/canvas-frame.jpg"
                        x={0}
                        y={0}
                        width={1578}
                        height={802}
                      />
                    </svg>
                  </div>
                  <p className="mt-4 font-mono text-body-sm text-paper/85">
                    图签框特写 · 出图工作台实拍
                  </p>
                </div>

                <dl className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2">
                  {ABOUT.map((a) => (
                    <div key={a.title} data-s8="about" className="reveal">
                      <dt className="font-display text-[17px] font-semibold text-paper">{a.title}</dt>
                      <dd className="mt-2 text-body leading-relaxed text-paper/85">{a.body}</dd>
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
                <MapTrifoldIcon aria-hidden="true" size={16} weight="duotone" className="text-ink-3" />
                <span className="font-display text-[15px] font-semibold">图签 Cartouche</span>
              </span>
              <p className="mt-3 max-w-[34ch] text-body-sm leading-relaxed text-ink-3">
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
                  { label: 'AI 接入', href: 'ai.html' },
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
                <p className="font-mono text-[13px] tracking-[0.08em] text-ink-2 uppercase">
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
          <div className="mt-8 border-t border-line pt-6 text-body-sm leading-relaxed text-ink-3">
            <p>
              口径说明：页面上的像元数与百分比来自 2026-10-22
              的<strong className="font-semibold text-ink-2">两次</strong>真实运行记录——一次涂色（165 / 1 200）与一次调色（1 170 / 1 200），原始留痕在项目的
              <span className="font-mono">.cartouche/history.jsonl</span> 里。不同数据源的像元大小与精度不同，像元数、影响面与比例尺会随之变化。
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
