import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';

/**
 * 字体自托管（next/font/local）。
 *
 * 为什么不用 next/font/google：本工具的承诺是"数据不出本机、可离线使用"，
 * 构建期也不该依赖外网——否则断网环境根本装不上。字体文件由
 * scripts/fetch-fonts.mjs 一次性下载后随仓库走。
 *
 * 分工（有意为之，不是摇摆）：
 *   - **Satoshi**（Fontshare EULA，可商用）→ 落地页的展示字：几何无衬线，
 *     笔画收得住，大标题不糊；技能明令禁用 Inter，这里用它做差异化。
 *   - **Geist** → 画布这类密集工具界面的正文字：小字号下更精确、字腔更紧。
 *   - **Geist Mono** → 一切数字、路径、字段名（图签的产出是要拿去对账的）。
 * 中文字形这三套都覆盖不到，统一回落到系统的苹方/雅黑。
 */
const satoshi = localFont({
  src: [
    { path: '../fonts/satoshi-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/satoshi-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/satoshi-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-satoshi',
  display: 'swap',
  fallback: ['ui-sans-serif', 'system-ui', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
});

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

export const metadata: Metadata = {
  title: '图签 Cartouche · AI 地图修改工作台',
  description:
    '用一句话描述要改什么，AI 给出可核对的修改方案，确定性引擎执行，全程留痕。',
};

export const viewport: Viewport = {
  themeColor: '#f4f1ea',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={`${satoshi.variable} ${geist.variable} ${geistMono.variable}`}>
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
