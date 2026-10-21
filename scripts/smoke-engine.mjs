#!/usr/bin/env node
/**
 * 引擎服务冒烟测试。
 *
 * 在**本进程内**起服务并优雅关闭——不在 Windows 上强杀子进程
 * （child.kill() 在 Windows 是 TerminateProcess，不投递信号，
 *  会让 libuv 在 socket 仍注册时抛 UV_HANDLE_CLOSING 断言）。
 *
 * 用法：npm -w server run build && node scripts/smoke-engine.mjs
 */
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Windows 上 ESM 动态导入必须是 file:// URL，裸绝对路径会被当成未知协议
const { createEngineServer, opCount } = await import(
  pathToFileURL(join(root, 'server', 'dist', 'app.js')).href
);

const OK = '\x1b[32m●\x1b[0m';
const BAD = '\x1b[31m■\x1b[0m';
const DIM = '\x1b[90m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const server = createEngineServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const addr = server.address();
const BASE = `http://127.0.0.1:${addr.port}`;

let failed = false;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? OK : BAD} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed = true;
};

try {
  console.log(`\n${BOLD}引擎服务冒烟测试${RESET}  ${DIM}${BASE}${RESET}\n`);

  const healthRes = await fetch(`${BASE}/api/health`);
  const health = await healthRes.json();
  check('/api/health', healthRes.ok && health.ok === true, JSON.stringify(health));
  check('op 数量与 Schema 一致', health.ops === opCount(), `${health.ops} 个`);

  const schemaRes = await fetch(`${BASE}/api/ops/schema`);
  const schema = await schemaRes.json();
  const ops = schema?.$defs?.operation?.properties?.op?.enum ?? [];
  check('/api/ops/schema 返回完整契约', ops.length >= 20, `${ops.length} 个 op`);

  const notFound = await fetch(`${BASE}/api/nope`);
  check('未知路径返回 404', notFound.status === 404, `HTTP ${notFound.status}`);

  const cors = notFound.headers.get('access-control-allow-origin');
  check('未开放跨域', cors === 'null', `Access-Control-Allow-Origin: ${cors}`);

  /**
   * 跨域策略：默认放行**回环地址来源**，外网来源仍然挡住。
   *
   * 画布本身也是本机 http 页面（静态产物由 scripts/serve-static.mjs 提供），
   * 所以回环来源必须放行，否则工具自己连不上自己。
   * 来自互联网的页面 Origin 不是回环 → 回 'null' → 浏览器拦下。
   */
  const loopbackOrigin = 'http://127.0.0.1:8080';
  const loopbackRes = await fetch(`${BASE}/api/health`, { headers: { origin: loopbackOrigin } });
  check(
    '回环来源的 Origin 被放行',
    loopbackRes.headers.get('access-control-allow-origin') === loopbackOrigin,
    `Access-Control-Allow-Origin: ${loopbackRes.headers.get('access-control-allow-origin')}`,
  );

  const foreignOrigin = 'http://evil.example.com';
  const foreignRes = await fetch(`${BASE}/api/health`, { headers: { origin: foreignOrigin } });
  check(
    '外网来源的 Origin 仍被挡住',
    foreignRes.headers.get('access-control-allow-origin') === 'null',
    `Access-Control-Allow-Origin: ${foreignRes.headers.get('access-control-allow-origin')}`,
  );

  // 预检：带 content-type 的 POST 会触发浏览器预检
  const preflight = await fetch(`${BASE}/api/health`, {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:3000' },
  });
  check(
    'OPTIONS 预检有响应',
    preflight.status === 204 || preflight.status === 200,
    `HTTP ${preflight.status}`,
  );
  check(
    '预检对回环 Origin 回显',
    preflight.headers.get('access-control-allow-origin') === 'http://localhost:3000',
    `Access-Control-Allow-Origin: ${preflight.headers.get('access-control-allow-origin')}`,
  );
  check(
    '预检允许 content-type',
    (preflight.headers.get('access-control-allow-headers') ?? '').includes('content-type'),
    preflight.headers.get('access-control-allow-headers') ?? '(无)',
  );

  /* ── 工作区文件接口（真实契约验证） ── */
  const wsRoot = process.env.ENGINE_WORKSPACE_ROOT ?? join(root, 'workspace');
  const rel = `smoke-${Date.now()}.bin`;
  const payload = new TextEncoder().encode('engine-smoke');

  // 写：body = <path>\0<bytes>
  const body = new Uint8Array(payload.length + 1 + Buffer.byteLength(rel, 'utf8'));
  const pathBytes = Buffer.from(rel, 'utf8');
  body.set(pathBytes, 0);
  body[pathBytes.length] = 0;
  body.set(payload, pathBytes.length + 1);
  const w = await fetch(`${BASE}/api/fs/write`, { method: 'POST', body });
  check('POST /api/fs/write', w.ok, `HTTP ${w.status}`);

  const r = await fetch(`${BASE}/api/fs/read?path=${encodeURIComponent(rel)}`);
  const readBack = new Uint8Array(await r.arrayBuffer());
  check(
    'GET /api/fs/read 回读内容一致',
    r.ok && Buffer.from(readBack).toString('utf8') === 'engine-smoke',
    Buffer.from(readBack).toString('utf8').slice(0, 40),
  );

  const st = await fetch(`${BASE}/api/fs/stat?path=${encodeURIComponent(rel)}`);
  const stJson = await st.json();
  check('GET /api/fs/stat', st.ok && stJson.size === payload.length, JSON.stringify(stJson));

  const missing = await fetch(`${BASE}/api/fs/read?path=nope-${Date.now()}.bin`);
  check('读取不存在的文件返回 404', missing.status === 404, `HTTP ${missing.status}`);

  // 路径越界必须被拒绝（400 = 越界，404 = 不存在）
  const escape = await fetch(`${BASE}/api/fs/read?path=${encodeURIComponent('../../etc/passwd')}`);
  check('路径越界被拒绝', escape.status === 400 || escape.status === 404, `HTTP ${escape.status}`);

  await fetch(`${BASE}/api/fs/remove`, { method: 'POST', body: rel });

  /* ── S5：出图 / 矢量 / 兼容性报告 ── */
  const fixtureRaster = join(root, 'fixtures', 'embedded.tff');
  const fixtureVector = join(root, 'fixtures', 'sample.shp');

  if (existsSync(fixtureRaster)) {
    // 栅格渲染：直接把 fixtures 拷进工作区（接口只认工作区内的相对路径）
    const rasterName = `smoke-${Date.now()}.tif`;
    await copyFile(fixtureRaster, join(wsRoot, rasterName));
    const pngRes = await fetch(
      `${BASE}/api/render/raster.png?path=${encodeURIComponent(rasterName)}&width=200&height=150`,
    );
    const pngBytes = new Uint8Array(await pngRes.arrayBuffer());
    check(
      'GET /api/render/raster.png 产出 PNG',
      pngRes.ok && pngBytes[0] === 0x89 && pngBytes[1] === 0x50,
      `HTTP ${pngRes.status}, ${pngBytes.length} 字节`,
    );

    const badBox = await fetch(
      `${BASE}/api/render/raster.png?path=${encodeURIComponent(rasterName)}&width=100&height=100&bbox=3,2,1,4`,
    );
    check('非法 bbox 返回 400', badBox.status === 400, `HTTP ${badBox.status}`);

    // 兼容性自检报告
    const reportRes = await fetch(`${BASE}/api/report/compat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: rasterName }),
    });
    const reportJson = await reportRes.json();
    check(
      'POST /api/report/compat 产出六段式报告',
      reportRes.ok &&
        typeof reportJson.markdown === 'string' &&
        reportJson.markdown.includes('## 1. 文件格式') &&
        reportJson.markdown.includes('在 ArcGIS 中打开需要注意'),
      `HTTP ${reportRes.status}, ${reportJson.markdown?.length ?? 0} 字符`,
    );

    await rm(join(wsRoot, rasterName), { force: true });
  } else {
    console.log(`  ${DIM}·${RESET} 跳过出图冒烟（先跑 npm run fixture）`);
  }

  if (existsSync(fixtureVector)) {
    const vecName = `smoke-${Date.now()}.shp`;
    for (const ext of ['.shp', '.shx', '.dbf', '.prj', '.cpg']) {
      const src = join(root, 'fixtures', `sample${ext}`);
      if (existsSync(src)) await copyFile(src, join(wsRoot, vecName.replace(/\.shp$/, ext)));
    }
    const gjRes = await fetch(`${BASE}/api/data/geojson?path=${encodeURIComponent(vecName)}`);
    const gj = await gjRes.json();
    check(
      'GET /api/data/geojson 产出 FeatureCollection',
      gjRes.ok && gj.geojson?.type === 'FeatureCollection' && gj.featureCount > 0,
      `HTTP ${gjRes.status}, ${gj.featureCount} 个要素`,
    );

    // ⚠️ GeoJSON 必须是**经纬度**（EPSG:4326）。
    //    ogr2ogr 不给 -t_srs 时按源 CRS 输出，投影坐标系的矢量会带着
    //    UTM 东坐标出去（如 816690），MapLibre 当经纬度解析就飞到天边去了。
    const firstCoord = gj.geojson?.features?.[0]?.geometry?.coordinates;
    const flat = Array.isArray(firstCoord?.[0]?.[0]) ? firstCoord[0][0] : firstCoord?.[0];
    check(
      'GET /api/data/geojson 的坐标是经纬度',
      Array.isArray(flat) && Math.abs(flat[0]) <= 180 && Math.abs(flat[1]) <= 90,
      `首个坐标 ${JSON.stringify(flat)}`,
    );

    // 范围端点：画布靠它把视野挪到数据上
    const extRes = await fetch(`${BASE}/api/data/extent?path=${encodeURIComponent(vecName)}`);
    const extent = await extRes.json();
    check(
      'GET /api/data/extent 返回 4326 包围盒',
      extRes.ok &&
        Array.isArray(extent.bbox) &&
        extent.bbox.length === 4 &&
        Math.abs(extent.bbox[0]) <= 180 &&
        Math.abs(extent.bbox[1]) <= 90 &&
        extent.bbox[2] > extent.bbox[0] &&
        extent.bbox[3] > extent.bbox[1],
      `HTTP ${extRes.status}, bbox=${JSON.stringify(extent.bbox)}`,
    );

    for (const ext of ['.shp', '.shx', '.dbf', '.prj', '.cpg']) {
      await rm(join(wsRoot, vecName.replace(/\.shp$/, ext)), { force: true });
    }
  }

  // PDF 封装：拿一张真实 JPEG（由 GDAL 从样本出）走一遍
  if (existsSync(fixtureRaster)) {
    const jpegRes = await fetch(
      `${BASE}/api/render/raster.png?path=${encodeURIComponent('embedded.tff')}&width=64&height=48`,
    );
    // PNG 不能直接塞进 PDF（PDF 的 DCTDecode 只吃 JPEG），所以这里只验证错误处理是干净的
    const pdfBad = await fetch(`${BASE}/api/export/pdf`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jpeg: 'not-a-jpeg', width: 64, height: 48 }),
    });
    check('POST /api/export/pdf 拒绝非法 JPEG', pdfBad.status === 500, `HTTP ${pdfBad.status}`);
    void jpegRes;
  }

  console.log(`\n  ${failed ? BAD : OK} 冒烟测试${failed ? '未通过' : '通过'}${RESET}\n`);
} catch (err) {
  console.error(`  ${BAD} 冒烟测试异常: ${err.message}`);
  failed = true;
} finally {
  await new Promise((r) => server.close(r));
}

// 注意：这里用 process.exitCode 而不是 process.exit()。
// Windows 上强制 process.exit() 会在 socket 仍处于关闭流程时触发
// libuv 断言 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"。
// 只设 exitCode 让事件循环自然排空即可。
process.exitCode = failed ? 1 : 0;
