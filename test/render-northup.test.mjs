/**
 * 南向上（正 NS 分辨率）的栅格不能直接出图。
 *
 * 背景：编辑路径（raster/overlay.ts 的 assertNorthUp）早就明确拒绝南向上的源，
 * 渲染路径（export/raster-image.ts）却没有这道闸门。
 * 而 GDAL 两条路的**方向行为不一样**（2026-10-23 实测，GDAL 3.13.3，
 * 样本是 8×4 单波段、每行一个可辨认的值 10/11/12/13）：
 *
 *   - gdal_translate 路：产物第 0 行 = 源文件第 0 行。
 *     南向上的源，第 0 行在**南边** → 出来的图上下颠倒，而退出码是 0、stderr 是空的。
 *   - gdalwarp 路：产物第 0 行 = 源文件最后一行 → 方向是**对的**（warp 按坐标重采样）。
 *
 * 所以这组用例盯三件事：
 *   1. translate 路遇到南向上的源必须**明确报错**，不能给一张颠倒的图；
 *   2. warp 路不受影响（GDAL 本来就处理得对，拦它是无谓的功能损失）；
 *   3. 北向上的源在两条路上都不受影响，方向与像元值都对。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { renderRasterPng } = await import(eng('export/raster-image.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

/**
 * 临时目录位置。
 *
 * 与仓库里其它测试同一套做法；这台机器的 C 盘空间紧张，
 * 可以用 CARTOUCHE_TEST_TMP 指到 D 盘 —— 路径不进代码，测试产物别往系统盘上堆。
 */
const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || tmpdir();

const W = 8;
const H = 4;

/**
 * 造一张单波段 GeoTIFF：第 y 行的像元值 = 10 + y。
 *
 * ⚠️ `-a_ullr` 的顺序是 **ulx uly lrx lry**（上左 → 下右）：
 *   - 北向上：上左 y（30）**大于**下右 y（29.992）→ gt[5] 为负；
 *   - 南向上：上左 y（29.992）**小于**下右 y（30）→ gt[5] 为正。
 * 写反了就成了另一种方向 —— 所以下面每张图都要先核对 gt[5] 的符号。
 */
async function makeTiff(dir, name, { southUp }) {
  const bin = join(dir, `${name}.bin`);
  const hdr = join(dir, `${name}.hdr`);
  const raw = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) raw.fill(10 + y, y * W, (y + 1) * W);
  await writeFile(bin, raw);
  await writeFile(
    hdr,
    [
      'ENVI',
      `samples = ${W}`,
      `lines   = ${H}`,
      'bands   = 1',
      'header offset = 0',
      'file type = ENVI Standard',
      'data type = 1',
      'interleave = bsq',
      'byte order = 0',
      '',
    ].join('\n'),
    'utf8',
  );
  const tif = join(dir, `${name}.tif`);
  const ullr = southUp
    ? ['120', '29.992', '120.008', '30']
    : ['120', '30', '120.008', '29.992'];
  const res = await gdal.translate([
    '-of', 'GTiff',
    '-a_srs', 'EPSG:4326',
    '-a_ullr', ...ullr,
    bin,
    tif,
  ]);
  assert.ok(res.ok, `造图失败：${res.stderr}`);
  return tif;
}

/** 读出仿射参数与尺寸 */
async function infoOf(path) {
  const res = await gdal.info(path, ['-json']);
  assert.ok(res.ok, `gdalinfo 失败：${res.stderr}`);
  const j = JSON.parse(res.stdout);
  return { gt: j.geoTransform, size: j.size };
}

/**
 * 把渲染出来的 PNG 逐行读回来。
 *
 * 走 GDAL 自己（PNG → ENVI 裸文件 → 读字节）而不是自己解 PNG：
 * 省掉一个 PNG 解码器，也避免"解码器实现不同导致结论不同"。
 */
async function rowsOfPng(png, dir, name) {
  const pngPath = join(dir, `${name}.png`);
  await writeFile(pngPath, png);
  const bin = join(dir, `${name}-read.bin`);
  const res = await gdal.translate(['-of', 'ENVI', '-ot', 'Byte', pngPath, bin]);
  assert.ok(res.ok, `读 PNG 失败：${res.stderr}`);
  const raw = await readFile(bin);
  const { size } = await infoOf(pngPath);
  const [w, h] = size;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) row.push(raw[y * w + x]);
    rows.push(row);
  }
  return rows;
}

/** 每个像素都一样的一行 */
const rowOf = (v) => new Array(W).fill(v);

/* ── 1. 样本本身的方向必须对，否则下面的结论全是空的 ────────────── */

test('样本：南向上那张的 NS 分辨率为正，北向上那张为负', async () => {
  const dir = await mkdtemp(join(TMP_BASE, 'cartouche-northup-'));
  try {
    const south = await makeTiff(dir, 'south', { southUp: true });
    const north = await makeTiff(dir, 'north', { southUp: false });
    const s = await infoOf(south);
    const n = await infoOf(north);
    assert.ok(s.gt[5] > 0, `南向上样本的 gt[5] 应为正，实为 ${s.gt[5]}`);
    assert.ok(n.gt[5] < 0, `北向上样本的 gt[5] 应为负，实为 ${n.gt[5]}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── 2. translate 路：南向上的源必须明确报错 ───────────────────── */

test('渲染：南向上的源走 gdal_translate 路时明确报错，不给颠倒的图', async () => {
  const dir = await mkdtemp(join(TMP_BASE, 'cartouche-northup-'));
  try {
    const tif = await makeTiff(dir, 'south', { southUp: true });
    await assert.rejects(
      () => renderRasterPng(loc, { path: tif, width: W, height: H }),
      (err) => {
        assert.match(err.message, /南向上/, '要说清是南向上');
        assert.match(err.message, /北向上/, '要说清怎么改：先转成北向上');
        assert.match(err.message, /颠倒/, '要说清后果是上下颠倒');
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('渲染：南向上的源带 bbox 时同样报错（裁切那条路也会翻）', async () => {
  const dir = await mkdtemp(join(TMP_BASE, 'cartouche-northup-'));
  try {
    const tif = await makeTiff(dir, 'south', { southUp: true });
    await assert.rejects(
      () =>
        renderRasterPng(loc, {
          path: tif,
          width: W,
          height: H,
          bbox: [120, 29.992, 120.008, 30],
        }),
      /南向上/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── 3. warp 路：方向本来就是对的，不拦 ────────────────────────── */

test('渲染：南向上的源走 gdalwarp 重投影路时方向正确（实测 warp 不翻转）', async () => {
  const dir = await mkdtemp(join(TMP_BASE, 'cartouche-northup-'));
  try {
    const tif = await makeTiff(dir, 'south', { southUp: true });
    const res = await renderRasterPng(loc, {
      path: tif,
      width: W,
      height: H,
      targetCrs: 'EPSG:3857',
    });
    assert.ok(res.command[0].includes('warp'), `应当走 gdalwarp，实际：${res.command[0]}`);
    const rows = await rowsOfPng(res.png, dir, 'warp-south');
    // 源文件第 0 行在南边 → 正确的图，第 0 行应该是最北那一行（值 13）
    assert.deepEqual(rows[0], rowOf(13), '重投影后的图应当是正的（顶行 = 最北一行）');
    assert.deepEqual(rows[3], rowOf(10), '底行应当是最南一行');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── 4. 北向上的源不受影响 ─────────────────────────────────────── */

test('渲染：北向上的源不受这道闸门影响，两条路的像元与方向都对', async () => {
  const dir = await mkdtemp(join(TMP_BASE, 'cartouche-northup-'));
  try {
    const tif = await makeTiff(dir, 'north', { southUp: false });

    const plain = await renderRasterPng(loc, { path: tif, width: W, height: H });
    assert.ok(plain.command[0].includes('translate'), '同 CRS 应走 gdal_translate');
    const plainRows = await rowsOfPng(plain.png, dir, 'north-plain');
    assert.deepEqual(plainRows[0], rowOf(10), '北向上的源：顶行应当是文件第 0 行');
    assert.deepEqual(plainRows[3], rowOf(13), '北向上的源：底行应当是文件最后一行');

    const warped = await renderRasterPng(loc, {
      path: tif,
      width: W,
      height: H,
      targetCrs: 'EPSG:3857',
    });
    assert.ok(warped.command[0].includes('warp'));
    const warpRows = await rowsOfPng(warped.png, dir, 'north-warp');
    assert.deepEqual(warpRows[0], rowOf(10), '北向上的源：重投影后顶行仍是最北一行');
    assert.deepEqual(warpRows[3], rowOf(13));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
