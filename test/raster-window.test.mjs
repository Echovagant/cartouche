import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', 'raster', p)).href;

const { windowForRegion, windowGeotransform, localRegion, windowBytes } = await import(eng('window.ts'));

/** 100x100 的图，左上角 (0,0)，像元 1x1，北向上（pixelH = -1） */
const FRAME = { width: 100, height: 100, geotransform: [0, 1, 0, 100, 0, -1] };

test('窗口：由区域反推，向上取整、向下取整', () => {
  const win = windowForRegion(FRAME, { minX: 10.2, minY: 20.8, maxX: 30.4, maxY: 40.1 });
  assert.deepEqual(win, { x: 10, y: 20, w: 21, h: 21 });
});

test('窗口：带外扩时四周各留 margin', () => {
  const win = windowForRegion(FRAME, { minX: 10, minY: 20, maxX: 30, maxY: 40 }, 4);
  assert.deepEqual(win, { x: 6, y: 16, w: 28, h: 28 });
});

test('窗口：不越出整图边界', () => {
  const win = windowForRegion(FRAME, { minX: -5, minY: -5, maxX: 500, maxY: 500 });
  assert.deepEqual(win, { x: 0, y: 0, w: 100, h: 100 });
});

test('窗口仿射：原点按窗口偏移平移，像元大小不变', () => {
  const win = windowForRegion(FRAME, { minX: 10, minY: 20, maxX: 30, maxY: 40 });
  const gt = windowGeotransform(FRAME, win);
  assert.equal(gt[0], 10, '原点 X 应平移到窗口左上角');
  assert.equal(gt[1], 1, '像元宽不变');
  assert.equal(gt[3], 80, '原点 Y 应平移（北向上时往下走）');
  assert.equal(gt[5], -1, '像元高不变');
});

test('局部区域：整图像素坐标换成窗口内坐标', () => {
  const win = { x: 10, y: 20, w: 20, h: 20 };
  const local = localRegion(win, { minX: 12, minY: 25, maxX: 18, maxY: 33 });
  assert.deepEqual(local, { minX: 2, minY: 5, maxX: 8, maxY: 13 });
});

test('窗口字节数：宽 × 高 × 波段数', () => {
  assert.equal(windowBytes({ x: 0, y: 0, w: 100, h: 50 }, 3), 15000);
});

/* ────────── 窗口化读取 ────────── */

const GDAL_BIN = process.env.GDAL_BIN ?? '';
const gdalBin = (tool) => (GDAL_BIN ? join(GDAL_BIN, tool) : tool);
// 可执行文件后缀随平台走：Windows 是 .exe，Linux 没有（CI 跑在 ubuntu 上）
const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

/**
 * 造一张 40x30 的 GTiff：每个像元值 = x*100 + y，便于断言。
 *
 * map info 的参考点是 1 基的像元号（ENVI 约定），所以参考点取 (1.0, 1.0)、
 * 参考像元的位置取 (0, 30)：GDAL 读进来后整图原点正好落在 (0, 30)、像元 1x1，
 * 也就是这张图铺满 [0,40]×[0,30]。
 */
function makeRaster(file, valueAt) {
  const w = 40, h = 30;
  const data = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = valueAt(x, y);
  const bin = file.replace(/\.tif$/, '.img');
  writeFileSync(bin, data);
  writeFileSync(file.replace(/\.tif$/, '.hdr'),
    ['ENVI','bands = 1','header offset = 0','file type = ENVI Standard',
     'data type = 1','interleave = bsq','byte order = 0',`lines = ${h}`,`samples = ${w}`,
     'header size = 0','pixel size = 1.0000000000e+000',
     'map info = {Geographic Lat/Lon, 1.0, 1.0, 0.0, 30.0, 1.0, 1.0, units=degrees}',''].join('\n'),
    'latin1');
  execFileSync(gdalBin(`gdal_translate${EXE_SUFFIX}`), ['-of','GTiff', bin, file], { stdio: 'ignore' });
  return { width: w, height: h };
}

test('窗口读取：只读到窗口内的像素，且尺寸是窗口尺寸', async () => {
  const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
  const loc = resolveGdal();
  assert.ok(loc, '本机需装好 GDAL');

  const dir = mkdtempSync(join(tmpdir(), 'cartouche-win-'));
  try {
    const tif = join(dir, 'r.tif');
    makeRaster(tif, (x, y) => (x * 100 + y) & 0xff);

    const { readRasterWindow } = await import(eng('raw.ts'));
    const win = { x: 5, y: 6, w: 10, h: 8 };
    const px = await readRasterWindow(loc, tif, win);

    assert.equal(px.width, 10);
    assert.equal(px.height, 8);
    assert.equal(px.bandCount, 1);
    assert.equal(px.bands[0].length, 80);
    // 窗口内第一个像元 = 整图 (5,6) 的值
    assert.equal(px.bands[0][0], (5 * 100 + 6) & 0xff);
    // 窗口原点应平移
    assert.equal(px.geotransform[0], 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('窗口读取：窗口越出整图范围时报错，不静默返回', async () => {
  const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
  const loc = resolveGdal();
  assert.ok(loc, '本机需装好 GDAL');

  const dir = mkdtempSync(join(tmpdir(), 'cartouche-win-'));
  try {
    const tif = join(dir, 'r.tif');
    makeRaster(tif, (x, y) => (x * 100 + y) & 0xff);

    const { readRasterWindow } = await import(eng('raw.ts'));
    // 整图只有 40 宽，窗口 30+20 已经越界
    await assert.rejects(
      () => readRasterWindow(loc, tif, { x: 30, y: 0, w: 20, h: 10 }),
      /窗口越出栅格范围/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ────────── 局部覆盖合成 ────────── */

/**
 * 造一个与原图**同一像元网格**的窗口文件（北向上）。
 *
 * cornerX/cornerY 是窗口左上角的地理坐标；ENVI 的 map info 里
 * 参考点取 (1,1)、像元大小 1.0，读进来后原点正好落在 (cornerX, cornerY)。
 *
 * ⚠️ 千万别改用 -a_ullr：那会让输出变成南向上，gdalbuildvrt 会直接拒绝。
 */
function makeWindowFile(file, w, h, cornerX, cornerY, value) {
  const data = Buffer.alloc(w * h, value);
  const bin = file.replace(/\.tif$/, '.img');
  writeFileSync(bin, data);
  writeFileSync(file.replace(/\.tif$/, '.hdr'),
    ['ENVI', `samples = ${w}`, 'bands = 1', 'header offset = 0', 'file type = ENVI Standard',
     'data type = 1', 'interleave = bsq', 'byte order = 0', `lines = ${h}`,
     'header size = 0', 'pixel size = 1.0000000000e+000',
     `map info = {Geographic Lat/Lon, 1.0, 1.0, ${cornerX}.0, ${cornerY}.0, 1.0, 1.0, units=degrees}`, ''].join('\n'),
    'latin1');
  execFileSync(gdalBin(`gdal_translate${EXE_SUFFIX}`), ['-of', 'GTiff', bin, file], { stdio: 'ignore' });
}

/** 按地理坐标探一个像元的值（-geoloc：默认是像元/行坐标，不是地理坐标） */
function probeGeo(file, x, y) {
  const out = execFileSync(gdalBin(`gdallocationinfo${EXE_SUFFIX}`), ['-valonly', '-geoloc', file, String(x), String(y)], { encoding: 'utf8' });
  return out.trim().split('\n').pop();
}

test('局部覆盖：尺寸不变、窗口内被覆盖、窗口外逐像素原样', async () => {
  const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
  const { overlayWindowOntoRaster } = await import(eng('overlay.ts'));
  const loc = resolveGdal();
  assert.ok(loc, '本机需装好 GDAL');

  const dir = mkdtempSync(join(tmpdir(), 'cartouche-ovl-'));
  try {
    // 原图：40x30，铺满 geo [0,40]x[0,30]，值 10
    const full = join(dir, 'full.tif');
    makeRaster(full, () => 10);
    // 窗口：8x6，盖住 geo [4,12]x[6,12]，值 99
    const winFile = join(dir, 'win.tif');
    makeWindowFile(winFile, 8, 6, 4, 12, 99);

    const out = join(dir, 'out.tif');
    await overlayWindowOntoRaster(loc, full, winFile, out);

    // 尺寸不变
    const info = execFileSync(gdalBin(`gdalinfo${EXE_SUFFIX}`), ['-nomd', '-noct', out], { encoding: 'utf8' });
    assert.match(info, /Size is 40, 30/, '输出尺寸必须与原图一致');

    // 窗口内 = 99，窗口外 = 10
    assert.equal(probeGeo(out, 6, 8), '99', '窗口内应被覆盖');
    assert.equal(probeGeo(out, 30, 25), '10', '窗口外应原样搬运');
    assert.equal(probeGeo(out, 2, 2), '10', '窗口外应原样搬运');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
