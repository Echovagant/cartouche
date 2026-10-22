import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { RasterEditor, readRasterPixels } = await import(eng('raster/index.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

/**
 * 造一张 16x12 的三波段影像。
 * ASCII Grid 只能单波段，这里直接写 ENVI 原始格式（BIP）+ 头，再用 GDAL 转成 GeoTIFF。
 */
async function makeRaster(dir, name, fn) {
  const w = 16, h = 12, bands = 3;
  const raw = new Uint8Array(w * h * bands);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let b = 0; b < bands; b++) {
        raw[(y * w + x) * bands + b] = fn(x, y, b) & 0xff;
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
  // 显式给出范围：16×12 像元 × 0.001°，左上角 (120.30, 30.532)
  await gdal.translate([
    '-of', 'GTiff',
    '-a_srs', 'EPSG:4326',
    '-a_ullr', '120.30', '30.532', '120.316', '30.52',
    bin, tif,
  ]);
  return tif;
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-raster-'));
  const store = new LocalFolderStore(dir);
  const editor = new RasterEditor({ loc, store });
  // 干净底图：与目标图**整体不同**（只在标注块内相同的底图，
  // 会让"替换范围扩大到全图"这种变异无法被检出 —— 这是实测踩过的坑）
  const clean = await makeRaster(dir, 'clean', (x, y, b) => (x * 10 + y + b * 60) % 200);
  // 带红色标注块的目标图
  const marked = await makeRaster(dir, 'marked', (x, y, b) => {
    const inMark = x >= 4 && x < 10 && y >= 3 && y < 8;
    return inMark ? 250 : (x * 7 + y * 3 + b * 40 + 11) % 200;
  });
  return { dir, store, editor, clean, marked };
}

const REGION = { minX: 4, minY: 3, maxX: 10, maxY: 8 };

test('栅格操作：擦除标注块后，区域内与干净底图一致，区域外零差异', async () => {
  const { dir, editor, clean, marked } = await setup();
  try {
    const before = await readRasterPixels(loc, marked);
    const res = await editor.erase({ target: 'marked.tif', region: REGION, source: 'clean.tif' });
    const after = await readRasterPixels(loc, marked);

    // 区域外逐像素完全一致
    let outsideDiff = 0;
    for (let y = 0; y < before.height; y++) {
      for (let x = 0; x < before.width; x++) {
        const inside = x >= REGION.minX && x < REGION.maxX && y >= REGION.minY && y < REGION.maxY;
        if (inside) continue;
        for (let b = 0; b < before.bandCount; b++) {
          if (before.bands[b][y * before.width + x] !== after.bands[b][y * before.width + x]) outsideDiff++;
        }
      }
    }
    assert.equal(outsideDiff, 0, '区域外必须零差异');

    // 区域内已不再是标注色，且与干净底图一致
    const center = 6 * before.width + 6;
    assert.notEqual(after.bands[0][center], 250, '标注色应已被替换');
    const cleanPx = await readRasterPixels(loc, clean);
    assert.equal(after.bands[0][center], cleanPx.bands[0][center], '区域内应与干净底图一致');

    assert.equal(res.verified, true);
    assert.ok(res.affectedPixels > 0, '应报告被影响的像元数');
    assert.ok(res.backupPath, '应生成备份');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('栅格操作：擦除后文件仍能被 GDAL 正确读出，尺寸与坐标系不变', async () => {
  const { dir, editor, marked } = await setup();
  try {
    const before = await readRasterPixels(loc, marked);
    await editor.erase({ target: 'marked.tif', region: REGION, source: 'clean.tif' });
    const after = await readRasterPixels(loc, marked);
    assert.equal(after.width, before.width);
    assert.equal(after.height, before.height);
    assert.equal(after.bandCount, before.bandCount);
    assert.ok(after.crs, '坐标系必须保留');
    assert.deepEqual(after.geotransform, before.geotransform, '仿射参数必须保留');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('栅格操作：修补把污点填成周围颜色，区域外不变', async () => {
  const { dir, editor, marked } = await setup();
  try {
    const before = await readRasterPixels(loc, marked);
    await editor.inpaint({ target: 'marked.tif', region: REGION, radiusPx: 3 });
    const after = await readRasterPixels(loc, marked);
    let outsideDiff = 0;
    for (let y = 0; y < before.height; y++) {
      for (let x = 0; x < before.width; x++) {
        const inside = x >= REGION.minX && x < REGION.maxX && y >= REGION.minY && y < REGION.maxY;
        if (inside) continue;
        if (before.bands[0][y * before.width + x] !== after.bands[0][y * before.width + x]) outsideDiff++;
      }
    }
    assert.equal(outsideDiff, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('栅格操作：提亮只改像素，不改几何', async () => {
  const { dir, editor, marked } = await setup();
  try {
    const before = await readRasterPixels(loc, marked);
    const res = await editor.adjustLevels({ target: 'marked.tif', method: 'linear-stretch' });
    const after = await readRasterPixels(loc, marked);
    assert.deepEqual(after.geotransform, before.geotransform);
    assert.notEqual(res.checksumAfter, res.checksumBefore, '像素应发生变化');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('栅格操作：涂色把区域填成指定颜色', async () => {
  const { dir, editor, marked } = await setup();
  try {
    await editor.paint({ target: 'marked.tif', region: REGION, color: [12, 34, 56] });
    const after = await readRasterPixels(loc, marked);
    const idx = 5 * after.width + 5;
    assert.equal(after.bands[0][idx], 12);
    assert.equal(after.bands[1][idx], 34);
    assert.equal(after.bands[2][idx], 56);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('栅格操作：裁切到指定范围，尺寸变小且坐标系保留', async () => {
  const { dir, editor, marked } = await setup();
  try {
    const before = await readRasterPixels(loc, marked);
    const res = await editor.clip({
      target: 'marked.tif',
      bbox: { minX: 120.302, minY: 30.522, maxX: 120.31, maxY: 30.529 },
    });
    const after = await readRasterPixels(loc, marked);
    assert.ok(after.width < before.width, '裁切后应更窄');
    assert.ok(after.height < before.height, '裁切后应更矮');
    assert.ok(after.crs, '坐标系必须保留');
    assert.equal(res.verified, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('栅格操作：重采样改变分辨率但保留范围', async () => {
  const { dir, editor, marked } = await setup();
  try {
    const before = await readRasterPixels(loc, marked);
    await editor.resample({ target: 'marked.tif', targetResolution: 0.002, resampleMethod: 'nearest' });
    const after = await readRasterPixels(loc, marked);
    assert.ok(after.width < before.width, '像元变粗后像元数应变少');
    assert.ok(after.crs, '坐标系必须保留');
    assert.notDeepEqual(after.geotransform, before.geotransform, '仿射参数应随分辨率变化');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('栅格操作：拼接把两幅合并成一幅', async () => {
  const { dir, editor, marked } = await setup();
  try {
    const other = await makeRaster(dir, 'other', (x, y, b) => (x * 3 + y * 5 + b * 40) % 200);
    const res = await editor.mosaic({ inputs: ['marked.tif', 'other.tif'] });
    assert.ok(res.verified);
    const merged = await readRasterPixels(loc, res.outputPath ?? 'merged.tif');
    assert.ok(merged.width >= 16, '拼接结果应覆盖两幅的并集');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('栅格操作：读回像元后能拿到校验和', async () => {
  const { dir, marked } = await setup();
  try {
    const px = await readRasterPixels(loc, marked);
    assert.ok(px.checksum, '应提供内容校验和');
    assert.equal(px.width, 16);
    assert.equal(px.height, 12);
    assert.equal(px.bandCount, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('栅格操作：读像素时会报出驱动名（写回闸门靠它判断）', async () => {
  const { dir, marked } = await setup();
  try {
    const px = await readRasterPixels(loc, marked);
    assert.equal(px.driver, 'GTiff', 'GeoTIFF 样本应报出 GTiff');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回闸门：非 GeoTIFF 的文件明确拒绝，且原文件一个字节不动', async () => {
  // 2026-10-22 实测的坑：写回统一走 `gdal_translate -of GTiff`，
  // 所以一个 HFA 的 .img 改完会变成 GeoTIFF 字节、扩展名却还是 .img —— ArcGIS 打不开。
  // 引擎必须在动手前就拒绝，而不是把文件改坏。
  const { dir, editor, marked } = await setup();
  try {
    const png = join(dir, 'marked.png');
    const tr = await gdal.translate(['-of', 'PNG', marked, png]);
    assert.equal(tr.ok, true, 'PNG 样本应生成成功');
    const before = await readFile(png);

    await assert.rejects(
      () => editor.paint({ target: 'marked.png', region: REGION, color: '#00FF00' }),
      /不能原样写回/,
    );

    const after = await readFile(png);
    assert.deepEqual(after, before, '被拒绝后原文件必须一个字节都不动');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
