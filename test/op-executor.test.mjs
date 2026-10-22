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
const { readRasterPixels } = await import(eng('raster/index.ts'));
const { executePlan, previewOp, normalizePlan, listImplementedOps } = await import(eng('ops/index.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

/** 造一张 16x12 的三波段影像（与 raster-ops 测试同一套做法） */
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

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-ops-'));
  const store = new LocalFolderStore(dir);
  const marked = await makeRaster(dir, 'marked', (x, y, b) => {
    const inMark = x >= 4 && x < 10 && y >= 3 && y < 8;
    return inMark ? 250 : (x * 7 + y * 3 + b * 40 + 11) % 200;
  });
  return { dir, store, marked };
}

const REGION = { minX: 4, minY: 3, maxX: 10, maxY: 8 };
const PAINT = { op: 'raster.paint', params: { target: 'marked.tif', region: REGION, color: '#00FF00' } };

test('调度器：空计划 → 什么都不做，也不算失败', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, { version: '1.0', ops: [] });
    assert.equal(res.ok, true);
    assert.equal(res.results.length, 0);
    assert.equal(res.completed, 0);
    assert.equal(res.failedAt, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('调度器：单条 op 成功 → 有量化影响，且文件真的改了', async () => {
  const { dir, store, marked } = await setup();
  try {
    const before = await readRasterPixels(loc, marked);
    const res = await executePlan({ loc, store }, PAINT);

    assert.equal(res.ok, true);
    assert.equal(res.results.length, 1);
    assert.equal(res.completed, 1);
    const r = res.results[0];
    assert.equal(r.ok, true);
    assert.equal(r.op, 'raster.paint');
    assert.equal(r.target, 'marked.tif');
    // 影响面必须报出来，而且要跟总像元数对得上
    assert.ok(r.impact, '要有影响报告');
    assert.equal(r.impact.totalPixels, 16 * 12);
    assert.ok(r.impact.affectedPixels > 0, '涂色应当影响到一些像元');
    assert.ok(r.impact.affectedRatio > 0 && r.impact.affectedRatio <= 1);
    // 备份必须真的生成了
    assert.ok(r.impact.backupPath, '写回前要有备份');
    // 校验和必须变了
    assert.notEqual(r.impact.checksumBefore, r.impact.checksumAfter);

    const after = await readRasterPixels(loc, marked);
    assert.notEqual(before.checksum, after.checksum, '文件内容应当变了');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('调度器：中途失败**不回滚** —— 前面的改动照常生效，后面的不再执行', async () => {
  const { dir, store, marked } = await setup();
  try {
    const before = await readRasterPixels(loc, marked);
    const res = await executePlan({ loc, store }, {
      version: '1.0',
      ops: [
        PAINT,
        // 这一条会失败：目标文件不存在
        { op: 'raster.adjustLevels', params: { target: 'missing.tif', method: 'linear-stretch' } },
        // 这一条**不该被执行**（失败后就地停下）
        { op: 'raster.paint', params: { target: 'marked.tif', region: { minX: 0, minY: 0, maxX: 2, maxY: 2 }, color: '#FF0000' } },
      ],
    });

    assert.equal(res.ok, false);
    assert.equal(res.completed, 1, '只有第一条算完成');
    assert.equal(res.failedAt, 1, '失败的是第 2 条（下标 1）');
    assert.equal(res.results.length, 2, '第三条不该被执行，所以没有它的结果');
    assert.equal(res.results[0].ok, true);
    assert.equal(res.results[1].ok, false);
    assert.ok(res.results[1].error && res.results[1].error.length > 0, '失败要有可读原因');

    // 关键：第一条的改动**还在**（没有回滚）
    const after = await readRasterPixels(loc, marked);
    assert.notEqual(before.checksum, after.checksum, '第一条的改动必须保留，不能回滚');

    // 而且第三条确实没跑：左上角 2x2 应当还是原样
    const px = await readRasterPixels(loc, marked);
    const idx = 0; // (0,0)
    assert.notEqual(px.bands[0]?.[idx], 255, '第三条（红色 2x2）不该被执行');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('调度器：未实现的 op 明确说"尚未支持"，不静默跳过', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      version: '1.0',
      ops: [{ op: 'feature.setAttributes', params: { target: 'marked.tif', where: 'x=1', set: { a: 1 } } }],
    });
    assert.equal(res.ok, false);
    assert.equal(res.results.length, 1);
    const r = res.results[0];
    assert.equal(r.unimplemented, true, '要标出"未实现"');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /尚未支持/, '错误文案要说清楚是"尚未支持"');
    assert.equal(res.failedAt, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('调度器：预演不落盘 —— 像元数是精确值，但文件一个字节都没动', async () => {
  const { dir, store, marked } = await setup();
  try {
    const before = await readRasterPixels(loc, marked);
    const rec = await previewOp({ loc, store }, PAINT);

    assert.equal(rec.ok, true, '预演本身不该失败：' + (rec.error ?? ''));
    assert.ok(rec.impact);
    assert.equal(rec.impact.dryRun, true, '要标明这是预演');
    assert.ok(rec.impact.affectedPixels > 0, '预演要给出像元数');
    assert.equal(rec.impact.totalPixels, 16 * 12);
    assert.equal(rec.impact.backupPath, null, '预演不该产生备份');

    const after = await readRasterPixels(loc, marked);
    assert.equal(before.checksum, after.checksum, '预演不能改文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('调度器：预期上限（maxAffectedPixels）超了就中止，且不改文件', async () => {
  const { dir, store, marked } = await setup();
  try {
    const before = await readRasterPixels(loc, marked);
    const res = await executePlan({ loc, store }, {
      version: '1.0',
      ops: [{ ...PAINT, expect: { maxAffectedPixels: 1 } }],
    });
    assert.equal(res.ok, false);
    assert.equal(res.completed, 0);
    assert.equal(res.failedAt, 0);
    assert.match(res.results[0].error ?? '', /超出预期上限/);
    const after = await readRasterPixels(loc, marked);
    assert.equal(before.checksum, after.checksum, '超限中止时不能改文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('调度器：参数不对要报可读原因，不能崩', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      version: '1.0',
      ops: [{ op: 'raster.paint', params: { region: REGION, color: '#00FF00' } }],
    });
    assert.equal(res.ok, false);
    assert.equal(res.results.length, 1);
    assert.match(res.results[0].error ?? '', /target/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('调度器：绝对路径目标一律拒绝（不能借它逃出工作区）', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      version: '1.0',
      ops: [{ op: 'raster.paint', params: { target: 'C:/Windows/System32/drivers/etc/hosts', region: REGION, color: '#00FF00' } }],
    });
    assert.equal(res.ok, false);
    assert.match(res.results[0].error ?? '', /相对路径/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('调度器：画笔掩膜只影响掩膜覆盖的像元', async () => {
  const { dir, store, marked } = await setup();
  try {
    // 16x12 的掩膜，只点亮 (1,1) 一个像元
    const bytes = new Uint8Array(16 * 12);
    bytes[1 * 16 + 1] = 255;
    const res = await executePlan({ loc, store }, {
      version: '1.0',
      ops: [{
        op: 'raster.paint',
        params: {
          target: 'marked.tif',
          region: { minX: 0, minY: 0, maxX: 16, maxY: 12 },
          color: '#00FF00',
          mask: { width: 16, height: 12, data: Buffer.from(bytes).toString('base64') },
        },
      }],
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    // 只该动 1 个像元
    assert.equal(res.results[0].impact?.affectedPixels, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('计划归一化：单条 op 与计划文档走同一条路', () => {
  const single = normalizePlan({ op: 'raster.paint', params: {} });
  assert.equal(single.ops.length, 1);
  assert.equal(single.ops[0].op, 'raster.paint');

  const doc = normalizePlan({ version: '1.0', intent: '把标注涂绿', ops: [single.ops[0]] });
  assert.equal(doc.ops.length, 1);
  assert.equal(doc.intent, '把标注涂绿');
});

test('已实现的 op 清单：矢量编辑类不在其中（矢量编辑类 op 尚未实现）', () => {
  const ops = listImplementedOps();
  assert.ok(ops.includes('raster.paint'));
  assert.ok(ops.includes('raster.adjustLevels'));
  assert.ok(ops.includes('raster.erase'));
  assert.ok(!ops.includes('feature.setAttributes'), '矢量编辑还没做，不能登记成已实现');
  assert.ok(!ops.includes('vector.overlay'));
});
