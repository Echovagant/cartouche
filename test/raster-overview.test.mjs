/**
 * 金字塔（overviews）自动构建的验收。
 *
 * 核心证据不是"建出来了"，而是**原文件一个字节都没动**：
 * gdaladdo 不加 -ro 会就地重写原文件（几 GB 的影像重写一次要很久，
 * 而且违反"原文件只被我们明确改动"的底线），所以这里逐字节比对内容、
 * 再比对 mtime —— 内容不变但 mtime 变了，同样说明原文件被碰过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', 'raster', p)).href;

const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
const { writeRasterPixels } = await import(eng('raw.ts'));
const { newBand } = await import(eng('pixels.ts'));
const {
  DEFAULT_OVERVIEW_THRESHOLD_BYTES,
  hasOverviews,
  ensureOverviews,
} = await import(eng('overview.ts'));
const { RasterEditor, ensureRasterOverviews } = await import(eng('ops.ts'));
const { LocalFolderStore } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'workspace', 'index.ts')).href
);

const loc = resolveGdal();
assert.ok(loc, '本机需装好 GDAL');

/**
 * 造一张单波段 8 位 GeoTIFF（未压缩），像元值按序号铺开。
 *
 * 尺寸取 512x512 不是随便挑的：GDAL 的 gdaladdo 默认层级启发式要求
 * 概览边长大于 64 像元，256x256 会**退出码 0 但什么也不产出**
 * （实测 GDAL 3.13.3：128/256 都不生成 .ovr，512 起才生成）。
 * 用 256 做夹具会让"没建出来"看起来像功能坏了。
 */
async function makeTif(file, { width = 512, height = 512 } = {}) {
  const band = newBand('Byte', width * height);
  for (let i = 0; i < band.length; i++) band[i] = i & 0xff;
  await writeRasterPixels(loc, file, {
    width,
    height,
    bands: [band],
    pixelType: 'Byte',
    colorInterpretation: ['gray'],
    geotransform: [0, 1, 0, height, 0, -1],
    crs: null,
  });
  return file;
}

/** 临时目录：每个用例一个，结束即删 */
function tmpDir(tag) {
  return mkdtempSync(join(tmpdir(), `cartouche-${tag}-`));
}

test('金字塔：超过阈值自动建出外部 .ovr，原文件内容与 mtime 都不变', async () => {
  const dir = tmpDir('ovr');
  try {
    const tif = join(dir, 'big.tif');
    await makeTif(tif);

    const before = statSync(tif);
    const beforeBytes = readFileSync(tif);
    assert.equal(await hasOverviews(tif), false, '一开始不该有 .ovr');

    // 阈值压到 1 字节：真造几 GB 的文件不现实，阈值可注入才是可测的
    const res = await ensureOverviews(loc, tif, { thresholdBytes: 1 });

    assert.equal(res.built, true, '超过阈值就该建');
    assert.equal(res.ovrPath, `${tif}.ovr`, '应指向外部 .ovr');
    assert.ok(existsSync(`${tif}.ovr`), '外部 .ovr 必须落地');
    assert.ok(statSync(`${tif}.ovr`).size > 0, '.ovr 不能是空文件');
    assert.equal(await hasOverviews(tif), true, '建完应当有 .ovr');

    // 原文件必须原封不动：内容、字节数、mtime 三样都不能变
    const after = statSync(tif);
    assert.equal(after.size, before.size, '原文件大小不能变');
    assert.ok(readFileSync(tif).equals(beforeBytes), '原文件内容必须一个字节都不变');
    assert.equal(after.mtimeMs, before.mtimeMs, '原文件 mtime 不能变（-ro 不碰原文件）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('金字塔：小于阈值不建', async () => {
  const dir = tmpDir('ovr');
  try {
    const tif = join(dir, 'small.tif');
    await makeTif(tif);

    const res = await ensureOverviews(loc, tif, { thresholdBytes: 1024 * 1024 * 1024 });

    assert.equal(res.built, false, '小于阈值不该建');
    assert.equal(res.skippedReason, 'below-threshold', '要能区分"太小不建"');
    assert.equal(res.ovrPath, null);
    assert.equal(existsSync(`${tif}.ovr`), false, '不该留下 .ovr');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('金字塔：已经有 .ovr 不重复建', async () => {
  const dir = tmpDir('ovr');
  try {
    const tif = join(dir, 'twice.tif');
    await makeTif(tif);

    const first = await ensureOverviews(loc, tif, { thresholdBytes: 1 });
    assert.equal(first.built, true, '首次应该建出来');
    const ovrMtime = statSync(`${tif}.ovr`).mtimeMs;

    const second = await ensureOverviews(loc, tif, { thresholdBytes: 1 });
    assert.equal(second.built, false, '已有就不该再建');
    assert.equal(second.skippedReason, 'already-exists', '要能区分"已经有了"');
    assert.equal(second.ovrPath, `${tif}.ovr`, '已有的 .ovr 路径要回给调用方');
    assert.equal(statSync(`${tif}.ovr`).mtimeMs, ovrMtime, '已有的 .ovr 不该被重建');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('金字塔：文件不存在时不抛错，交给调用方决定', async () => {
  const dir = tmpDir('ovr');
  try {
    const missing = join(dir, 'nope.tif');

    const res = await ensureOverviews(loc, missing, { thresholdBytes: 1 });

    assert.equal(res.built, false);
    assert.equal(res.skippedReason, 'not-found', '要能区分"文件不在"');
    assert.equal(res.ovrPath, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('金字塔：构建失败要抛错并带上 GDAL 的原文', async () => {
  const dir = tmpDir('ovr');
  try {
    // 不是栅格的 .tif：gdaladdo 打不开，必须报错而不是静默"成功"
    const bad = join(dir, 'bad.tif');
    writeFileSync(bad, 'this is definitely not a raster');

    await assert.rejects(
      () => ensureOverviews(loc, bad, { thresholdBytes: 1 }),
      (err) => {
        assert.match(err.message, /构建金字塔失败/, '错误信息要说明是建金字塔失败');
        assert.match(err.message, /bad\.tif/, '错误信息要指名文件');
        assert.ok(err.message.length > '构建金字塔失败：bad.tif'.length + 10, '错误信息要带上 GDAL 原文');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('金字塔：默认阈值是 200MB', () => {
  assert.equal(DEFAULT_OVERVIEW_THRESHOLD_BYTES, 200 * 1024 * 1024);
});

/* ── 接线：金字塔进流程（改完图自动建） ─────────────────────────────
 *
 * 上面几组验的是"模块本身能建"；下面几组验的是"**流程里真的有人叫它**"。
 * 模块能用而没人调用，等于没有这个能力 —— 用户看不到，也享受不到。
 */

/** 涂一小块：走窗口路径（局部操作），写回后应自动建金字塔 */
const PAINT_REGION = { minX: 10, minY: 10, maxX: 40, maxY: 40 };

/**
 * 造一个带编辑器的环境。
 *
 * 阈值压到 1 字节：真造几 GB 的文件不现实，
 * 用小阈值把一张小图当成"大图"来验这条链路（与 overview.ts 的注入同理）。
 */
async function makeEditor(dir, deps = {}) {
  const tif = join(dir, 'edit.tif');
  await makeTif(tif);
  const store = new LocalFolderStore(dir);
  const editor = new RasterEditor({
    loc,
    store,
    overviewThresholdBytes: 1,
    ...deps,
  });
  return { tif, store, editor };
}

test('接线：改完一张图之后金字塔被建出来', async () => {
  const dir = tmpDir('ovrwiring');
  try {
    const { tif, editor } = await makeEditor(dir);

    const res = await editor.paint({
      target: 'edit.tif',
      region: PAINT_REGION,
      color: '#FF0000',
    });

    assert.equal(res.verified, true, '改图本身要成功');
    assert.ok(existsSync(`${tif}.ovr`), '改完图之后 .ovr 必须出现');
    assert.ok(statSync(`${tif}.ovr`).size > 0, '.ovr 不能是空文件');
    // 结果里要带得上这一步的记录：不然"建没建"无从查起
    assert.equal(res.overview?.built, true, '结果里要带上"金字塔建成了"');
    assert.equal(res.overview?.ovrPath, `${tif}.ovr`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('接线：小于阈值不建金字塔，但改图照样成功', async () => {
  const dir = tmpDir('ovrwiring');
  try {
    const { tif, editor } = await makeEditor(dir, { overviewThresholdBytes: DEFAULT_OVERVIEW_THRESHOLD_BYTES });

    const res = await editor.paint({
      target: 'edit.tif',
      region: PAINT_REGION,
      color: '#FF0000',
    });

    assert.equal(res.verified, true, '金字塔不该影响改图本身');
    assert.equal(existsSync(`${tif}.ovr`), false, '小于阈值就不该有 .ovr');
    assert.equal(res.overview?.built, false);
    assert.equal(res.overview?.skippedReason, 'below-threshold', '要能区分"太小不建"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('接线：已经有 .ovr 时不重复建', async () => {
  const dir = tmpDir('ovrwiring');
  try {
    const { tif, editor } = await makeEditor(dir);

    // 先建好一个（模拟"之前已经建过"）
    const first = await ensureOverviews(loc, tif, { thresholdBytes: 1 });
    assert.equal(first.built, true, '前置条件：先建出 .ovr');
    const ovrMtime = statSync(`${tif}.ovr`).mtimeMs;

    const res = await editor.paint({
      target: 'edit.tif',
      region: PAINT_REGION,
      color: '#FF0000',
    });

    assert.equal(res.verified, true, '改图本身要成功');
    assert.equal(res.overview?.built, false, '已有 .ovr 就不该重建');
    assert.equal(res.overview?.skippedReason, 'already-exists', '要能区分"已经有了"');
    assert.equal(statSync(`${tif}.ovr`).mtimeMs, ovrMtime, '已有的 .ovr 不该被重建');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('接线：金字塔建不起来时，主操作仍然成功，但能查到原因', async () => {
  const dir = tmpDir('ovrwiring');
  try {
    // 磁盘余量按天方量级要求 → 护栏必然拦下。
    // 这是"金字塔建不出来"最现实的一种成因（盘满），而且不依赖任何 mock。
    const { tif, editor } = await makeEditor(dir, { overviewMinFreeBytes: 2 ** 62 });

    const res = await editor.paint({
      target: 'edit.tif',
      region: PAINT_REGION,
      color: '#FF0000',
    });

    assert.equal(res.verified, true, '金字塔建不出来不能让改图变成失败');
    assert.equal(existsSync(`${tif}.ovr`), false, '没建出来就不该有 .ovr');
    assert.equal(res.overview?.built, false);
    assert.ok(res.overview?.error, '必须能查到失败原因（不能静默吞掉）');
    assert.match(res.overview.error, /磁盘/, '失败原因要说清是磁盘不够');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('接线：gdaladdo 本身失败时不抛错，原因写进结果', async () => {
  const dir = tmpDir('ovrwiring');
  try {
    // 不是栅格的 .tif：gdaladdo 打不开
    const bad = join(dir, 'bad.tif');
    writeFileSync(bad, 'this is definitely not a raster');

    const outcome = await ensureRasterOverviews(loc, bad, { thresholdBytes: 1 });

    assert.equal(outcome.built, false);
    assert.equal(outcome.ovrPath, null);
    assert.ok(outcome.error, '必须带上失败原因');
    assert.match(outcome.error, /构建金字塔失败/, '原因要能看出是建金字塔失败');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
