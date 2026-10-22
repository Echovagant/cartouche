/**
 * 画笔掩膜的**坐标语义**测试。
 *
 * 盯住一件事：掩膜的字节是相对 region 的，引擎查表时必须减掉区域原点。
 *
 * 背景：画布把笔迹栅格化成「region 包围盒大小」的掩膜
 * （web/app/canvas/editGeometry.ts 的 rasterizeStroke 写的是
 *   mask[(py - region.minY) * width + (px - region.minX)]），
 * 也就是说掩膜的第 (0,0) 个字节对应的是 **region 左上角**那个像元，
 * 不是栅格的 (0,0)。
 *
 * 引擎原来用栅格绝对坐标查表（maskAlphaAt(mask, x, y)），
 * region.minX/minY ≠ 0 时就查错了位置 —— 轻则一笔什么都没画上，
 * 重则画到隔壁像元上。
 *
 * 本文件里造出来的栅格（16×12 三波段、像元值由公式生成）与掩膜字节
 * **全部是构造数据**，不对应任何真实数据。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { executePlan, previewOp } = await import(eng('ops/index.ts'));
const { readRasterPixels } = await import(eng('raster/index.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

/** 造一张 16×12 的三波段影像（构造数据：像元值由公式生成，与真实数据无关） */
async function makeRaster(dir, name, fn) {
  const w = 16;
  const h = 12;
  const bands = 3;
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
  await gdal.translate([
    '-of', 'GTiff',
    '-a_srs', 'EPSG:4326',
    '-a_ullr', '120.30', '30.532', '120.316', '30.52',
    bin, tif,
  ]);
  return tif;
}

let ctx = null;

async function setup() {
  if (ctx) return ctx;
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-mask-region-'));
  const store = new LocalFolderStore(dir);
  ctx = { dir, store };
  return ctx;
}

/** 每个用例一张**自己的**影像：执行类用例会真的改文件，不能互相踩 */
async function freshTarget(name) {
  const c = await setup();
  const target = await makeRaster(c.dir, name, (x, y, b) => (x * 7 + y * 3 + b * 40 + 11) % 200);
  return { ...c, target };
}

after(async () => {
  if (ctx) await rm(ctx.dir, { recursive: true, force: true });
});

/**
 * 区域起点**不在 (0,0)**：这正是笔迹落在图幅中间时的常态。
 * 掩膜 4×4，只有局部 (2,2) 亮着 → 对应栅格绝对像元 (8, 6)。
 */
const REGION = { minX: 6, minY: 4, maxX: 10, maxY: 8 };

function brushMask() {
  const width = REGION.maxX - REGION.minX;
  const height = REGION.maxY - REGION.minY;
  const bytes = new Uint8Array(width * height);
  bytes[2 * width + 2] = 255; // 局部 (2,2) → 绝对 (8,6)
  return { width, height, data: Buffer.from(bytes).toString('base64') };
}

test('掩膜查表必须相对 region：笔迹落在 region 外的像元上就是错的', async () => {
  const c = await freshTarget('target-exec');
  const before = await readRasterPixels(loc, c.target);

  const res = await executePlan(
    { loc, store: c.store },
    {
      op: 'raster.paint',
      params: {
        target: 'dataset://target-exec.tif',
        region: REGION,
        color: '#00FF00',
        mask: brushMask(),
      },
    },
  );
  assert.equal(res.ok, true, JSON.stringify(res.results));
  assert.equal(
    res.results[0]?.impact?.affectedPixels,
    1,
    '掩膜只亮一个像元，就只该改一个像元',
  );

  const after = await readRasterPixels(loc, c.target);
  const diffs = [];
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      const i = y * before.width + x;
      if (before.bands[0]?.[i] !== after.bands[0]?.[i]) diffs.push([x, y]);
    }
  }
  assert.deepEqual(
    diffs,
    [[8, 6]],
    '改动的必须正好是「掩膜局部 (2,2) 对应的绝对像元 (8,6)」',
  );
});

test('预演给出的影响像元数与真执行一致（笔迹不是空跑）', async () => {
  const c = await freshTarget('target-preview');
  const rec = await previewOp(
    { loc, store: c.store },
    {
      op: 'raster.paint',
      params: {
        target: 'dataset://target-preview.tif',
        region: REGION,
        color: '#00FF00',
        mask: brushMask(),
      },
    },
  );
  assert.equal(rec.ok, true, rec.error ?? '');
  assert.equal(rec.impact?.affectedPixels, 1);
});

test('region 从 (0,0) 起步时行为不变（掩膜与区域重合的的老路径不受影响）', async () => {
  const c = await freshTarget('target-origin');
  const region = { minX: 0, minY: 0, maxX: 4, maxY: 4 };
  const bytes = new Uint8Array(16);
  bytes[0] = 255; // 局部 (0,0) → 绝对 (0,0)
  const rec = await previewOp(
    { loc, store: c.store },
    {
      op: 'raster.paint',
      params: {
        target: 'dataset://target-origin.tif',
        region,
        color: '#00FF00',
        mask: { width: 4, height: 4, data: Buffer.from(bytes).toString('base64') },
      },
    },
  );
  assert.equal(rec.ok, true, rec.error ?? '');
  assert.equal(rec.impact?.affectedPixels, 1);
});
