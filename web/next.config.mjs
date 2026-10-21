/** @type {import('next').NextConfig} */
const nextConfig = {
  // 纯静态导出：产物可直接被 Tauri 等桌面壳加载，不需要 Node 运行时。
  // 引擎能力全部走 HTTP 调用独立的 server 进程，不依赖 Next.js 服务端特性。
  output: 'export',
  distDir: 'out',
  reactStrictMode: true,
  // 静态产物要能被 Tauri 桌面壳直接以 file:// 加载，因此资源路径必须是**相对路径**。
  // 默认的 `/_next/...` 在 file:// 下会被解析到盘根（file:///C:/_next/...）→ 全部 404 → 页面不水合。
  // assetPrefix: './' 让产物引用 `./_next/...`，相对 HTML 文件所在目录解析。
  assetPrefix: './',
  // 路由链接的处理方式见 app/page.tsx 与 app/canvas/CanvasWorkbench.tsx 的 NAV 常量：
  // 静态产物里 index.html 与 canvas.html 是同目录的兄弟文件（trailingSlash 保持 false，
  // 否则 canvas/index.html 里的 `./_next/` 会解析到 out/canvas/_next/ 而 404），
  // 因此相对链接在 file:// 与静态 http 服务器下都能解析；
  // `next dev` 下则用绝对路由 /canvas（编译期由 process.env.NODE_ENV 区分）。
  // 本项目不用 next/image（地图渲染走 MapLibre），关掉图片优化器，
  // 避免引入 sharp / libvips 这类弱 copyleft 依赖。
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: false },
  env: {
    NEXT_PUBLIC_ENGINE_BASE_URL: process.env.NEXT_PUBLIC_ENGINE_BASE_URL ?? 'http://127.0.0.1:8787',
  },
};

export default nextConfig;
