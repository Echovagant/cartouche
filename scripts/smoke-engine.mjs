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
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { listenSafe } from '../test/helpers/listen-safe.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 已登记根会持久化到配置目录。冒烟**不能**污染用户真实的 %LOCALAPPDATA%\cartouche\roots.json，
// 所以先把 CARTOUCHE_CONFIG_DIR 指到一个临时目录。
// 必须在导入 app.js 之前设好：roots.ts 在模块加载时就读这个变量。
const smokeConfigDir = await mkdtemp(join(tmpdir(), 'cartouche-smoke-config-'));
process.env.CARTOUCHE_CONFIG_DIR = smokeConfigDir;

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
const port = await listenSafe(server);
const BASE = `http://127.0.0.1:${port}`;

let failed = false;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? OK : BAD} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed = true;
};

// 冒烟用到的临时目录（结束时清掉）
let extraRoot = null;
let tmpProject = null;

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
  // PUT 必须被允许：项目清单的保存走 PUT /api/project/manifest。
  // 少了它，浏览器预检会把请求拦在服务端之前（控制台一条 CORS 报错，请求根本没发出去）。
  const allowMethods = preflight.headers.get('access-control-allow-methods') ?? '';
  check('预检允许 PUT', allowMethods.includes('PUT'), `Access-Control-Allow-Methods: ${allowMethods}`);

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

  // 绝对路径必须被拒：它能绕过"只能在工作区里读写"这条底线。
  // 实测（2026-10-21，改造前）：GET /api/fs/stat?path=C:\Windows\...\hosts → 200，
  //   POST /api/fs/write 用绝对路径 → 在工作区外真的建出了文件。
  const absProbePath = join(tmpdir(), `cartouche-abs-probe-${Date.now()}.txt`);
  const absStat = await fetch(`${BASE}/api/fs/stat?path=${encodeURIComponent(absProbePath)}`);
  check('GET /api/fs/stat 拒绝绝对路径', absStat.status === 400, `HTTP ${absStat.status}`);

  const absWriteBody = new Uint8Array(Buffer.byteLength(absProbePath, 'utf8') + 1 + 5);
  const absWritePathBytes = Buffer.from(absProbePath, 'utf8');
  absWriteBody.set(absWritePathBytes, 0);
  absWriteBody[absWritePathBytes.length] = 0;
  absWriteBody.set(Buffer.from('PROBE', 'utf8'), absWritePathBytes.length + 1);
  const absWrite = await fetch(`${BASE}/api/fs/write`, { method: 'POST', body: absWriteBody });
  check('POST /api/fs/write 拒绝绝对路径', absWrite.status === 400, `HTTP ${absWrite.status}`);
  check(
    '被拒的绝对路径没有在工作区外建出文件',
    !existsSync(absProbePath),
    existsSync(absProbePath) ? `文件被创建了：${absProbePath}` : '未创建',
  );

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

  /* ── 已登记根与项目清单 ── */
  const rootsRes = await fetch(`${BASE}/api/workspace/roots`);
  const rootsJson = await rootsRes.json();
  check(
    'GET /api/workspace/roots 返回默认根',
    rootsRes.ok && Array.isArray(rootsJson.roots) && rootsJson.roots.length >= 1,
    JSON.stringify(rootsJson.roots?.[0]?.path),
  );

  // 登记**另一个**根（工作区之外），用来验证多根真的能定位
  extraRoot = await mkdtemp(join(tmpdir(), 'cartouche-smoke-root-'));
  await writeFile(join(extraRoot, '标记.txt'), 'x', 'utf8');
  const addRoot = await fetch(`${BASE}/api/workspace/roots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: extraRoot, label: '冒烟根' }),
  });
  const addRootJson = await addRoot.json();
  check(
    'POST /api/workspace/roots 登记根',
    addRoot.ok && typeof addRootJson.id === 'string',
    JSON.stringify(addRootJson),
  );

  // 用 root 参数列这个根：证明"项目目录不在工作区里"也能用
  const listExtra = await fetch(`${BASE}/api/fs/list?path=&root=${encodeURIComponent(extraRoot)}`);
  const listExtraJson = await listExtra.json();
  check(
    'GET /api/fs/list 带 root 参数能列到工作区之外的目录',
    listExtra.ok && Array.isArray(listExtraJson.entries) && listExtraJson.entries.includes('标记.txt'),
    JSON.stringify(listExtraJson).slice(0, 160),
  );

  // 绝对路径必须被拒（不能靠 path=绝对路径 绕过根的边界）
  const absProbe = await fetch(`${BASE}/api/fs/list?path=${encodeURIComponent(extraRoot)}`);
  check('GET /api/fs/list 拒绝绝对路径', absProbe.status === 400, `HTTP ${absProbe.status}`);

  // 项目目录名带时间戳：上一轮跑崩了留下半截目录也不会影响这一轮
  tmpProject = join(wsRoot, `smoke-project-${Date.now()}`);
  await mkdir(tmpProject, { recursive: true });
  const createM = await fetch(`${BASE}/api/project/manifest`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: tmpProject, create: true, name: '冒烟项目' }),
  });
  const createMJson = await createM.json();
  check(
    'PUT /api/project/manifest create 新建项目',
    createM.ok && createMJson.manifest?.name === '冒烟项目',
    JSON.stringify(createMJson).slice(0, 160),
  );

  const getM = await fetch(`${BASE}/api/project/manifest?path=${encodeURIComponent(tmpProject)}`);
  const getMJson = await getM.json();
  check(
    'GET /api/project/manifest 读回清单',
    getM.ok && getMJson.exists === true && getMJson.manifest?.name === '冒烟项目',
    JSON.stringify(getMJson).slice(0, 160),
  );

  const hist = await fetch(`${BASE}/api/project/history`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: tmpProject,
      entry: { at: '2026-10-21T00:00:00.000Z', op: 'raster.paint', target: 'a.tff', ok: true },
    }),
  });
  check('POST /api/project/history 追加留痕', hist.ok, `HTTP ${hist.status}`);

  const histGet = await fetch(`${BASE}/api/project/history?path=${encodeURIComponent(tmpProject)}`);
  const histJson = await histGet.json();
  check(
    'GET /api/project/history 读回留痕',
    histGet.ok && histJson.entries?.length === 1,
    JSON.stringify(histJson).slice(0, 160),
  );

  const out = await fetch(`${BASE}/api/project/output`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: tmpProject,
      name: '冒烟.pdf',
      dataBase64: Buffer.from('%PDF-1.4').toString('base64'),
    }),
  });
  const outJson = await out.json();
  check(
    'POST /api/project/output 写产出物',
    out.ok && typeof outJson.relative === 'string',
    JSON.stringify(outJson).slice(0, 160),
  );

  const outList = await fetch(`${BASE}/api/project/outputs?path=${encodeURIComponent(tmpProject)}`);
  const outListJson = await outList.json();
  check(
    'GET /api/project/outputs 列出产出物',
    outList.ok && outListJson.outputs?.some((o) => o.name === '冒烟.pdf'),
    JSON.stringify(outListJson).slice(0, 160),
  );

  // 产出物文件名带路径必须被拒
  const outEscape = await fetch(`${BASE}/api/project/output`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: tmpProject, name: '../逃逸.pdf', dataBase64: 'eA==' }),
  });
  check(
    'POST /api/project/output 拒绝带路径的文件名',
    outEscape.status === 400,
    `HTTP ${outEscape.status}`,
  );

  /* ── 操作计划调度（栅格编辑闭环） ── */
  if (existsSync(fixtureRaster)) {
    const opRaster = `smoke-op-${Date.now()}.tif`;
    await copyFile(fixtureRaster, join(wsRoot, opRaster));

    // 取栅格的原生像元网格（前端靠它把地图坐标换算成像元坐标）
    const gridRes = await fetch(
      `${BASE}/api/raster/grid?path=${encodeURIComponent(opRaster)}`,
    );
    const gridJson = await gridRes.json();
    check(
      'GET /api/raster/grid 返回原生网格',
      gridRes.ok
        && typeof gridJson.width === 'number'
        && typeof gridJson.height === 'number'
        && Array.isArray(gridJson.geotransform),
      JSON.stringify(gridJson).slice(0, 160),
    );

    // 预演：不落盘，但给出精确的像元数
    const previewRes = await fetch(`${BASE}/api/op/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'raster.paint',
        params: {
          target: opRaster,
          region: { minX: 5, minY: 5, maxX: 15, maxY: 15 },
          color: '#00FF00',
        },
      }),
    });
    const previewJson = await previewRes.json();
    check(
      'POST /api/op/preview 给出影响像元数',
      previewRes.ok && previewJson.affectedPixels > 0 && previewJson.totalPixels > 0,
      JSON.stringify(previewJson).slice(0, 160),
    );

    // 预演之后文件必须没被动过（预演 ≠ 执行）
    const afterPreview = await fetch(
      `${BASE}/api/render/raster.png?path=${encodeURIComponent(opRaster)}&width=40&height=30`,
    );
    check('预演不会改文件（仍能出图）', afterPreview.ok, `HTTP ${afterPreview.status}`);

    // 未实现的 op 要明确报 400，不能假装成功
    const unimplemented = await fetch(`${BASE}/api/op/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'feature.setAttributes',
        params: { target: opRaster, where: 'a=1', set: { b: 2 } },
      }),
    });
    check(
      '未实现的 op 预演返回 400 并说明"尚未支持"',
      unimplemented.status === 400 && /尚未支持/.test((await unimplemented.json()).message ?? ''),
      `HTTP ${unimplemented.status}`,
    );

    // 绝对路径目标必须被拒（不能借它逃出工作区）
    const escape = await fetch(`${BASE}/api/op/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'raster.paint',
        params: {
          target: 'C:/Windows/System32/drivers/etc/hosts',
          region: { minX: 0, minY: 0, maxX: 2, maxY: 2 },
          color: '#00FF00',
        },
      }),
    });
    check('POST /api/op/execute 拒绝绝对路径', escape.status === 400, `HTTP ${escape.status}`);

    // 缺 op 要 400
    const noOp = await fetch(`${BASE}/api/op/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ params: {} }),
    });
    check('POST /api/op/execute 缺少 op 返回 400', noOp.status === 400, `HTTP ${noOp.status}`);

    // 真执行：改了文件、给出影响、并把留痕写进项目
    const execRes = await fetch(`${BASE}/api/op/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'raster.paint',
        params: {
          target: opRaster,
          region: { minX: 5, minY: 5, maxX: 15, maxY: 15 },
          color: '#00FF00',
        },
        projectRoot: tmpProject,
        confirmed: true,
      }),
    });
    const execJson = await execRes.json();
    check(
      'POST /api/op/execute 执行成功并给出量化影响',
      execRes.ok
        && execJson.ok === true
        && execJson.completed === 1
        && execJson.results?.[0]?.impact?.affectedPixels > 0
        && Boolean(execJson.results?.[0]?.impact?.backupPath),
      JSON.stringify(execJson).slice(0, 200),
    );

    // 留痕要落进项目（"可交差"靠它）
    const histAfter = await fetch(`${BASE}/api/project/history?path=${encodeURIComponent(tmpProject)}`);
    const histAfterJson = await histAfter.json();
    // 按目标找那一条：项目里可能已经有别的 op 留下的留痕（上面那条）
    const painted = (histAfterJson.entries ?? []).find(
      (e) => e.op === 'raster.paint' && e.target === opRaster,
    );
    check(
      '执行后留痕写进项目 history',
      Boolean(painted) && painted.ok === true && painted.impact?.affectedPixels > 0,
      JSON.stringify(painted ?? {}).slice(0, 200),
    );

    // 前端自动保存会带着**旧的** operations 回来（打开项目时读进内存的那份）。
    // 服务端不能被这份旧数据覆盖掉刚记下的操作日志 —— 否则用户回头看项目
    // 会发现"我明明改过图，怎么没有记录"。
    const staleManifest = {
      ...getMJson.manifest,
      sheet: { ...getMJson.manifest.sheet, title: '被前端改过的标题' },
      operations: [],
    };
    const stalePut = await fetch(`${BASE}/api/project/manifest`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: tmpProject, manifest: staleManifest }),
    });
    const afterStale = await fetch(`${BASE}/api/project/manifest?path=${encodeURIComponent(tmpProject)}`);
    const afterStaleJson = await afterStale.json();
    const keptOps = afterStaleJson.manifest?.operations ?? [];
    check(
      '清单 PUT 合并 operations：前端带旧的回来也抹不掉服务端记录',
      stalePut.ok
        && keptOps.some((o) => o.op === 'raster.paint' && o.target === opRaster)
        && afterStaleJson.manifest?.sheet?.title === '被前端改过的标题',
      JSON.stringify(keptOps).slice(0, 200),
    );

    await rm(join(wsRoot, opRaster), { force: true });
  }

  /* ── AI 接入页的端点（不配密钥时的行为） ── */
  const llmStatus = await fetch(`${BASE}/api/llm/status`);
  const llmStatusJson = await llmStatus.json();
  check(
    'GET /api/llm/status 只回状态，不回密钥',
    llmStatus.ok
      && llmStatusJson.configured === false
      && llmStatusJson.source === 'none'
      && typeof llmStatusJson.models?.length === 'number'
      && !('apiKey' in llmStatusJson)
      && !('key' in llmStatusJson),
    JSON.stringify(llmStatusJson).slice(0, 160),
  );

  // 没配密钥时，拉模型与发消息都要明确拒掉，不能默默给一份假清单
  const llmModelsNoKey = await fetch(`${BASE}/api/llm/models`);
  check(
    'GET /api/llm/models 没配密钥返回 400',
    llmModelsNoKey.status === 400,
    `HTTP ${llmModelsNoKey.status}`,
  );

  const llmTestNoKey = await fetch(`${BASE}/api/llm/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '你好' }),
  });
  check(
    'POST /api/llm/test 没配密钥返回 400',
    llmTestNoKey.status === 400,
    `HTTP ${llmTestNoKey.status}`,
  );

  console.log(`\n  ${failed ? BAD : OK} 冒烟测试${failed ? '未通过' : '通过'}${RESET}\n`);
} catch (err) {
  console.error(`  ${BAD} 冒烟测试异常: ${err.message}`);
  failed = true;
} finally {
  // 临时目录清掉，别把垃圾留在工作区与临时目录里
  if (tmpProject) await rm(tmpProject, { recursive: true, force: true });
  if (extraRoot) await rm(extraRoot, { recursive: true, force: true });
  await rm(smokeConfigDir, { recursive: true, force: true });
  await new Promise((r) => server.close(r));
}

// 注意：这里用 process.exitCode 而不是 process.exit()。
// Windows 上强制 process.exit() 会在 socket 仍处于关闭流程时触发
// libuv 断言 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"。
// 只设 exitCode 让事件循环自然排空即可。
process.exitCode = failed ? 1 : 0;
