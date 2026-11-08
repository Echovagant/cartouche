/**
 * 请求体上限与渲染尺寸上限。
 *
 * ## 为什么要有这两道闸
 *
 * 引擎只监听回环地址，但**本机上任何一个网页**都能往 `http://127.0.0.1:8787` 发请求。
 * 原来有两处没有上限：
 *
 *  - `readBody` 把整个请求体收进内存（不检查 content-length，也不累计），
 *    而它被约 16 个接口使用 —— 一个超大 POST 就能把引擎的内存吃光；
 *  - `/api/render/raster.png` 的 width/height 直接取自查询串，引擎侧**只有下限没有上限**，
 *    能让 GDAL 往系统临时目录（Windows 上是 C 盘）写超大中间文件。
 *
 * ## 上限值怎么定的
 *
 *  - 请求体 **64 MiB**：正常路径里最大的是导出 PDF（canvas 的 JPEG 转 base64 塞进 JSON）
 *    与项目产物落盘（图片转 base64）。base64 比原始字节大 4/3，一张 4K JPEG 约 5–10 MB
 *    → base64 约 7–13 MB；留 4–5 倍余量取 64 MiB，正常使用碰不到天花板。
 *  - 渲染尺寸 **6400 万像素**（8000×8000）：与导出路径的 `MAX_OUTPUT_PIXELS` 同一口径。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listenSafe } from './helpers/listen-safe.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 环境变量必须在导入 app.ts **之前**设好 */
const wsRoot = await mkdtemp(join(tmpdir(), 'cartouche-limits-ws-'));
const cfgRoot = await mkdtemp(join(tmpdir(), 'cartouche-limits-cfg-'));
process.env.ENGINE_WORKSPACE_ROOT = wsRoot;
process.env.CARTOUCHE_CONFIG_DIR = cfgRoot;

const { createEngineServer } = await import(
  pathToFileURL(join(repoRoot, 'server', 'src', 'app.ts')).href
);
const { resolveGdal } = await import(
  pathToFileURL(join(repoRoot, 'src', 'engine', 'gdal', 'env.ts')).href
);
const { tools } = await import(
  pathToFileURL(join(repoRoot, 'src', 'engine', 'gdal', 'runner.ts')).href
);

let server = null;
let base = '';
let rasterFile = '';

/** 造一张 16×12 的三波段影像（构造数据，用 ENVI 格式 —— 与仓库里其它测试同法） */
async function makeRaster(dir, name) {
  const w = 16, h = 12, bands = 3;
  const raw = new Uint8Array(w * h * bands);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let b = 0; b < bands; b++) {
        raw[(y * w + x) * bands + b] = (x * 7 + y * 3 + b * 40 + 11) % 200;
      }
    }
  }
  const bin = join(dir, `${name}.bin`);
  const hdr = join(dir, `${name}.hdr`);
  await writeFile(bin, raw);
  await writeFile(
    hdr,
    [
      'ENVI',
      `samples = ${w}`,
      `lines   = ${h}`,
      `bands   = ${bands}`,
      'header offset = 0',
      'file type = ENVI Standard',
      'data type = 1',
      'interleave = bip',
      'byte order = 0',
      '',
    ].join('\n'),
    'utf8',
  );
  const tif = join(dir, `${name}.tif`);
  const gdal = tools(resolveGdal());
  await gdal.translate([
    '-of', 'GTiff',
    '-a_srs', 'EPSG:4326',
    '-a_ullr', '120.30', '30.532', '120.316', '30.52',
    bin, tif,
  ]);
  return tif;
}

before(async () => {
  server = createEngineServer();
  const port = await listenSafe(server);
  base = `http://127.0.0.1:${port}`;
  rasterFile = await makeRaster(wsRoot, 'limits-target');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await rm(wsRoot, { recursive: true, force: true });
  await rm(cfgRoot, { recursive: true, force: true });
});

test('请求体超过上限会回 413，并说清上限是多少', async () => {
  // 构造一个超过 64 MiB 的 JSON 请求体
  const big = 'x'.repeat(65 * 1024 * 1024);
  const res = await fetch(`${base}/api/project/output`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'out.png', name: 'out.png', dataBase64: big }),
  });
  assert.equal(res.status, 413);
  const json = await res.json();
  assert.equal(json.error, 'payload_too_large');
  assert.ok(json.message && json.message.includes('MB'), '要说清上限是多少');
  assert.equal(json.limitBytes, 64 * 1024 * 1024);
});

test('请求体没超上限时照常处理（不能把正常请求一起挡掉）', async () => {
  const res = await fetch(`${base}/api/project/manifest`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '小文件.json', manifest: { version: 1 } }),
  });
  // 这里的返回码不是重点 —— 重点是**不是 413**
  assert.notEqual(res.status, 413, '正常大小的请求不该被 413 挡掉');
});

test('渲染尺寸超上限会被挡下，并说清建议的尺寸', async () => {
  const res = await fetch(
    `${base}/api/render/raster.png?path=${encodeURIComponent('limits-target.tif')}&width=20000&height=20000`,
  );
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.ok(json.message && json.message.includes('兆像素'), '要说清超了多少');
  assert.ok(json.message && json.message.includes('8000'), '要给出建议的尺寸上限');
});

test('渲染尺寸是负数或零会说清原因，不静默当成 1', async () => {
  const res = await fetch(
    `${base}/api/render/raster.png?path=${encodeURIComponent('limits-target.tif')}&width=0&height=100`,
  );
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.ok(json.message && json.message.includes('正数'), '要说清宽高得是正数');
});

test('渲染尺寸在上限之内不被尺寸这道闸挡下', async () => {
  const res = await fetch(
    `${base}/api/render/raster.png?path=${encodeURIComponent('limits-target.tif')}&width=256&height=256`,
  );
  // 不是 400 的尺寸错误就说明尺寸闸放行了
  assert.notEqual(res.status, 400, '正常尺寸不该被尺寸闸挡下');
});
