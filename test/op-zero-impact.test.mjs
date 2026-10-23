/**
 * 「改了 0 像元却报成功」的第二处形态。
 *
 * 上一轮修的是「region 缺省」那条路（requireRegion 的 optional 缺参返回 undefined）。
 * 这一轮盯的是**另一条路：region 给了，但落空**。
 *
 * 实测过的形态（构造的 16×12 三波段栅格，共 192 个像元）：
 *
 *   | 用例                                    | 闸门① | 预演 | 影响像元 |
 *   |-----------------------------------------|--------|------|----------|
 *   | paint，region 完全在影像外               | PASS   | ok=true | 0 / 192 |
 *   | paint，region 全为负                    | PASS   | ok=true | 0 / 192 |
 *   | inpaint / erase / replaceRegion，region 在外 | PASS | ok=true | 0 / 192 |
 *   | paint，掩膜全为 0                       | PASS   | ok=true | 0 / 192 |
 *   | execute + expect.maxAffectedPixels=10    | —      | ok=true | 0 / 192 |
 *
 * 现在这些都必须**报错**：预演与执行给一致的结论，且一个字节都不许写盘。
 *
 * 本文件里造出来的栅格（16×12 三波段、像元值由公式生成）、掩膜字节、文件名
 * **全部是构造数据**，不对应任何真实数据。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { readRasterPixels } = await import(eng('raster/index.ts'));
const { executePlan, previewOp } = await import(eng('ops/index.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

/* ── 构造数据 ────────────────────────────────────────────── */

/** 造一张 16x12 的三波段影像（构造数据：像元值由公式生成，与真实数据无关） */
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
  await gdal.translate([
    '-of', 'GTiff',
    '-a_srs', 'EPSG:4326',
    '-a_ullr', '120.30', '30.532', '120.316', '30.52',
    bin, tif,
  ]);
  return tif;
}

let ctx = null;

/** 构造好的工作区：target 与 source 同尺寸、同仿射参数（replaceRegion 要求） */
async function setup() {
  if (ctx) return ctx;
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-zero-impact-'));
  const store = new LocalFolderStore(dir);
  const pattern = (x, y, b) => (x * 7 + y * 3 + b * 40 + 11) % 200;
  const target = await makeRaster(dir, 'target', pattern);
  // source 必须与 target **不同**：两张一样的图替换完看不出差别
  const source = await makeRaster(dir, 'source', (x, y, b) => (x * 5 + y * 11 + b * 17 + 200) % 256);
  ctx = { dir, store, target, source };
  return ctx;
}

after(async () => {
  if (ctx) await rm(ctx.dir, { recursive: true, force: true });
});

/* ── 用例表 ──────────────────────────────────────────────── */

/** 完全在影像（16×12）之外的区域 */
const OUTSIDE = { minX: 100, minY: 100, maxX: 110, maxY: 110 };
/** 全为负的区域 */
const NEGATIVE = { minX: -30, minY: -30, maxX: -20, maxY: -20 };
/** 盖住整张图的区域（配合全零掩膜用） */
const WHOLE = { minX: 0, minY: 0, maxX: 16, maxY: 12 };

/** 全零掩膜：16×12，一个像元都没点亮 */
function zeroMask() {
  return { width: 16, height: 12, data: Buffer.from(new Uint8Array(16 * 12)).toString('base64') };
}

/** 目录里有没有备份文件（备份名形如 <原名>.bak.<时间戳>） */
async function backupsOf(dir) {
  const entries = await readdir(dir);
  return entries.filter((n) => n.includes('.bak.'));
}

/* ── 1. 逐个用例：预演与执行都必须失败 ──────────────────── */

const CASES = [
  {
    id: 'paint：region 完全在影像外',
    op: 'raster.paint',
    params: { target: 'dataset://target.tif', region: OUTSIDE, color: '#00FF00' },
  },
  {
    id: 'paint：region 全为负',
    op: 'raster.paint',
    params: { target: 'dataset://target.tif', region: NEGATIVE, color: '#00FF00' },
  },
  {
    id: 'inpaint：region 完全在影像外',
    op: 'raster.inpaint',
    params: { target: 'dataset://target.tif', region: OUTSIDE },
  },
  {
    id: 'erase：region 完全在影像外',
    op: 'raster.erase',
    params: { target: 'dataset://target.tif', region: OUTSIDE },
  },
  {
    id: 'replaceRegion：region 完全在影像外',
    op: 'raster.replaceRegion',
    params: { target: 'dataset://target.tif', source: 'dataset://source.tif', region: OUTSIDE },
  },
  {
    id: 'paint：掩膜全为 0',
    op: 'raster.paint',
    params: { target: 'dataset://target.tif', region: WHOLE, color: '#00FF00', mask: zeroMask() },
  },
];

for (const c of CASES) {
  test(`零影响用例：${c.id} —— 预演与执行都必须报错`, async () => {
    const ctx2 = await setup();
    const before = await readRasterPixels(loc, ctx2.target);
    const backupsBefore = await backupsOf(ctx2.dir);

    // 预演
    const rec = await previewOp({ loc, store: ctx2.store }, { op: c.op, params: c.params });
    assert.equal(rec.ok, false, `${c.id}：预演不该报成功（实际 affectedPixels=${rec.impact?.affectedPixels}）`);
    assert.ok((rec.error ?? '').length > 0, `${c.id}：失败要有可读原因`);
    assert.equal(rec.impact, undefined, `${c.id}：失败不该带着"影响面"报告`);

    // 执行
    const res = await executePlan({ loc, store: ctx2.store }, { op: c.op, params: c.params });
    assert.equal(res.ok, false, `${c.id}：执行不该报成功`);
    assert.equal(res.completed, 0, `${c.id}：不该有完成的条目`);
    assert.equal(res.failedAt, 0);
    assert.equal(res.results[0].ok, false, `${c.id}：结果必须标出失败`);

    // 一个字节都不许写盘
    const after = await readRasterPixels(loc, ctx2.target);
    assert.equal(before.checksum, after.checksum, `${c.id}：文件必须一个字节都不动`);
    assert.deepEqual(await backupsOf(ctx2.dir), backupsBefore, `${c.id}：不该生成备份`);
  });
}

test('零影响用例：region 落在影像外时，错误信息要说清影像尺寸与区域范围', async () => {
  const c = await setup();
  const rec = await previewOp(
    { loc, store: c.store },
    { op: 'raster.paint', params: { target: 'dataset://target.tif', region: OUTSIDE, color: '#00FF00' } },
  );
  assert.equal(rec.ok, false);
  const err = rec.error ?? '';
  assert.match(err, /区域没有落到影像上/, '要说清是「区域没落到影像上」');
  assert.match(err, /16×12/, '要给出影像尺寸');
  assert.match(err, /minX=100/, '要给出区域范围');
  assert.match(err, /maxY=110/, '要给出区域范围');
});

/* ── 2. expect.maxAffectedPixels 不是「至少改几个」 ─────────── */

test('零影响用例：带 expect.maxAffectedPixels 的执行同样必须失败（上限不是下限）', async () => {
  const c = await setup();
  const before = await readRasterPixels(loc, c.target);
  const backupsBefore = await backupsOf(c.dir);

  const res = await executePlan(
    { loc, store: c.store },
    {
      op: 'raster.paint',
      params: { target: 'dataset://target.tif', region: OUTSIDE, color: '#00FF00' },
      expect: { maxAffectedPixels: 10 },
    },
  );
  assert.equal(res.ok, false, '0 像元在任何情况下都不该算成功');
  assert.equal(res.completed, 0);
  assert.equal(res.failedAt, 0);
  assert.equal(res.results[0].ok, false);
  assert.ok((res.results[0].error ?? '').length > 0, '失败要有可读原因');

  const after = await readRasterPixels(loc, c.target);
  assert.equal(before.checksum, after.checksum, '不该改文件');
  assert.deepEqual(await backupsOf(c.dir), backupsBefore, '不该生成备份');
});

/* ── 3. 反过来：真的改到像元时必须照常成功 ─────────────────── */

test('零影响用例的反面：区域落在影像内时必须照常成功（别把闸门修过头）', async () => {
  const c = await setup();
  const rec = await previewOp(
    { loc, store: c.store },
    {
      op: 'raster.paint',
      params: {
        target: 'dataset://target.tif',
        region: { minX: 4, minY: 3, maxX: 10, maxY: 8 },
        color: '#00FF00',
      },
    },
  );
  assert.equal(rec.ok, true, rec.error ?? '');
  assert.equal(rec.impact?.affectedPixels, 30, '6×5 = 30 个像元');
  assert.equal(rec.impact?.totalPixels, 16 * 12);
});
