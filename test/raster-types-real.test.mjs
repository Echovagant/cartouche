/**
 * 真实高程数据的类型保真（Int32 / Float32）。
 *
 * 为什么要有这一组：这一行支持的不只是 8/16 位影像 —— SRTM 那类高程数据是
 * **Int32**（AAIGrid / Erdas Imagine 都是），投影到 Web Mercator 之后常见
 * **Float32**。引擎原先只认 Byte 与 UInt16，于是这些数据**一条栅格 op 都跑不了**
 * （整类被 REJECT），用户拿到的是"工具不支持我的数据"，而不是"数据被改坏了"。
 *
 * 这组用例跑的是**真实数据**（SRTM 39_04 及其投影版）：
 *   - Int32：AAIGrid（.asc）与 Erdas Imagine（.img）
 *   - Float32：Web Mercator 的 GeoTIFF
 *
 * 样本不进仓库（SRTM 有 180 MB），所以用环境变量 `CARTOUCHE_SAMPLES_DIR`
 * 指向样本目录；没给就整组跳过 —— 不能让 CI 因为"本机没有这份大数据"而红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { executePlan } = await import(eng('ops/index.ts'));
const { readRasterPixels, writeRasterPixels } = await import(eng('raster/index.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

/** 真实样本目录（不在仓库里，用环境变量指过来） */
const SAMPLES = process.env.CARTOUCHE_SAMPLES_DIR ?? '';
const REL_ASC = join('srtm-ascii', 'srtm_ascii', 'srtm_39_04.asc');
const REL_IMG = join('srtm-img-hfa', 'srtm_39_04.img');
const REL_TIF = join('srtm-webmercator-float32', 'srtm_39_04_3857.tif');

const haveSamples =
  SAMPLES !== '' &&
  existsSync(join(SAMPLES, REL_ASC)) &&
  existsSync(join(SAMPLES, REL_IMG)) &&
  existsSync(join(SAMPLES, REL_TIF));

const skip = haveSamples
  ? false
  : '需要真实样本：设置 CARTOUCHE_SAMPLES_DIR 指向样本目录（本组用例会整组跳过）';

/** 工作区（临时目录）：改图都在这里发生，原始样本一个字节都不动 */
function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-real-'));
  return { dir, store: new LocalFolderStore(dir) };
}

/** 从真实样本里裁一小块出来（6000×6000 整读太慢，裁块足够验证类型链路） */
async function cropOf(srcAbs, outAbs, { x = 3000, y = 3000, w = 64, h = 64, srs = null } = {}) {
  const args = ['-of', 'GTiff', '-srcwin', String(x), String(y), String(w), String(h)];
  if (srs) args.push('-a_srs', srs);
  args.push(srcAbs, outAbs);
  const res = await gdal.translate(args);
  assert.ok(res.ok, `裁剪样本失败：${res.stderr}`);
  return outAbs;
}

/** gdalinfo 报的波段类型 */
async function bandTypeOf(abs) {
  const res = await gdal.info(abs, ['-json']);
  assert.ok(res.ok, `gdalinfo 失败：${res.stderr}`);
  return JSON.parse(res.stdout).bands[0].type;
}

/**
 * 用 GDAL 自己的工具（gdallocationinfo）读一个像元的值。
 *
 * 为什么要绕开引擎自己的读回：引擎读回来再读回去，只能证明"两次读一致"，
 * 证明不了"读对了"。gdallocationinfo 是另一条独立的取值路径，
 * 两者对得上，才说明数值真的没被改动。
 */
async function locateValue(abs, col, row) {
  const { execFileSync } = await import('node:child_process');
  const bin = loc.binDir;
  const exe = join(bin, `gdallocationinfo${loc.exeSuffix}`);
  const out = execFileSync(exe, ['-valonly', abs, String(col), String(row)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin};${process.env.PATH ?? ''}` },
  });
  return Number(out.trim().split(/\s+/)[0]);
}

/* ───────────────────────────── 打开与体检 ───────────────────────────── */

test('dataset.open：Int32 / Float32 的真实高程影像认得出类型、尺寸与 nodata', { skip }, async () => {
  const store = new LocalFolderStore(SAMPLES);
  const res = await executePlan({ loc, store }, {
    version: '1.0',
    ops: [{ op: 'dataset.open', params: { targets: [REL_ASC, REL_IMG, REL_TIF] } }],
  });
  assert.equal(res.results.length, 1);
  const rec = res.results[0];
  assert.equal(rec.ok, true, `dataset.open 应当成功：${rec.error ?? ''}`);

  const datasets = rec.value.data.datasets;
  assert.equal(datasets.length, 3);
  const byName = Object.fromEntries(datasets.map((d) => [d.path.replace(/\\/g, '/'), d]));

  const asc = byName[REL_ASC.replace(/\\/g, '/')];
  assert.equal(asc.bandTypes[0], 'Int32', 'AAIGrid 的波段类型必须被认出来');
  assert.equal(asc.width, 6000);
  assert.equal(asc.height, 6000);
  assert.equal(asc.nodata, -9999, 'nodata 必须原样带出来');

  const img = byName[REL_IMG.replace(/\\/g, '/')];
  assert.equal(img.bandTypes[0], 'Int32', 'Erdas Imagine 的波段类型必须被认出来');
  assert.equal(img.width, 6000);

  const tif = byName[REL_TIF.replace(/\\/g, '/')];
  assert.equal(tif.bandTypes[0], 'Float32', 'Web Mercator 浮点影像的类型必须被认出来');
  assert.equal(tif.nodata, -9999);
});

test('dataset.healthCheck：32 位与浮点影像不会因为"类型不认识"而误报', { skip }, async () => {
  const store = new LocalFolderStore(SAMPLES);
  const res = await executePlan({ loc, store }, {
    version: '1.0',
    ops: [{
      op: 'dataset.healthCheck',
      params: {
        target: REL_TIF,
        checks: ['crs-present', 'crs-range-sanity', 'axis-order', 'extent-plausibility'],
      },
    }],
  });
  const rec = res.results[0];
  assert.equal(rec.ok, true, `dataset.healthCheck 应当成功：${rec.error ?? ''}`);
  const text = JSON.stringify(rec.value.data ?? {});
  // 体检结论里不该出现"类型不支持 / 位深不对"这类误报
  assert.doesNotMatch(text, /不支持的像素类型|位深|降到 8 位|降位/, '体检不该对 32 位/浮点影像误报类型问题');
});

/* ───────────────────────────── 改图与写回 ───────────────────────────── */

test('raster.adjustLevels：Int32 高程影像改完写回仍是 Int32，数值没有失真', { skip }, async () => {
  const { dir, store } = makeWorkspace();
  try {
    const src = join(SAMPLES, REL_ASC);
    const tif = await cropOf(src, join(dir, 'srtm-int32.tif'), { srs: 'EPSG:4326' });
    assert.equal(await bandTypeOf(tif), 'Int32', '裁出来的块必须仍是 Int32');

    // 改动前的几个已知像元值（用 GDAL 自己的工具读，独立于引擎）
    const before = [];
    for (const [col, row] of [[10, 10], [20, 30], [40, 50]]) {
      before.push(await locateValue(tif, col, row));
    }
    assert.ok(
      before.some((v) => v !== -9999 && v > 0),
      `样本里应当有真实高程值，实际取到 ${JSON.stringify(before)}`,
    );

    const res = await executePlan({ loc, store }, {
      version: '1.0',
      ops: [{
        op: 'raster.adjustLevels',
        params: { target: 'srtm-int32.tif', method: 'gamma', gamma: 2.2 },
      }],
    });
    assert.equal(res.results[0].ok, true, `adjustLevels 应当成功：${res.results[0].error ?? ''}`);

    // 写回后的类型：必须仍是 Int32（不许静默降成 Byte）
    assert.equal(await bandTypeOf(tif), 'Int32', '写回后必须仍是 Int32');

    const px = await readRasterPixels(loc, tif);
    assert.equal(px.pixelType, 'Int32');
    assert.ok(px.bands[0] instanceof Int32Array, 'Int32 必须读成 Int32Array');

    // 抽样值：仍然是高程量级，不能变成 0 / 255 / 截断值
    const after = [];
    for (const [col, row] of [[10, 10], [20, 30], [40, 50]]) {
      after.push(await locateValue(tif, col, row));
    }
    for (const v of after) {
      assert.notEqual(v, 0, '高程不能被抹成 0');
      assert.notEqual(v, 255, '高程不能被压成 255');
      assert.ok(Math.abs(v) < 100000, `高程不该变成天文数字：${v}`);
    }
    assert.notDeepEqual(after, before, 'gamma 校正应当真的改了像元');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('raster.resample：Float32 影像重采样后仍是 Float32', { skip }, async () => {
  const { dir, store } = makeWorkspace();
  try {
    const src = join(SAMPLES, REL_TIF);
    const tif = await cropOf(src, join(dir, 'srtm-f32.tif'));
    assert.equal(await bandTypeOf(tif), 'Float32', '裁出来的块必须仍是 Float32');

    const res = await executePlan({ loc, store }, {
      version: '1.0',
      ops: [{
        op: 'raster.resample',
        params: { target: 'srtm-f32.tif', targetResolution: 200, resampleMethod: 'nearest' },
      }],
    });
    assert.equal(res.results[0].ok, true, `resample 应当成功：${res.results[0].error ?? ''}`);

    assert.equal(await bandTypeOf(tif), 'Float32', '重采样后必须仍是 Float32');
    const px = await readRasterPixels(loc, tif);
    assert.equal(px.pixelType, 'Float32');
    assert.ok(px.bands[0] instanceof Float32Array);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('往返保真：真实 Int32 / Float32 样本读进来写回去，逐个像元都相等', { skip }, async () => {
  const { dir } = makeWorkspace();
  try {
    const cases = [
      { src: join(SAMPLES, REL_ASC), out: join(dir, 'i32.tif'), srs: 'EPSG:4326', type: 'Int32' },
      { src: join(SAMPLES, REL_IMG), out: join(dir, 'i32-img.tif'), srs: 'EPSG:4326', type: 'Int32' },
      { src: join(SAMPLES, REL_TIF), out: join(dir, 'f32.tif'), srs: null, type: 'Float32' },
    ];
    for (const c of cases) {
      const tif = await cropOf(c.src, c.out, { srs: c.srs });
      const px = await readRasterPixels(loc, tif);
      assert.equal(px.pixelType, c.type, `${c.type} 的源必须被认出来`);

      const out2 = join(dir, `rt-${c.type}.tif`);
      await writeRasterPixels(loc, out2, {
        width: px.width,
        height: px.height,
        bands: px.bands,
        pixelType: px.pixelType,
        colorInterpretation: px.colorInterpretation,
        geotransform: px.geotransform,
        crs: px.crs,
      });
      assert.equal(await bandTypeOf(out2), c.type, `写回后必须仍是 ${c.type}`);
      const again = await readRasterPixels(loc, out2);
      assert.deepEqual([...again.bands[0]], [...px.bands[0]], `${c.type} 往返后逐个像元都必须相等`);

      // 再用 GDAL 自己的工具核对一个像元：两条独立路径对得上才算真的没动
      const v1 = await locateValue(tif, 33, 33);
      const v2 = await locateValue(out2, 33, 33);
      assert.equal(v1, v2, `${c.type} 的像元值必须与原图一致`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
