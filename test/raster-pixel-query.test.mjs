/**
 * 经纬度 → 原生像元（`POST /api/raster/pixels`）。
 *
 * 这条链路解的是**画笔在非 4326 栅格上完全不可用**这件事：
 *   画布上的点是经纬度，栅格的像元是原生坐标（投影坐标系里是米）。
 *   浏览器里没有投影能力，所以换算必须由引擎做；
 *   之前前端自己拿经纬度去按 geotransform 反算（度当米用），
 *   画出来的东西落在天边，而且"看着像画过一笔"。
 *
 * 本文件里造的栅格（16×12、EPSG:4547 / EPSG:4326）**都是构造数据**，
 * 仿射参数按 EPSG 规范写，不对应任何真实数据。
 *
 * 为什么用 ogr2ogr 而不是 gdaltransform 做点转换：
 *   gdaltransform 只从 stdin 读坐标，而 runTool 用的是 execFile ——
 *   既喂不进去也关不掉 stdin（实测子进程会一直等 EOF 直到超时）。
 *   ogr2ogr 走文件进文件出，一次进程换算任意多个点。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listenSafe } from './helpers/listen-safe.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;
const web = (p) => pathToFileURL(join(root, 'web', 'app', 'canvas', p)).href;

/* 环境变量必须在导入 app.ts **之前**设好（app.ts 在模块加载时就定下工作区根） */
const wsRoot = await mkdtemp(join(tmpdir(), 'cartouche-pixels-ws-'));
const cfgRoot = await mkdtemp(join(tmpdir(), 'cartouche-pixels-cfg-'));
process.env.ENGINE_WORKSPACE_ROOT = wsRoot;
process.env.CARTOUCHE_CONFIG_DIR = cfgRoot;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { queryRasterPixels, pixelFromNative } = await import(eng('raster/pixel-query.ts'));
const { createEngineServer } = await import(pathToFileURL(join(root, 'server', 'src', 'app.ts')).href);
/* 前端那份反算（回归对照用）：引擎与前端必须给出同一个像元坐标 */
const { pixelFromLngLat } = await import(web('editGeometry.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

/* ── 夹具 ────────────────────────────────────────────────── */

/**
 * 造一张 16×12 的三波段 Byte 影像（构造数据）。
 * 坐标系与仿射参数由 `-a_srs` / `-a_ullr` 给出。
 */
async function makeByteRaster(dir, name, { srs, ullr }) {
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
  await gdal.translate(['-of', 'GTiff', '-a_srs', srs, '-a_ullr', ...ullr, bin, tif]);
  return tif;
}

/** 读一个栅格的仿射参数与尺寸 */
async function infoOf(path) {
  const res = await gdal.info(path, ['-json']);
  assert.ok(res.ok, `gdalinfo 失败：${res.stderr}`);
  const j = JSON.parse(res.stdout);
  return { gt: j.geoTransform, size: j.size, crs: j.coordinateSystem };
}

/**
 * 把原生坐标（EPSG:4547 的米）转成经纬度（EPSG:4326）。
 * 走的是与引擎同一条 PROJ 链路（ogr2ogr），只是方向相反。
 *
 * 源必须显式声明成 EPSG:4547：不声明的话 GeoJSON 会被当成 WGS 84，
 * "4547 → 4326" 就变成了恒等变换（拿米当经纬度），测出来的东西是假的。
 */
async function nativeToLngLat(points) {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-pixels-xy-'));
  try {
    const inFile = join(dir, 'in.geojson');
    const outFile = join(dir, 'out.geojson');
    await writeFile(
      inFile,
      JSON.stringify({
        type: 'FeatureCollection',
        features: points.map((p, i) => ({
          type: 'Feature',
          properties: { i },
          geometry: { type: 'Point', coordinates: [p[0], p[1]] },
        })),
      }),
      'utf8',
    );
    const res = await gdal.ogr2ogr([
      '-f', 'GeoJSON',
      '-s_srs', 'EPSG:4547',
      '-t_srs', 'EPSG:4326',
      '--config', 'COORDINATE_PRECISION', '15',
      outFile, inFile,
    ]);
    assert.ok(res.ok, `ogr2ogr 失败：${res.stderr}`);
    const parsed = JSON.parse(await readFile(outFile, 'utf8'));
    const ordered = parsed.features
      .sort((a, b) => a.properties.i - b.properties.i)
      .map((f) => f.geometry.coordinates);
    // 真的换算了吗（没换算的话这一步会原样返回米）
    assert.ok(
      ordered.every((c) => Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90),
      '换算结果应当是经纬度，而不是原样的米',
    );
    return ordered;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* 4547 = CGCS2000 / 3-degree Gauss-Kruger CM 114E：坐标是米 */
const ULLR_4547 = ['500000', '3309880', '500160', '3310000'];
/* 4326 的同一张图：坐标是度 */
const ULLR_4326 = ['120.30', '30.52', '120.316', '30.532'];

let raster4547 = '';
let raster4326 = '';

let server = null;
let base = '';

before(async () => {
  raster4547 = await makeByteRaster(wsRoot, 'proj4547', {
    srs: 'EPSG:4547',
    ullr: ULLR_4547,
  });
  raster4326 = await makeByteRaster(wsRoot, 'geo4326', {
    srs: 'EPSG:4326',
    ullr: ULLR_4326,
  });
  server = createEngineServer();
  const port = await listenSafe(server);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await rm(wsRoot, { recursive: true, force: true });
  await rm(cfgRoot, { recursive: true, force: true });
});

async function postPixels(body) {
  const res = await fetch(`${base}/api/raster/pixels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/* ── 1. 投影坐标系（EPSG:4547）：像元级一致 ──────────────── */

test('4547 栅格：经纬度换算回来的像元坐标与直接反算一致（≤1e-6 像元）', async () => {
  const { gt, size } = await infoOf(raster4547);
  // 角点、中心、远角三个点（都落在影像内）
  const natives = [
    [gt[0], gt[3]],
    [gt[0] + (size[0] * gt[1]) / 2, gt[3] + (size[1] * gt[5]) / 2],
    [gt[0] + size[0] * gt[1], gt[3] + size[1] * gt[5]],
  ];
  const lngLats = await nativeToLngLat(natives);

  const res = await queryRasterPixels(loc, { path: raster4547, points: lngLats });
  assert.equal(res.projected, true, '4547 必须真的做投影换算');
  assert.equal(res.crs, 'EPSG:4547');

  natives.forEach((native, i) => {
    const expected = pixelFromNative(gt, native[0], native[1]);
    const got = res.pixels[i];
    assert.ok(got, `第 ${i + 1} 个点必须有结果`);
    assert.ok(
      Math.abs(got.col - expected.col) <= 1e-6,
      `第 ${i + 1} 个点 col 偏差过大：${got.col} vs ${expected.col}`,
    );
    assert.ok(
      Math.abs(got.row - expected.row) <= 1e-6,
      `第 ${i + 1} 个点 row 偏差过大：${got.row} vs ${expected.row}`,
    );
  });
});

test('4547 栅格：角点换算回原位（往返一致）', async () => {
  const { gt, size } = await infoOf(raster4547);
  const natives = [
    [gt[0], gt[3]],
    [gt[0] + size[0] * gt[1], gt[3] + size[1] * gt[5]],
  ];
  const lngLats = await nativeToLngLat(natives);
  const res = await queryRasterPixels(loc, { path: raster4547, points: lngLats });
  assert.ok(Math.abs(res.pixels[0].col - 0) <= 1e-6, '左上角应回到 col=0');
  assert.ok(Math.abs(res.pixels[0].row - 0) <= 1e-6, '左上角应回到 row=0');
  assert.ok(Math.abs(res.pixels[1].col - size[0]) <= 1e-6, '右下角应回到 col=width');
  assert.ok(Math.abs(res.pixels[1].row - size[1]) <= 1e-6, '右下角应回到 row=height');
});

/* ── 2. 4326 回归：同一条端点路径，结果与现在一致 ────────── */

test('4326 栅格：走同一条端点路径，结果与前端的反算完全一致', async () => {
  const { gt } = await infoOf(raster4326);
  const points = [
    [120.30, 30.532],
    [120.308, 30.526],
    [120.316, 30.52],
  ];
  const res = await queryRasterPixels(loc, { path: raster4326, points });
  assert.equal(res.projected, false, '4326 不该做投影换算');
  assert.equal(res.crs, 'EPSG:4326');
  points.forEach((p, i) => {
    const legacy = pixelFromLngLat({ geotransform: gt }, p[0], p[1]);
    const got = res.pixels[i];
    assert.ok(Math.abs(got.col - legacy.col) <= 1e-9, `第 ${i + 1} 个点 col 与旧算法不一致`);
    assert.ok(Math.abs(got.row - legacy.row) <= 1e-9, `第 ${i + 1} 个点 row 与旧算法不一致`);
  });
});

/* ── 3. 端点（HTTP）：契约 ───────────────────────────────── */

test('端点：4547 栅格返回像元坐标', async () => {
  const { gt, size } = await infoOf(raster4547);
  const natives = [[gt[0], gt[3]]];
  const lngLats = await nativeToLngLat(natives);
  const { status, json } = await postPixels({ path: 'proj4547.tif', points: lngLats });
  assert.equal(status, 200);
  assert.equal(json?.ok, true);
  assert.equal(json?.pixels?.length, 1);
  assert.ok(Math.abs(json.pixels[0].col - 0) <= 1e-6, '左上角的 col 应当是 0');
  assert.ok(Math.abs(json.pixels[0].row - 0) <= 1e-6, '左上角的 row 应当是 0');
  assert.ok(size[0] > 0);
});

test('端点：4326 栅格返回像元坐标（与引擎直调一致）', async () => {
  const { gt } = await infoOf(raster4326);
  const points = [[120.308, 30.526]];
  const { status, json } = await postPixels({ path: 'geo4326.tif', points });
  assert.equal(status, 200);
  const expected = pixelFromLngLat({ geotransform: gt }, points[0][0], points[0][1]);
  assert.ok(Math.abs(json.pixels[0].col - expected.col) <= 1e-9);
  assert.ok(Math.abs(json.pixels[0].row - expected.row) <= 1e-9);
});

/* ── 4. 路径安全 ─────────────────────────────────────────── */

test('端点：绝对路径 → 400', async () => {
  const { status, json } = await postPixels({
    path: 'C:/Windows/System32/drivers/etc/hosts',
    points: [[120.3, 30.5]],
  });
  assert.equal(status, 400, '绝对路径必须 400');
  assert.equal(json?.ok, false);
  assert.match(json?.message ?? '', /路径越界/);
});

test('端点：`..` 逃出工作区 → 400', async () => {
  const { status, json } = await postPixels({
    path: '../evil.tif',
    points: [[120.3, 30.5]],
  });
  assert.equal(status, 400, '.. 必须 400');
  assert.equal(json?.ok, false);
  assert.match(json?.message ?? '', /路径越界/);
});

test('端点：工作区里根本没有的文件 → 400，且说清找不到', async () => {
  const { status, json } = await postPixels({
    path: 'no-such-file.tif',
    points: [[120.3, 30.5]],
  });
  assert.equal(status, 400);
  assert.match(json?.message ?? '', /不存在/);
});

/* ── 5. 非法点：明确报错，不给 NaN ───────────────────────── */

test('端点：点落在影像范围之外 → 400，并说清是哪个点', async () => {
  // 4547 栅格覆盖的是 CM 114E 附近；这里给一个南半球之外的经纬度
  const { status, json } = await postPixels({
    path: 'proj4547.tif',
    points: [[0, 0]],
  });
  assert.equal(status, 400, '越界的点必须 400');
  assert.equal(json?.ok, false);
  assert.match(json?.message ?? '', /影像范围之外/);
  assert.doesNotMatch(json?.message ?? '', /NaN/, '报错里不能出现 NaN');
});

test('端点：经纬度本身就不合法 → 400（不是 NaN）', async () => {
  const { status, json } = await postPixels({
    path: 'proj4547.tif',
    points: [[999, 30.5]],
  });
  assert.equal(status, 400);
  assert.match(json?.message ?? '', /经纬度范围/);
});

test('端点：没有 points → 400', async () => {
  const { status, json } = await postPixels({ path: 'proj4547.tif' });
  assert.equal(status, 400);
  assert.match(json?.message ?? '', /points/);
});

test('端点：allowOutside 时越界的点照常给坐标（视窗四角常常在影像外）', async () => {
  const { status, json } = await postPixels({
    path: 'proj4547.tif',
    points: [[0, 0]],
    allowOutside: true,
  });
  assert.equal(status, 200);
  assert.equal(json?.pixels?.length, 1);
  assert.ok(Number.isFinite(json.pixels[0].col), 'col 必须是有限数');
  assert.ok(Number.isFinite(json.pixels[0].row), 'row 必须是有限数');
});
