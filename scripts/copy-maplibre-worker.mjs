#!/usr/bin/env node
/**
 * 把 MapLibre 的 worker 文件复制到 `web/public/`，让浏览器能加载它。
 *
 * ## 为什么必须这么做（2026-10-21 浏览器实测抓到的）
 *
 * MapLibre GL JS v6 内部这样定位自己的 worker：
 *
 *   function lb() {
 *     let e = import.meta.url;
 *     if (!/^https?:/.test(e)) return ``;
 *     let t = e.endsWith('-dev.mjs') ? 'maplibre-gl-worker-dev.mjs' : 'maplibre-gl-worker.mjs';
 *     return new URL(`./${t}`, e).href;      // ← 模板字符串，打包器无法静态改写
 *   }
 *
 * 模板字符串里的文件名是**动态**的，webpack / Turbopack 都没法做
 * `new URL('./x.mjs', import.meta.url)` 那样的静态资源改写，
 * 于是拼出来的地址指向一个不存在的文件 → worker 404 → **地图上一片空白**
 * （底图、矢量、图例全都不画，但控制台只有一行 "Worker failed to load"）。
 *
 * MapLibre 为此导出了官方开关 `setWorkerUrl(url)`。本脚本负责给出那个稳定地址：
 * 把 worker 复制成 `web/public/maplibre-gl-worker.mjs`（静态导出时落在产物根目录，
 * 与 canvas.html 同级），运行时用 `new URL('maplibre-gl-worker.mjs', document.baseURI)`
 * 解析——file:// 与 http:// 下都能解析到正确的兄弟文件。
 *
 * ## 为什么不直接把 worker 打进 bundle
 *
 * worker 必须是**独立文件**（浏览器要用 URL 去 new Worker），
 * 打进 bundle 就没法作为 URL 用了。
 *
 * ## 许可
 *
 * maplibre-gl 是 BSD-3-Clause，worker 文件头部自带原始许可声明，随产物分发即可。
 * 本文件不进 Git（.gitignore 已登记），每次构建从 node_modules 重新复制。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'maplibre-gl', 'dist', 'maplibre-gl-worker.mjs');
const destDir = join(root, 'web', 'public');
const dest = join(destDir, 'maplibre-gl-worker.mjs');

if (!existsSync(src)) {
  console.error(
    `[maplibre-worker] 找不到 ${src}\n` +
      '              先安装依赖：npm install',
  );
  process.exitCode = 1;
} else {
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  console.log(`[maplibre-worker] 已复制到 web/public/${'maplibre-gl-worker.mjs'}`);
}
