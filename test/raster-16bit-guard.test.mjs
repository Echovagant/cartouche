/**
 * 16 位影像的**明确拒绝**（而不是无声压成 8 位）。
 *
 * 缺陷（2026-10-23 实测）：`src/engine/raster/raw.ts` 读像素时用
 * `gdal_translate -of ENVI -ot Byte`，`-ot Byte` 会把 0–65535 的值
 * **饱和**到 0–255 —— 高位数据整段丢失，而文件照样"改成功"。
 * 用户拿到的是一张被毁掉的图，却看不到任何异常：这比直接报错难发现得多。
 *
 * 16 位读写的内核还在另一个分支上（按波段分块读，整文件读进内存会被大影像撑爆），
 * 所以这一轮只做**止血**：探测到源不是 8 位就明确报错，并说清怎么办。
 *
 * 本文件里的栅格都是**构造数据**（像元值按公式生成），不对应任何真实数据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { readRasterPixels, writeRasterPixels } = await import(eng('raster/index.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

/**
 * 造一张 16×12 的影像（构造数据）。
 * dataType：1 = Byte，12 = UInt16（ENVI 的数据类型编号）
 */
async function makeRaster(dir, name, dataType) {
  const w = 16, h = 12;
  const twoBytes = dataType === 12;
  const bytes = new Uint8Array(w * h * (twoBytes ? 2 : 1));
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Byte 时存 0..255；UInt16 时存 0..65535（高位必须真的存在，
      // 否则"压成 8 位"这件事根本测不出来）
      const v = twoBytes ? (x * 4097 + y * 997) % 65536 : (x * 7 + y * 3) % 256;
      if (twoBytes) view.setUint16((y * w + x) * 2, v, true);
      else bytes[y * w + x] = v;
    }
  }
  const bin = join(dir, `${name}.bin`);
  const hdr = join(dir, `${name}.hdr`);
  await writeFile(bin, bytes);
  await writeFile(
    hdr,
    [
      'ENVI',
      `samples = ${w}`,
      `lines   = ${h}`,
      'bands   = 1',
      'header offset = 0',
      'file type = ENVI Standard',
      `data type = ${dataType}`,
      'interleave = bsq',
      'byte order = 0',
      '',
    ].join('\n'),
    'utf8',
  );
  const tif = join(dir, `${name}.tif`);
  await gdal.translate(['-of', 'GTiff', '-ot', dataType === 12 ? 'UInt16' : 'Byte', bin, tif]);
  return tif;
}

test('16 位影像：明确报错，且说清类型、后果与怎么办', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-u16-'));
  try {
    const tif = await makeRaster(dir, 'u16', 12);
    const before = await readFile(tif);

    await assert.rejects(
      () => readRasterPixels(loc, tif),
      (err) => {
        assert.match(err.message, /UInt16/, '报错要说清源的类型');
        assert.match(err.message, /8 位|Byte/, '报错要说清当前只支持 8 位');
        assert.match(err.message, /饱和/, '报错要说清会被饱和到 0–255');
        assert.match(err.message, /gdal_translate/, '报错要给出可行的下一步');
        assert.match(
          err.message,
          /-ot\s+Byte/,
          '给出的命令必须指向 8 位（Byte）——内核只支持 8 位，转成 16 位是白转',
        );
        return true;
      },
    );

    // 关键：**一个字节都不许动**，也不许留下任何产出
    assert.deepEqual(await readFile(tif), before, '源文件必须一个字节都不动');
    const produced = (await readdir(dir)).filter((n) => !n.endsWith('.bin') && !n.endsWith('.hdr'));
    assert.deepEqual(produced, ['u16.tif'], '不该产出任何新文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('8 位影像：照常读（别把正常路径修坏）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-u8-'));
  try {
    const tif = await makeRaster(dir, 'u8', 1);
    const px = await readRasterPixels(loc, tif);
    assert.equal(px.width, 16);
    assert.equal(px.height, 12);
    assert.equal(px.bandCount, 1);
    assert.equal(px.bands[0].length, 16 * 12);
    // 像元值没被改过
    assert.equal(px.bands[0][0], 0);
    assert.equal(px.bands[0][1], 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('8 位影像：照常写（GeoTIFF 往返后仿射参数与坐标系还在）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-u8-w-'));
  try {
    const tif = await makeRaster(dir, 'u8', 1);
    const px = await readRasterPixels(loc, tif);
    const out = join(dir, 'out.tif');
    await writeRasterPixels(loc, out, {
      width: px.width,
      height: px.height,
      bands: px.bands,
      geotransform: px.geotransform,
      crs: px.crs,
    });
    const again = await readRasterPixels(loc, out);
    assert.equal(again.width, px.width);
    assert.equal(again.height, px.height);
    assert.deepEqual([...again.bands[0]], [...px.bands[0]], '写回后像元必须一模一样');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
