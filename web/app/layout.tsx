import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';

/**
 * 字体自托管（next/font/local）。
 *
 * 为什么不用 next/font/google：本工具的承诺是"数据不出本机、可离线使用"，
 * 构建期也不该依赖外网——否则断网环境根本装不上。字体文件随仓库走。
 *
 * 分工（有意为之，不是摇摆）：
 *   - **Geist** → 展示字与正文字：几何无衬线，笔画收得住，大标题不糊；
 *     小字号下字腔更紧，密集工具界面里更精确。
 *   - **Geist Mono** → 一切数字、路径、字段名（图签的产出是要拿去对账的）。
 * 中文字形这两套都覆盖不到，统一回落到系统的苹方/雅黑。
 *
 * 许可：Geist 是 SIL OFL 1.1，可商用、可随仓库分发（附上许可声明即可）。
 */
const geist = localFont({
  src: '../fonts/geist.woff2',
  variable: '--font-geist',
  display: 'swap',
  weight: '100 900',
  fallback: ['ui-sans-serif', 'system-ui', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
});

const geistMono = localFont({
  src: '../fonts/geist-mono.woff2',
  variable: '--font-geist-mono',
  display: 'swap',
  weight: '100 900',
  fallback: ['ui-monospace', 'SFMono-Regular', 'JetBrains Mono', 'monospace'],
});

/**
 * 站点地址。
 *
 * 站点挂在 GitHub Pages 的 **子路径** `/cartouche/` 下，所以 metadataBase
 * 必须带上这段路径：Next 解析相对的 og:image 时会拼到 metadataBase 的
 * pathname 上（`/og.png` → `https://echovagant.github.io/cartouche/og.png`），
 * 少了它，图片地址会跑到域名根目录去。
 */
const SITE_URL = 'https://echovagant.github.io/cartouche/';

const SITE_TITLE = '图签 Cartouche · 本机运行的地图出图工具';

const SITE_DESCRIPTION =
  '装在你自己电脑上，打开放图件的文件夹。画一笔、确认一下，原图件就地改好，格式与坐标系原样保留。改了什么、动了多少、备份在哪，都写在动手之前。';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  alternates: {
    canonical: SITE_URL,
  },
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    url: SITE_URL,
    siteName: '图签 Cartouche',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    // ⚠ 分享图 **尚未生成**：/og.png 是计划中的路径，文件本身还不存在。
    // 生成后放到静态产物根目录（部署后即 https://echovagant.github.io/cartouche/og.png）。
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: '图签 Cartouche · 本机运行的地图出图工具',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ['/og.png'],
  },
};

export const viewport: Viewport = {
  themeColor: '#f4f1ea',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={`${geist.variable} ${geistMono.variable}`}>
      <head>
        {/*
          主题必须在**首帧之前**落到 <html> 上，否则暗色用户会先看到一帧浅色再跳过去。
          用内联脚本（而不是 React effect）是因为它跑在 hydration 之前。
          没有存储值时默认暗色——画布的默认观感就是"制图台"。
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('cartouche.canvas.theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="grain min-h-[100dvh] bg-paper font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
