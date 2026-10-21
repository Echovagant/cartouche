#!/usr/bin/env node
/**
 * 零依赖静态服务器：把 `web/out`（Next.js 静态导出产物）跑起来。
 *
 * 为什么需要它：
 *   - 静态导出产物是**部署形态**的最终产物，用它验收才准；
 *   - 直接双击 index.html（file://）时，MapLibre 的 Worker 建不起来
 *     （Chrome 禁止从 origin=null 的页面构造 Worker），地图图层画不出来；
 *     所以"本地看一眼"也得走 http。
 *
 * 用法：
 *   node scripts/serve-static.mjs [--port 8080] [--root web/out]
 *
 * 注意：页面 Origin 会变成 http://127.0.0.1:<port>，
 *   引擎默认只放行 'null'，所以需要同时给引擎设白名单：
 *   $env:ENGINE_ALLOWED_ORIGINS='http://127.0.0.1:8080'
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg('port', '8080'));
const root = join(repoRoot, arg('root', join('web', 'out')));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** 把 URL 路径映射到磁盘路径；越界直接拒绝（防目录穿越） */
function resolvePath(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0] ?? '/')).replace(/^(\.\.[/\\])+/, '');
  let p = join(root, clean);
  if (!p.startsWith(root + sep) && p !== root) return null;
  return p;
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      let p = resolvePath(req.url ?? '/');
      if (!p) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('403');
        return;
      }
      let info = await stat(p).catch(() => null);
      if (info?.isDirectory()) {
        p = join(p, 'index.html');
        info = await stat(p).catch(() => null);
      }
      if (!info?.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 ' + (req.url ?? ''));
        return;
      }
      const body = await readFile(p);
      res.writeHead(200, {
        'content-type': MIME[extname(p).toLowerCase()] ?? 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('500 ' + (err instanceof Error ? err.message : String(err)));
    }
  })();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[static] serving ${root}`);
  console.log(`[static] http://127.0.0.1:${port}/  （画布： /canvas.html）`);
  console.log(`[static] 提示：引擎需放行本页 Origin，例如 ENGINE_ALLOWED_ORIGINS=http://127.0.0.1:${port}`);
});
