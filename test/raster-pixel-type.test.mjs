import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', 'raster', p)).href;

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
