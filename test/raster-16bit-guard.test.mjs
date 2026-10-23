/**
 * 16 位影像的**两条底线**。
 *
 * 16 位读写的内核已经上线（`src/engine/raster/pixels.ts`），
 * 所以这个文件锁住两件事：
 *
 *   1. **16 位保值**：UInt16 影像读出来逐个像元与写入时相等，写回去也逐个相等。
 *      曾经的缺陷是 `gdal_translate -ot Byte` 把 0–65535 **饱和**到 0–255 ——
 *      高位数据整段丢失，而文件照样"改成功"，用户拿到的是一张被毁掉的图。
 *      饱和是静默的（退出码 0、stderr 空，实测 GDAL 3.13.3），只能靠断言钉住。
 *   2. **不支持的类型明确拒绝**：Int16 / Int32 / Float32 这类源必须报错，
 *      而且不能给出"请先转成 8 位"这种指引 ——
 *      16 位已经能用了，再劝用户把 16 位降成 8 位，
 *      等于亲手制造我们要消灭的那种数据损坏。
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

/** ENVI 的 `data type` 编号 → 每个样点几个字节 */
const BYTES_PER_DATA_TYPE = { 1: 1, 4: 4, 12: 2 };

/**
 * 造一张 16×12 的单波段影像（构造数据）。
 *
 * dataType：1 = Byte、4 = Float32、12 = UInt16（ENVI 的数据类型编号）。
 * 像元值按公式生成；UInt16 时高位必须真的存在，
 * 否则"压成 8 位"这件事根本测不出来。
 */
async function makeRaster(dir, name, dataType) {
  const w = 16, h = 12;
  const bytesPerSample = BYTES_PER_DATA_TYPE[dataType];
  const bytes = new Uint8Array(w * h * bytesPerSample);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dataType === 12) {
        view.setUint16(i * 2, (x * 4097 + y * 997) % 65536, true);
      } else if (dataType === 4) {
        view.setFloat32(i * 4, i + 0.5, true);
      } else {
        bytes[i] = (x * 7 + y * 3) % 256;
      }
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
  const ot = dataType === 12 ? 'UInt16' : (dataType === 4 ? 'Float32' : 'Byte');
  const tif = join(dir, `${name}.tif`);
  await gdal.translate(['-of', 'GTiff', '-ot', ot, bin, tif]);
  return tif;
}

/** 目录里的文件清单（用来证明"读/写失败时不留下产出"） */
async function filesOf(dir) {
  return (await readdir(dir)).sort();
}

/* ── 1. 16 位读：逐个保值 ──────────────────────────────── */

test('16 位影像：读出来逐个保值，高位没丢，源文件一个字节都没动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-u16-'));
  try {
    const tif = await makeRaster(dir, 'u16', 12);
    const before = await readFile(tif);
    const filesBefore = await filesOf(dir);

    const px = await readRasterPixels(loc, tif);

    assert.equal(px.pixelType, 'UInt16', '读侧必须报出源的类型');
    assert.ok(px.bands[0] instanceof Uint16Array, '16 位源必须读成 Uint16Array');
    assert.equal(px.bands[0].length, 16 * 12);

    // 逐个像元与构造时写入的值完全相等（高位不能丢）
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 16; x++) {
        const i = y * 16 + x;
        assert.equal(
          px.bands[0][i],
          (x * 4097 + y * 997) % 65536,
          `像元 (${x},${y}) 的值被改动了`,
        );
      }
    }

    // 高位（> 32767）必须真的出现过 —— 否则这条用例证明不了"没被压成 8 位"
    const hasHighBit = [...px.bands[0]].some((v) => v > 32767);
    assert.ok(hasHighBit, '夹具里必须存在高于 32767 的像元，高位才真的被测到了');

    // 源文件与目录都不许被动过
    assert.deepEqual(await readFile(tif), before, '源文件必须一个字节都不动');
    assert.deepEqual(await filesOf(dir), filesBefore, '不该在源目录里留下任何产出');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── 2. 16 位写回：往返无损 ────────────────────────────── */

test('16 位影像：写回去再读，逐个像元仍然相等（类型也没丢成 Byte）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-u16-w-'));
  try {
    const tif = await makeRaster(dir, 'u16', 12);
    const px = await readRasterPixels(loc, tif);

    const out = join(dir, 'out.tif');
    await writeRasterPixels(loc, out, {
      width: px.width,
      height: px.height,
      bands: px.bands,
      // 类型与颜色解释都按原图带过来：写回链路要按原类型落盘
      pixelType: px.pixelType,
      colorInterpretation: px.colorInterpretation,
      geotransform: px.geotransform,
      crs: px.crs,
    });

    const again = await readRasterPixels(loc, out);
    assert.equal(again.pixelType, 'UInt16', '写出去的 16 位必须还是 16 位');
    assert.ok(again.bands[0] instanceof Uint16Array, '16 位必须读成 Uint16Array');
    assert.deepEqual(
      [...again.bands[0]],
      [...px.bands[0]],
      '往返后每个像元都必须与改动前完全相等',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── 3. 真正不支持的类型：明确报错 ─────────────────────── */

test('不支持的类型（Float32）：明确报错、带上类型名，且不再劝人转成 8 位', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-f32-'));
  try {
    const tif = await makeRaster(dir, 'f32', 4);
    const before = await readFile(tif);
    const filesBefore = await filesOf(dir);

    await assert.rejects(
      () => readRasterPixels(loc, tif),
      (err) => {
        assert.match(err.message, /Float32/, '报错要说清源的类型');
        assert.match(err.message, /只支持/, '报错要点明支持范围');
        // 16 位已经能用了，再劝人转成 8 位就是在制造数据损坏
        assert.doesNotMatch(
          err.message,
          /转成\s*8\s*位|转成 8 位（Byte）|先转成 8 位/,
          '不能再给出"请先转成 8 位"这种已经不成立的指引',
        );
        assert.doesNotMatch(
          err.message,
          /-ot\s+Byte/,
          '不能再给出 -ot Byte 的命令（那正是静默饱和的来源）',
        );
        return true;
      },
    );

    // 失败路径不许动源文件，也不许留下产出
    assert.deepEqual(await readFile(tif), before, '源文件必须一个字节都不动');
    assert.deepEqual(await filesOf(dir), filesBefore, '不该留下任何产出');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── 4. 8 位路径照常（别把正常路径修坏） ─────────────────── */

test('8 位影像：照常读（别把正常路径修坏）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-u8-'));
  try {
    const tif = await makeRaster(dir, 'u8', 1);
    const px = await readRasterPixels(loc, tif);
    assert.equal(px.width, 16);
    assert.equal(px.height, 12);
    assert.equal(px.bandCount, 1);
    assert.equal(px.pixelType, 'Byte');
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
      pixelType: px.pixelType,
      colorInterpretation: px.colorInterpretation,
      geotransform: px.geotransform,
      crs: px.crs,
    });
    const again = await readRasterPixels(loc, out);
    assert.equal(again.width, px.width);
    assert.equal(again.height, px.height);
    assert.equal(again.pixelType, 'Byte');
    assert.deepEqual([...again.bands[0]], [...px.bands[0]], '写回后像元必须一模一样');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
