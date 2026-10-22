import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', 'raster', p)).href;
const srcEng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const {
  BYTES_PER_SAMPLE,
  MAX_SAMPLE,
  newBand,
  readSample,
  writeSample,
  clampSample,
  pixelTypeFromGdal,
  pixelTypeOf,
  decodeSample,
} = await import(eng('pixels.ts'));

test('像素常量：字节宽与取值上限', () => {
  assert.equal(BYTES_PER_SAMPLE.Byte, 1, 'Byte 每个样点 1 字节');
  assert.equal(BYTES_PER_SAMPLE.UInt16, 2, 'UInt16 每个样点 2 字节');
  assert.equal(MAX_SAMPLE.Byte, 255, 'Byte 上限 255');
  assert.equal(MAX_SAMPLE.UInt16, 65535, 'UInt16 上限 65535');
});

test('建带：Byte 出 Uint8Array，UInt16 出 Uint16Array，长度正确', () => {
  const b8 = newBand('Byte', 10);
  assert.ok(b8 instanceof Uint8Array, 'Byte 带必须是 Uint8Array');
  assert.equal(b8.length, 10);

  const b16 = newBand('UInt16', 10);
  assert.ok(b16 instanceof Uint16Array, 'UInt16 带必须是 Uint16Array');
  assert.equal(b16.length, 10);

  // 类型必须一眼能认出来，否则后面写回时不知道该按几字节存
  assert.equal(pixelTypeOf(b8), 'Byte');
  assert.equal(pixelTypeOf(b16), 'UInt16');
});

test('写样点：8 位越界钳到 255，负值钳到 0', () => {
  const band = newBand('Byte', 4);
  writeSample(band, 0, 300, 'Byte');
  assert.equal(readSample(band, 0), 255, '300 应被钳到 255');
  writeSample(band, 1, -5, 'Byte');
  assert.equal(readSample(band, 1), 0, '-5 应被钳到 0');
});

test('写样点：16 位越界钳到 65535，小数四舍五入', () => {
  const band = newBand('UInt16', 4);
  writeSample(band, 0, 70000, 'UInt16');
  assert.equal(readSample(band, 0), 65535, '70000 应被钳到 65535');
  writeSample(band, 1, 12.6, 'UInt16');
  assert.equal(readSample(band, 1), 13, '12.6 应四舍五入成 13');
});

test('读样点：两种类型都读得出数值', () => {
  const b8 = newBand('Byte', 2);
  writeSample(b8, 0, 200, 'Byte');
  assert.equal(readSample(b8, 0), 200);

  const b16 = newBand('UInt16', 2);
  writeSample(b16, 0, 60000, 'UInt16');
  assert.equal(readSample(b16, 0), 60000, '60000 不能在 16 位里丢精度');
});

test('钳位：非有限数归零，其余按类型取整并夹在区间内', () => {
  assert.equal(clampSample(Number.NaN, 'Byte'), 0, 'NaN 不该变成 NaN');
  assert.equal(clampSample(Number.POSITIVE_INFINITY, 'UInt16'), 0);
  assert.equal(clampSample(12.4, 'Byte'), 12);
  assert.equal(clampSample(12.5, 'Byte'), 13);
  assert.equal(clampSample(-0.4, 'Byte'), 0);
});

test('GDAL 类型：Byte / UInt16 认得，其它类型报错且带上原始类型名', () => {
  assert.equal(pixelTypeFromGdal('Byte'), 'Byte');
  assert.equal(pixelTypeFromGdal('UInt16'), 'UInt16');

  for (const bad of ['Int16', 'Float32']) {
    assert.throws(
      () => pixelTypeFromGdal(bad),
      (err) => {
        assert.match(err.message, new RegExp(bad), `错误信息要带上原始类型名 ${bad}`);
        assert.match(err.message, /只支持/, '错误信息要点明支持范围');
        return true;
      },
    );
  }

  assert.throws(
    () => pixelTypeFromGdal(undefined),
    (err) => {
      assert.match(err.message, /undefined/, '类型缺失时也要说得清是什么类型');
      return true;
    },
  );
});

test('解码：1 字节直接取值', () => {
  assert.equal(decodeSample(new Uint8Array([7]), 0, 1, 0), 7);
  assert.equal(decodeSample(new Uint8Array([0, 0, 200]), 2, 1, 0), 200);
});

test('解码：小端低字节在前', () => {
  // 60000 = 0xEA60
  assert.equal(decodeSample(new Uint8Array([0x60, 0xea]), 0, 2, 0), 60000);
});

test('解码：大端高位在前', () => {
  // 60000 = 0xEA60
  assert.equal(decodeSample(new Uint8Array([0xea, 0x60]), 0, 2, 1), 60000);
});

test('解码：offset 真的生效', () => {
  const bytes = new Uint8Array([0x00, 0x00, 0x60, 0xea]);
  assert.equal(decodeSample(bytes, 2, 2, 0), 60000, '应从第 3 个字节开始读');
  assert.equal(decodeSample(bytes, 0, 2, 0), 0, 'offset 必须是起点而不是偏移到别处');
});

/* ────────── 读侧保真：16 位不被静默压成 255 ────────── */

/**
 * ENVI 头 `data type` 编号 → 样点字节的写法。
 * 1 = Byte、4 = Float32、12 = UInt16。
 */
const ENVI_SAMPLE_ENCODERS = {
  1: (v) => [v & 0xff],
  4: (v) => {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    return [...b];
  },
  12: (v, byteOrder) => {
    const b = Buffer.alloc(2);
    if (byteOrder === 1) b.writeUInt16BE(v);
    else b.writeUInt16LE(v);
    return [...b];
  },
};

/**
 * 按 ENVI 的交错方式把各波段的样点排成裸字节流。
 *
 * 三种排布（bsq / bip / bil）的样点值完全一样，差别只在字节顺序 ——
 * 所以读回来必须是同一组值，差一点就说明偏移算法错了。
 */
function enviBytes({ width, height, bandCount, bandValues, dataType, interleave, byteOrder = 0 }) {
  const encode = ENVI_SAMPLE_ENCODERS[dataType];
  if (!encode) throw new Error(`夹具不支持的 data type ${dataType}`);
  const bytes = [];
  const push = (v) => {
    for (const byte of encode(v, byteOrder)) bytes.push(byte);
  };
  const at = (b, i) => bandValues[b][i];

  if (interleave === 'bsq') {
    // 波段顺序：一个波段一整段
    for (let b = 0; b < bandCount; b++) for (let i = 0; i < width * height; i++) push(at(b, i));
  } else if (interleave === 'bip') {
    // 像元交错：同一像元的各波段相邻
    for (let i = 0; i < width * height; i++) for (let b = 0; b < bandCount; b++) push(at(b, i));
  } else if (interleave === 'bil') {
    // 行交错：每行内部像元交错，行与行整段分开
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let b = 0; b < bandCount; b++) push(at(b, y * width + x));
      }
    }
  } else {
    throw new Error(`夹具不支持的 interleave ${interleave}`);
  }
  return Buffer.from(bytes);
}

/**
 * ENVI 头文本。
 *
 * map info 的前两个数是**1 基**的参考像元号，后面两个是参考像元的地图坐标；
 * 写成 (0, height) 之后，GDAL 读进来的原点正好落在 (0, height)、像元 1x1。
 */
function enviHeaderText({ width, height, bandCount, dataType, interleave, byteOrder = 0 }) {
  return [
    'ENVI',
    `samples = ${width}`,
    `lines = ${height}`,
    `bands = ${bandCount}`,
    'header offset = 0',
    'file type = ENVI Standard',
    `data type = ${dataType}`,
    `interleave = ${interleave}`,
    `byte order = ${byteOrder}`,
    `map info = {Geographic Lat/Lon, 1.0, 1.0, 0.0, ${height}.0, 1.0, 1.0, units=degrees}`,
    '',
  ].join('\n');
}

/**
 * 造一张指定类型、指定取值的栅格：手搓 ENVI，再让 GDAL 转成 GTiff。
 *
 * 绕 ENVI 造的原因：gdal_create 造不出带特定取值的 UInt16 影像，
 * 而手搓 ENVI 能同时控制**样点值、字节序、交错方式** —— 正好是读侧要覆盖的三件事。
 */
async function makeRaster(loc, file, opts) {
  const { width, height, bandCount } = opts;
  const img = file.replace(/\.tif$/, '.img');
  const hdr = file.replace(/\.tif$/, '.hdr');
  writeFileSync(img, enviBytes(opts));
  writeFileSync(hdr, enviHeaderText(opts), 'latin1');

  const { tools } = await import(srcEng('gdal/runner.ts'));
  const gdal = tools(loc);
  const res = await gdal.translate(['-of', 'GTiff', img, file]);
  assert.ok(res.ok, `夹具造图失败：${res.stderr}`);
  return file;
}

/** 载入 GDAL 位置与被测的读侧 API */
async function loadRaw() {
  const { resolveGdal } = await import(srcEng('gdal/env.ts'));
  const loc = resolveGdal();
  assert.ok(loc, '本机需装好 GDAL');
  const { readRasterPixels, readRasterWindow, readEnviBands, checksumOf, writeRasterPixels } =
    await import(eng('raw.ts'));
  return { loc, readRasterPixels, readRasterWindow, readEnviBands, checksumOf, writeRasterPixels };
}

/**
 * 读 gdalinfo -json 里的波段类型与颜色解释。
 *
 * 走 tools(loc).info 而不是自己拼命令行：可执行文件后缀随平台走
 * （Windows 是 .exe，Linux 没有），写死 .exe 的测试在 CI 的 ubuntu-latest 上会找不到命令。
 */
async function bandInfo(loc, file) {
  const { tools } = await import(srcEng('gdal/runner.ts'));
  const res = await tools(loc).info(file, ['-json']);
  assert.ok(res.ok, `gdalinfo 失败：${res.stderr}`);
  const info = JSON.parse(res.stdout);
  return info.bands.map((b) => ({ type: b.type, colorInterpretation: b.colorInterpretation }));
}

test('读 16 位：像素值逐个保真，不被静默压成 255', async () => {
  const { loc, readRasterPixels } = await loadRaw();
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-px16-'));
  try {
    const tif = join(dir, 'u16.tif');
    const values = [60000, 60001, 60002, 60003, 60004, 60005];
    await makeRaster(loc, tif, {
      width: 3, height: 2, bandCount: 1,
      bandValues: [values], dataType: 12, interleave: 'bsq',
    });

    const px = await readRasterPixels(loc, tif);
    assert.equal(px.pixelType, 'UInt16', '读侧必须报出源的类型');
    assert.ok(px.bands[0] instanceof Uint16Array, '16 位源必须读成 Uint16Array');
    assert.deepEqual([...px.bands[0]], values, '60000 不能被压成 255');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('读 8 位：类型与取值与改动前一致', async () => {
  const { loc, readRasterPixels } = await loadRaw();
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-px8-'));
  try {
    const tif = join(dir, 'u8.tif');
    const values = [10, 20, 30, 40, 50, 60];
    await makeRaster(loc, tif, {
      width: 3, height: 2, bandCount: 1,
      bandValues: [values], dataType: 1, interleave: 'bsq',
    });

    const px = await readRasterPixels(loc, tif);
    assert.equal(px.pixelType, 'Byte');
    assert.ok(px.bands[0] instanceof Uint8Array, '8 位源必须读成 Uint8Array');
    assert.deepEqual([...px.bands[0]], values);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('校验和：8 位与改动前的算法一致，16 位按字节流算', async () => {
  const { loc, readRasterPixels, checksumOf } = await loadRaw();
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-pxck-'));
  try {
    const tif = join(dir, 'u8.tif');
    const values = [10, 20, 30, 40, 50, 60];
    await makeRaster(loc, tif, {
      width: 3, height: 2, bandCount: 1,
      bandValues: [values], dataType: 1, interleave: 'bsq',
    });

    const px = await readRasterPixels(loc, tif);
    const band = px.bands[0];
    // 改动前的算法：直接把整条带 update 进哈希。8 位路径必须得到同一个值
    const legacy = createHash('sha256').update(band).digest('hex');
    assert.equal(px.checksum, legacy, '8 位校验和不能变');
    assert.equal(
      px.checksum,
      createHash('sha256').update(Buffer.from(band.buffer, band.byteOffset, band.byteLength)).digest('hex'),
    );
    assert.equal(checksumOf(px.bands), px.checksum, 'checksumOf 与读回来的值必须一致');
    // 固定常量：字节序或拼接方式一变就必然对不上
    assert.equal(px.checksum, '6e6db0c1e9357a0f1543a26d526d8548ae9867a4a64de41c2752e13f77bcfa13');

    // 16 位：按字节流算，绝不能按元素截断后算
    const tif16 = join(dir, 'u16.tif');
    const v16 = [60000, 60001, 60002, 60003, 60004, 60005];
    await makeRaster(loc, tif16, {
      width: 3, height: 2, bandCount: 1,
      bandValues: [v16], dataType: 12, interleave: 'bsq',
    });
    const px16 = await readRasterPixels(loc, tif16);
    const b16 = px16.bands[0];
    assert.equal(
      px16.checksum,
      createHash('sha256').update(Buffer.from(b16.buffer, b16.byteOffset, b16.byteLength)).digest('hex'),
      '16 位必须按字节流算',
    );
    // 固定常量：60000..60005 的小端字节流。读侧一旦饱和成 255，这个值必然对不上
    assert.equal(px16.checksum, '574e6b9c283fa2bba9c3e20e95503ef3e98f9f6dc213f415e41b8bdbae50694b');
    assert.notEqual(
      px16.checksum,
      createHash('sha256').update(Buffer.from(v16.map((v) => v & 0xff))).digest('hex'),
      '不能按元素截断成 8 位后算',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('窗口读 16 位：值保真且带回 pixelType', async () => {
  const { loc, readRasterWindow } = await loadRaw();
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-pxwin-'));
  try {
    const tif = join(dir, 'u16.tif');
    const values = [60000, 60001, 60002, 60003, 60004, 60005];
    await makeRaster(loc, tif, {
      width: 3, height: 2, bandCount: 1,
      bandValues: [values], dataType: 12, interleave: 'bsq',
    });

    // 窗口取整图的 (1,0)-(2,1)：值分别是 60001、60002、60004、60005
    const px = await readRasterWindow(loc, tif, { x: 1, y: 0, w: 2, h: 2 });
    assert.equal(px.pixelType, 'UInt16');
    assert.ok(px.bands[0] instanceof Uint16Array, '窗口读 16 位也必须保真');
    assert.deepEqual([...px.bands[0]], [60001, 60002, 60004, 60005]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('不支持的类型：报错并带上类型名，不静默当 Byte 处理', async () => {
  const { loc, readRasterPixels, readEnviBands } = await loadRaw();
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-pxbad-'));
  try {
    // gdalinfo 侧：Float32 源在读之前就该被拦下
    const tif = join(dir, 'f32.tif');
    const values = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5];
    await makeRaster(loc, tif, {
      width: 3, height: 2, bandCount: 1,
      bandValues: [values], dataType: 4, interleave: 'bsq',
    });
    await assert.rejects(
      () => readRasterPixels(loc, tif),
      (err) => {
        assert.match(err.message, /Float32/, '错误信息要带上原始类型名');
        return true;
      },
    );

    // ENVI 头侧：data type = 4 同样不能被默默当 Byte
    const img = join(dir, 'raw.bin');
    writeFileSync(img, enviBytes({
      width: 3, height: 2, bandCount: 1,
      bandValues: [values], dataType: 4, interleave: 'bsq',
    }));
    writeFileSync(
      join(dir, 'raw.hdr'),
      enviHeaderText({ width: 3, height: 2, bandCount: 1, dataType: 4, interleave: 'bsq' }),
      'latin1',
    );
    assert.throws(
      () => readEnviBands(img, 3, 2, 1),
      (err) => {
        assert.match(err.message, /Float32/, '错误信息要带上原始类型名');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ENVI 交错：bsq / bip / bil 三种排布读回来是同一组值', async () => {
  const { readEnviBands } = await loadRaw();
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-pxil-'));
  try {
    const bandValues = [[100, 101, 102, 103], [200, 201, 202, 203]];
    for (const interleave of ['bsq', 'bip', 'bil']) {
      const img = join(dir, `${interleave}.bin`);
      writeFileSync(img, enviBytes({
        width: 2, height: 2, bandCount: 2, bandValues, dataType: 1, interleave,
      }));
      writeFileSync(
        join(dir, `${interleave}.hdr`),
        enviHeaderText({ width: 2, height: 2, bandCount: 2, dataType: 1, interleave }),
        'latin1',
      );
      const bands = readEnviBands(img, 2, 2, 2);
      assert.deepEqual([...bands[0]], [100, 101, 102, 103], `${interleave} 的第 0 波段读错`);
      assert.deepEqual([...bands[1]], [200, 201, 202, 203], `${interleave} 的第 1 波段读错`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ENVI 字节序：大端（byte order = 1）与小端读出同一个值', async () => {
  const { readEnviBands } = await loadRaw();
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-pxbo-'));
  try {
    const values = [60000, 60001, 60002, 60003];
    for (const byteOrder of [0, 1]) {
      const img = join(dir, `bo${byteOrder}.bin`);
      writeFileSync(img, enviBytes({
        width: 2, height: 2, bandCount: 1, bandValues: [values], dataType: 12, interleave: 'bsq', byteOrder,
      }));
      writeFileSync(
        join(dir, `bo${byteOrder}.hdr`),
        enviHeaderText({ width: 2, height: 2, bandCount: 1, dataType: 12, interleave: 'bsq', byteOrder }),
        'latin1',
      );
      const bands = readEnviBands(img, 2, 2, 1);
      assert.deepEqual([...bands[0]], values, `byte order = ${byteOrder} 读出的值不对`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ────────── 写侧保真：16 位写回去还是 16 位，颜色解释也保住 ────────── */

/** 写回用的仿射参数：北向上、像元 1x1 */
const GT = [0, 1, 0, 2, 0, -1];

test('写 16 位：往返逐个相等，类型不丢成 Byte', async () => {
  const { loc, readRasterPixels, writeRasterPixels } = await loadRaw();
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-w16-'));
  try {
    const tif = join(dir, 'u16.tif');
    const values = [60000, 60001, 60002, 60003, 60004, 60005];
    await writeRasterPixels(loc, tif, {
      width: 3,
      height: 2,
      bands: [Uint16Array.from(values)],
      pixelType: 'UInt16',
      geotransform: GT,
      crs: null,
    });

    const px = await readRasterPixels(loc, tif);
    assert.equal(px.pixelType, 'UInt16', '写出去的 16 位必须还是 16 位');
    assert.ok(px.bands[0] instanceof Uint16Array, '16 位必须读成 Uint16Array');
    assert.deepEqual([...px.bands[0]], values, '60000 不能在写回时被压成 255');

    const bands = await bandInfo(loc, tif);
    assert.equal(bands[0].type, 'UInt16', 'gdalinfo 必须报 UInt16');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写 8 位：往返的校验和与改动前的算法一致', async () => {
  const { loc, readRasterPixels, writeRasterPixels } = await loadRaw();
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-w8-'));
  try {
    const tif = join(dir, 'u8.tif');
    const band = Uint8Array.from([10, 20, 30, 40, 50, 60]);
    await writeRasterPixels(loc, tif, {
      width: 3,
      height: 2,
      bands: [band],
      pixelType: 'Byte',
      geotransform: GT,
      crs: null,
    });

    const px = await readRasterPixels(loc, tif);
    assert.equal(px.pixelType, 'Byte');
    // 改动前的算法：整条带直接进哈希。8 位路径必须得到同一个值
    const legacy = createHash('sha256').update(band).digest('hex');
    assert.equal(px.checksum, legacy, '8 位路径的校验和不能变');
    assert.deepEqual([...px.bands[0]], [...band], '8 位的值也不能变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写回：类型标签与实际像素带不一致时报错', async () => {
  const { loc, writeRasterPixels } = await loadRaw();
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-wmis-'));
  try {
    const tif = join(dir, 'bad.tif');
    await assert.rejects(
      () => writeRasterPixels(loc, tif, {
        width: 2,
        height: 1,
        // 声明 16 位，实际给的是 8 位带：按 2 字节宽度写出去就是错位的数据
        bands: [new Uint8Array([1, 2])],
        pixelType: 'UInt16',
        geotransform: GT,
        crs: null,
      }),
      (err) => {
        assert.match(err.message, /UInt16/, '错误信息要带上声明的类型');
        assert.match(err.message, /Byte/, '错误信息要带上实际拿到的类型');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写回：3 波段的颜色解释保住 Red/Green/Blue', async () => {
  const { loc, writeRasterPixels } = await loadRaw();
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-wci-'));
  try {
    const tif = join(dir, 'rgb.tif');
    await writeRasterPixels(loc, tif, {
      width: 2,
      height: 2,
      bands: [
        Uint8Array.from([10, 11, 12, 13]),
        Uint8Array.from([20, 21, 22, 23]),
        Uint8Array.from([30, 31, 32, 33]),
      ],
      pixelType: 'Byte',
      colorInterpretation: ['Red', 'Green', 'Blue'],
      geotransform: GT,
      crs: null,
    });

    const bands = await bandInfo(loc, tif);
    assert.deepEqual(
      bands.map((b) => b.colorInterpretation),
      ['Red', 'Green', 'Blue'],
      'ENVI 中转不带颜色解释，不显式给就会丢成 Undefined',
    );

    // 缺省时按波段数猜：3 波段 → rgb
    const tif2 = join(dir, 'rgb-default.tif');
    await writeRasterPixels(loc, tif2, {
      width: 2,
      height: 2,
      bands: [
        Uint8Array.from([10, 11, 12, 13]),
        Uint8Array.from([20, 21, 22, 23]),
        Uint8Array.from([30, 31, 32, 33]),
      ],
      pixelType: 'Byte',
      geotransform: GT,
      crs: null,
    });
    const bands2 = await bandInfo(loc, tif2);
    assert.deepEqual(
      bands2.map((b) => b.colorInterpretation),
      ['Red', 'Green', 'Blue'],
      '缺省时 3 波段必须猜成 rgb',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写回：单波段的颜色解释是 Gray 而不是 Undefined', async () => {
  const { loc, writeRasterPixels } = await loadRaw();
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-wgray-'));
  try {
    const tif = join(dir, 'gray.tif');
    await writeRasterPixels(loc, tif, {
      width: 2,
      height: 2,
      bands: [Uint8Array.from([1, 2, 3, 4])],
      pixelType: 'Byte',
      geotransform: GT,
      crs: null,
    });

    const bands = await bandInfo(loc, tif);
    assert.equal(bands[0].colorInterpretation, 'Gray', '单波段必须显式给 gray');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写回：颜色解释拼错或对不上时报错，不默默按默认猜', async () => {
  const { loc, writeRasterPixels } = await loadRaw();
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-wci-bad-'));
  try {
    const tif = join(dir, 'bad.tif');
    // 名字不认识
    await assert.rejects(
      () => writeRasterPixels(loc, tif, {
        width: 2,
        height: 2,
        bands: [Uint8Array.from([1, 2, 3, 4])],
        pixelType: 'Byte',
        colorInterpretation: ['Reddish'],
        geotransform: GT,
        crs: null,
      }),
      (err) => {
        assert.match(err.message, /Reddish/, '错误信息要带上拼错的那个名字');
        return true;
      },
    );

    // 个数与波段数对不上：默默按默认猜等于把调用方的意图丢掉
    await assert.rejects(
      () => writeRasterPixels(loc, tif, {
        width: 2,
        height: 2,
        bands: [Uint8Array.from([1, 2, 3, 4])],
        pixelType: 'Byte',
        colorInterpretation: ['Red', 'Green', 'Blue'],
        geotransform: GT,
        crs: null,
      }),
      (err) => {
        assert.match(err.message, /颜色解释/, '错误信息要说明是颜色解释的问题');
        assert.match(err.message, /波段数/, '错误信息要点明波段数');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
