import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
const { tools, runTool } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'runner.ts')).href);
const { renderRasterPng, readPngSize, buildPdfFromJpeg, inspectPdf, vectorToGeoJson, PdfBuildError } =
  await import(pathToFileURL(join(root, 'src', 'engine', 'export', 'index.ts')).href);

const loc = resolveGdal();
const gdal = tools(loc);
const fixtures = join(root, 'fixtures');
const rasterFixture = join(fixtures, 'embedded.tff');
const vectorFixture = join(fixtures, 'sample.shp');

/* ────────── 栅格渲染成 PNG ────────── */

test('渲染栅格：产出 PNG，头里的宽高与请求一致', async () => {
  const res = await renderRasterPng(loc, {
    path: rasterFixture,
    width: 320,
    height: 240,
  });
  assert.ok(res.png.length > 0);
  assert.equal(res.png[0], 0x89, '应为 PNG 文件头');
  assert.equal(res.png[1], 0x50);
  const size = readPngSize(res.png);
  assert.ok(size, '应能从 PNG 头读出尺寸');
  assert.equal(size.width, 320);
  assert.equal(size.height, 240);
});

test('渲染栅格：bbox 用 min/max 序，等于整幅时应与不带 bbox 逐字节一致', async () => {
  // 约定：bbox = [minX, minY, maxX, maxY]（EPSG:4326），服务端转成 GDAL 的 ulx/uly/lrx/lry
  const info = JSON.parse((await gdal.info(rasterFixture, ['-json'])).stdout);
  const gt = info.geoTransform;
  const [w, h] = info.size;
  const minX = gt[0];
  const maxX = gt[0] + gt[1] * w;
  const maxY = gt[3];
  const minY = gt[3] + gt[5] * h;

  const whole = await renderRasterPng(loc, { path: rasterFixture, width: 200, height: 150 });
  const boxed = await renderRasterPng(loc, {
    path: rasterFixture,
    width: 200,
    height: 150,
    bbox: [minX, minY, maxX, maxY],
  });
  assert.equal(boxed.png.length, whole.png.length);
  assert.ok(
    whole.png.every((b, i) => b === boxed.png[i]),
    '整幅 bbox 的渲染结果应与不带 bbox 逐字节一致',
  );

  // 反向（GDAL 的 ulx/uly/lrx/lry 序）必须被拒，否则前端传错序时会静默出错图
  await assert.rejects(
    () =>
      renderRasterPng(loc, {
        path: rasterFixture,
        width: 50,
        height: 50,
        bbox: [minX, maxY, maxX, minY],
      }),
    /bbox/,
  );
});

test('渲染栅格：投影坐标系的源要走 gdalwarp 重投影（gdal_translate 没有 -t_srs）', async () => {
  // 造一个 UTM 版本的样本（EPSG:32631），模拟真实的投影坐标系影像
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-utm-'));
  try {
    const utm = join(dir, 'utm.tif');
    const warp = await gdal.warp([
      '-t_srs', 'EPSG:32631',
      '-of', 'GTiff',
      rasterFixture,
      utm,
    ]);
    assert.ok(warp.ok, `造 UTM 样本失败：${warp.stderr}`);

    // 目标 CRS 是 4326、bbox 也在 4326 → 必须走 warp 才能对上位
    const res = await renderRasterPng(loc, {
      path: utm,
      width: 160,
      height: 120,
      bbox: [120.3, 30.51, 120.34, 30.54],
      targetCrs: 'EPSG:4326',
    });
    const size = readPngSize(res.png);
    assert.ok(size, '应产出合法 PNG');
    assert.equal(size.width, 160);
    assert.equal(size.height, 120);
    assert.ok(res.command[0].includes('warp'), `投影源应走 gdalwarp，实际命令：${res.command[0]}`);

    // 不指定 targetCrs 时不重投影（保持源 CRS），命令应是 translate
    const same = await renderRasterPng(loc, { path: utm, width: 80, height: 60 });
    assert.ok(same.command[0].includes('translate'), `同 CRS 应走 gdal_translate，实际：${same.command[0]}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('渲染栅格：带 bbox 时按窗口取景，输出仍是合法 PNG', async () => {
  const res = await renderRasterPng(loc, {
    path: rasterFixture,
    width: 200,
    height: 150,
    bbox: [120.3, 30.52, 120.32, 30.54],
  });
  const size = readPngSize(res.png);
  assert.ok(size);
  assert.equal(size.width, 200);
  assert.equal(size.height, 150);
});

test('渲染栅格：非法 bbox 直接报错，不去调 GDAL', async () => {
  // 约定是 [minX, minY, maxX, maxY]
  await assert.rejects(
    () => renderRasterPng(loc, { path: rasterFixture, width: 100, height: 100, bbox: [3, 2, 1, 4] }),
    /bbox/,
  );
  await assert.rejects(
    () => renderRasterPng(loc, { path: rasterFixture, width: 100, height: 100, bbox: [1, 4, 3, 2] }),
    /bbox/,
  );
  await assert.rejects(
    () => renderRasterPng(loc, { path: rasterFixture, width: 100, height: 100, bbox: [1, 2, NaN, 4] }),
    /bbox/,
  );
});

test('渲染栅格：文件不存在时抛带 stderr 的错误', async () => {
  await assert.rejects(
    () => renderRasterPng(loc, { path: join(fixtures, 'no-such-file.tif'), width: 50, height: 50 }),
    /渲染失败/,
  );
});

/* ────────── 矢量转 GeoJSON ────────── */

test('矢量转 GeoJSON：要素数与字段都在', async () => {
  const res = await vectorToGeoJson(loc, { path: vectorFixture });
  assert.ok(res.featureCount > 0);
  const gj = res.geojson;
  assert.equal(gj.type, 'FeatureCollection');
  assert.ok(Array.isArray(gj.features));
  assert.equal(gj.features.length, res.featureCount);
  assert.ok(gj.features[0].geometry, '要素应带几何');
});

test('矢量转 GeoJSON：limit 生效并标记截断', async () => {
  const res = await vectorToGeoJson(loc, { path: vectorFixture, limit: 1 });
  assert.equal(res.featureCount, 1);
  assert.equal(res.truncated, true);
});

/* ────────── 零依赖 PDF 封装 ────────── */

async function makeJpeg() {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-jpeg-'));
  const out = join(dir, 'a.jpg');
  const res = await gdal.translate(['-of', 'JPEG', '-outsize', '160', '120', rasterFixture, out]);
  assert.ok(res.ok, `JPEG 生成失败：${res.stderr}`);
  const bytes = new Uint8Array(await readFile(out));
  await rm(dir, { recursive: true, force: true });
  return bytes;
}

test('PDF 封装：结构合法、含一页、含图像', async () => {
  const jpeg = await makeJpeg();
  const pdf = buildPdfFromJpeg(jpeg, 160, 120, { title: '测试图件', author: '张三' });
  assert.ok(pdf.length > jpeg.length, 'PDF 应比裸 JPEG 大');
  const head = new TextDecoder('latin1').decode(pdf.subarray(0, 8));
  assert.ok(head.startsWith('%PDF-1.4'), `文件头不对：${head}`);

  const info = inspectPdf(pdf);
  assert.deepEqual(info.issues, [], `结构问题：${info.issues.join('；')}`);
  assert.equal(info.valid, true);
  assert.equal(info.pageCount, 1);
  assert.equal(info.hasImage, true);
  assert.ok(info.objectCount >= 5, '对象数应至少 5 个');
});

test('PDF 封装：页面尺寸可指定（出图版式选 A3 / 竖版时图幅要跟着变）', async () => {
  const jpeg = await makeJpeg();
  const mm2pt = (mm) => (mm / 25.4) * 72;
  // A4 横向（默认）
  const a4 = buildPdfFromJpeg(jpeg, 160, 120);
  // A3 横向：420×297 mm
  const a3 = buildPdfFromJpeg(jpeg, 160, 120, {
    pageWidthPt: mm2pt(420),
    pageHeightPt: mm2pt(297),
  });
  const a4Text = new TextDecoder('latin1').decode(a4);
  const a3Text = new TextDecoder('latin1').decode(a3);
  assert.ok(
    a4Text.includes('/MediaBox [0 0 841.89 595.28]'),
    `A4 横向的 MediaBox 不对：${a4Text.match(/\/MediaBox[^\]]*\]/)?.[0]}`,
  );
  assert.ok(
    a3Text.includes('/MediaBox [0 0 1190.55 841.89]'),
    `A3 横向的 MediaBox 不对：${a3Text.match(/\/MediaBox[^\]]*\]/)?.[0]}`,
  );
  // 改页面尺寸不能改坏 PDF 结构
  assert.deepEqual(inspectPdf(a3).issues, [], 'A3 的 PDF 结构有问题');
  assert.equal(inspectPdf(a3).pageCount, 1);
});

test('PDF 封装：JPEG 原始字节原样嵌入（不能被重新编码）', async () => {
  const jpeg = await makeJpeg();
  const pdf = buildPdfFromJpeg(jpeg, 160, 120);
  // 在 PDF 里搜 JPEG 的起始标记 FFD8FF，确认是原样嵌入
  let found = -1;
  for (let i = 0; i < pdf.length - 3; i++) {
    if (pdf[i] === 0xff && pdf[i + 1] === 0xd8 && pdf[i + 2] === 0xff) {
      found = i;
      break;
    }
  }
  assert.ok(found >= 0, 'PDF 里应能找到 JPEG 数据');
  for (let k = 0; k < 32; k++) {
    assert.equal(pdf[found + k], jpeg[k], `第 ${k} 字节应与原 JPEG 一致`);
  }
});

test('PDF 封装：非法输入被挡下并给出可读原因', () => {
  assert.throws(() => buildPdfFromJpeg(new Uint8Array(), 10, 10), /JPEG 数据为空/);
  assert.throws(() => buildPdfFromJpeg(new Uint8Array([1, 2, 3, 4]), 10, 10), /不是 JPEG/);
  assert.throws(() => buildPdfFromJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 0, 10), /尺寸非法/);
});

test('PDF 封装：PDF 是纯函数，同样的输入产出同样的字节', async () => {
  const jpeg = await makeJpeg();
  const a = buildPdfFromJpeg(jpeg, 160, 120, { title: 'T' });
  const b = buildPdfFromJpeg(jpeg, 160, 120, { title: 'T' });
  assert.deepEqual(Array.from(a), Array.from(b));
});

test('PDF 封装：非 ASCII 标题不会破坏文件结构', async () => {
  const jpeg = await makeJpeg();
  const pdf = buildPdfFromJpeg(jpeg, 160, 120, { title: '图签 Cartouche 出图' });
  const info = inspectPdf(pdf);
  assert.deepEqual(info.issues, []);
  assert.equal(info.valid, true);
});

test('PDF 封装：PdfBuildError 是可辨识的错误类型', () => {
  try {
    buildPdfFromJpeg(new Uint8Array(), 1, 1);
    assert.fail('应当抛错');
  } catch (err) {
    assert.ok(err instanceof PdfBuildError);
  }
});

/* ────────── 16 位影像的显示拉伸（stretch 开关） ────────── */

/**
 * 造一张 ENVI 裸文件再转成 GTiff。
 *
 * ENVI 的 data type：1=Byte、12=UInt16。
 * map info 的前两个数是**1 基的参考像元号**，后两个是参考像元的地图坐标 ——
 * 写错 GDAL 会把图当南向上或整体偏移（raster-window.test.mjs 里的 helper 同此约定）。
 *
 * 转 GTiff 时用 -a_srs 钉死坐标系：ENVI 头里没有显式 CRS，GDAL 会自己挑一个
 * （实测会挑到 GDA94 一族，于是重投影时落到 MGA zone 55 的 650 万米假东移上）。
 */
async function makeEnvifile(file, { width, height, dataType = 1, pixel = 1, cornerX = 0, cornerY = null, valueAt }) {
  const bytesPerSample = dataType === 12 ? 2 : 1;
  const data = Buffer.alloc(width * height * bytesPerSample);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * bytesPerSample;
      const v = valueAt(x, y);
      if (bytesPerSample === 2) data.writeUInt16LE(v, off);
      else data[off] = v;
    }
  }
  const top = cornerY ?? height * pixel;
  const bin = file.replace(/\.tif$/, '.img');
  writeFileSync(bin, data);
  writeFileSync(
    file.replace(/\.tif$/, '.hdr'),
    [
      'ENVI', `samples = ${width}`, 'bands = 1', 'header offset = 0', 'file type = ENVI Standard',
      `data type = ${dataType}`, 'interleave = bsq', 'byte order = 0', `lines = ${height}`,
      'header size = 0', `pixel size = ${pixel.toExponential(10)}`,
      // 参考像元取 (1,1)、其地图坐标取左上角 → 读进来后整图原点正好落在 (cornerX, top)
      `map info = {Geographic Lat/Lon, 1.0, 1.0, ${cornerX}, ${top}, ${pixel}, ${pixel}, units=degrees}`,
      '',
    ].join('\n'),
    'latin1',
  );
  const res = await gdal.translate(['-of', 'GTiff', '-a_srs', 'EPSG:4326', bin, file]);
  assert.ok(res.ok, `造夹具失败（${file}）：${res.stderr}`);
  return file;
}

/** 读出栅格的实际地理范围（bbox 约定是 [minX, minY, maxX, maxY]） */
async function extentOf(file) {
  const res = await gdal.info(file, ['-json']);
  assert.ok(res.ok, `gdalinfo 失败：${res.stderr}`);
  const j = JSON.parse(res.stdout);
  const gt = j.geoTransform;
  const [w, h] = j.size;
  return { minX: gt[0], maxX: gt[0] + gt[1] * w, maxY: gt[3], minY: gt[3] + gt[5] * h };
}

/** 读一个像元的值（gdallocationinfo 默认是像元/行坐标，不是地理坐标） */
async function probe(file, x, y) {
  const res = await runTool(loc, `gdallocationinfo${loc.exeSuffix}`, ['-valonly', file, String(x), String(y)]);
  assert.ok(res.ok, `gdallocationinfo 失败：${res.stderr}`);
  return Number(res.stdout.trim().split(/\s+/)[0]);
}

/** PNG 的波段类型（Byte / UInt16） */
async function pngBandType(png) {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-png-'));
  try {
    const file = join(dir, 'out.png');
    writeFileSync(file, png);
    const res = await gdal.info(file, ['-json']);
    assert.ok(res.ok, `gdalinfo 失败：${res.stderr}`);
    return JSON.parse(res.stdout).bands?.[0]?.type;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 16 位夹具：左半 0..1000、右半 2000..3000（整幅值域 0..3000） */
const U16_VALUE = (x) => (x < 32 ? Math.round((x * 1000) / 31) : 2000 + Math.round(((x - 32) * 1000) / 31));

test('渲染栅格：8 位源不给 stretch 时命令与改动前一致，且产物逐字节相同', async () => {
  const res = await renderRasterPng(loc, { path: rasterFixture, width: 320, height: 240 });
  // 默认路径不能多出任何换算参数
  assert.ok(!res.command.includes('-scale'), `默认路径不该带 -scale：${res.command.join(' ')}`);
  assert.ok(!res.command.includes('-ot'), `默认路径不该带 -ot：${res.command.join(' ')}`);
  assert.equal(res.command[0], 'gdal_translate');
  assert.deepEqual(res.command.slice(1, 4), ['-of', 'PNG', '-outsize']);

  // 与手工跑一遍改动前那条命令的产物逐字节比对：默认路径一个字节都没多写
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-ref-'));
  try {
    const ref = join(dir, 'ref.png');
    const r = await gdal.translate(['-of', 'PNG', '-outsize', '320', '240', rasterFixture, ref]);
    assert.ok(r.ok, `参照命令失败：${r.stderr}`);
    const refBytes = new Uint8Array(await readFile(ref));
    assert.equal(res.png.length, refBytes.length);
    assert.ok(res.png.every((b, i) => b === refBytes[i]), '默认路径的产物应与改动前的命令逐字节一致');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const size = readPngSize(res.png);
  assert.ok(size, '应产出合法 PNG');
  assert.equal(size.width, 320);
  assert.equal(size.height, 240);
});

test('渲染栅格：16 位源不给 stretch 时按这一窗口的实际值域拉伸，铺满 0~255', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-u16-'));
  try {
    const tif = join(dir, 'u16.tif');
    await makeEnvifile(tif, {
      width: 64, height: 64, dataType: 12, pixel: 0.0001, cornerX: 120, cornerY: 30.64,
      valueAt: (x) => U16_VALUE(x),
    });
    const ext = await extentOf(tif);
    // 只取左半窗口：这一窗口自己的值域是 0..1000，整幅却是 0..3000
    const bbox = [ext.minX, ext.minY, (ext.minX + ext.maxX) / 2, ext.maxY];

    const res = await renderRasterPng(loc, { path: tif, width: 64, height: 64, bbox });
    assert.equal(await pngBandType(res.png), 'Byte', '16 位源的底图必须是 8 位');

    // 拉伸用的是窗口自己的值域（0~1000），不是整幅的 0~3000
    const i = res.command.indexOf('-scale');
    assert.ok(i > 0, `应带 -scale：${res.command.join(' ')}`);
    assert.equal(res.command[i + 1], '0');
    assert.equal(res.command[i + 2], '1000');

    const file = join(dir, 'out.png');
    writeFileSync(file, res.png);
    assert.equal(await probe(file, 0, 0), 0, '窗口左端应拉到 0');
    assert.equal(await probe(file, 63, 0), 255, '窗口右端应拉到 255（铺满，而不是按整幅拉成 85）');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('渲染栅格：16 位源 stretch=none 时按固定全量程输出（0~65535 → 0~255）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-u16-'));
  try {
    const tif = join(dir, 'u16.tif');
    await makeEnvifile(tif, {
      width: 64, height: 64, dataType: 12, pixel: 0.0001, cornerX: 120, cornerY: 30.64,
      valueAt: (x) => U16_VALUE(x),
    });
    const ext = await extentOf(tif);
    const bbox = [ext.minX, ext.minY, (ext.minX + ext.maxX) / 2, ext.maxY];

    const res = await renderRasterPng(loc, { path: tif, width: 64, height: 64, bbox, stretch: 'none' });
    assert.equal(await pngBandType(res.png), 'Byte');
    const i = res.command.indexOf('-scale');
    assert.ok(i > 0, `应带 -scale：${res.command.join(' ')}`);
    assert.deepEqual(res.command.slice(i, i + 5), ['-scale', '0', '65535', '0', '255']);

    const file = join(dir, 'out.png');
    writeFileSync(file, res.png);
    const v = await probe(file, 63, 0);
    // 1000 / 257 ≈ 3.9 → 4；关键是**不能**像拉伸那样铺满 255
    assert.ok(v >= 3 && v <= 4, `固定全量程下 1000 应映射到 3~4，实际 ${v}`);
    assert.notEqual(v, 255, '固定全量程不能铺满 255');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('渲染栅格：16 位常量图不变成全黑（值域退化时退回固定全量程）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-u16-'));
  try {
    const tif = join(dir, 'const.tif');
    await makeEnvifile(tif, {
      width: 32, height: 32, dataType: 12, pixel: 0.0001, cornerX: 120, cornerY: 30.64,
      valueAt: () => 1000,
    });
    const res = await renderRasterPng(loc, { path: tif, width: 32, height: 32 });
    assert.equal(await pngBandType(res.png), 'Byte');
    const file = join(dir, 'out.png');
    writeFileSync(file, res.png);
    const v = await probe(file, 16, 16);
    assert.ok(v > 0, `常量图不该是全黑，实际 ${v}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('渲染栅格：8 位源也能用 stretch=auto 按实际值域拉伸', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-b8-'));
  try {
    const tif = join(dir, 'b8.tif');
    await makeEnvifile(tif, {
      width: 32, height: 32, dataType: 1, pixel: 0.0001, cornerX: 120, cornerY: 30.64,
      valueAt: (x) => x * 8,
    });

    const auto = await renderRasterPng(loc, { path: tif, width: 32, height: 32, stretch: 'auto' });
    const autoFile = join(dir, 'auto.png');
    writeFileSync(autoFile, auto.png);
    assert.equal(await probe(autoFile, 0, 0), 0, 'auto 应把窗口左端拉到 0');
    assert.equal(await probe(autoFile, 31, 0), 255, 'auto 应把窗口右端拉到 255');

    // 同一张图走 none：8 位原样输出，右端仍是 248
    const none = await renderRasterPng(loc, { path: tif, width: 32, height: 32, stretch: 'none' });
    const noneFile = join(dir, 'none.png');
    writeFileSync(noneFile, none.png);
    assert.equal(await probe(noneFile, 31, 0), 248, 'none 下 8 位应原样输出');
    assert.ok(!none.command.includes('-scale'), `8 位 none 不该带 -scale：${none.command.join(' ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('渲染栅格：不认识的像素类型直接报错，错误信息带原始类型名', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-f32-'));
  try {
    const tif = join(dir, 'f32.tif');
    await makeEnvifile(tif, {
      width: 16, height: 16, dataType: 1, pixel: 0.0001, cornerX: 120, cornerY: 30.64,
      valueAt: () => 10,
    });
    // 转成复数：引擎算不了复数带，别悄悄按 8 位处理
    // （Int16 / Int32 / Float32 这些已经支持了，拿它们当例子会让这条用例变成假警报）
    const r = await gdal.translate(['-of', 'GTiff', '-ot', 'CInt16', tif, join(dir, 'cint16_out.tif')]);
    assert.ok(r.ok, `造复数夹具失败：${r.stderr}`);
    await assert.rejects(
      () => renderRasterPng(loc, { path: join(dir, 'cint16_out.tif'), width: 16, height: 16 }),
      (err) => {
        assert.match(err.message, /不支持的像素类型/, '要说明是不支持的类型');
        assert.match(err.message, /CInt16/, '错误信息要带上原始类型名');
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('渲染栅格：32 位与浮点源按实际值域拉伸成 8 位显示（降位必须带 -scale）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-i32-'));
  try {
    // Int32 源（高程那类数据）：必须能出图，且降位是带 -scale 的显式换算
    const tif = join(dir, 'i32.tif');
    await makeEnvifile(tif, {
      width: 32, height: 32, dataType: 1, pixel: 0.0001, cornerX: 120, cornerY: 30.64,
      valueAt: () => 10,
    });
    const r = await gdal.translate(['-of', 'GTiff', '-ot', 'Int32', tif, join(dir, 'i32_out.tif')]);
    assert.ok(r.ok, `造 Int32 夹具失败：${r.stderr}`);

    const res = await renderRasterPng(loc, { path: join(dir, 'i32_out.tif'), width: 32, height: 32 });
    assert.equal(await pngBandType(res.png), 'Byte', '显示导出必须是 8 位');
    assert.ok(res.command.includes('-scale'), `降位必须带 -scale：${res.command.join(' ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('渲染栅格：16 位源重投影时也走中间瓦片（gdalwarp 没有 -scale）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-u16-'));
  try {
    const tif = join(dir, 'u16.tif');
    await makeEnvifile(tif, {
      width: 64, height: 64, dataType: 12, pixel: 0.0001, cornerX: 120, cornerY: 30.64,
      valueAt: (x) => U16_VALUE(x),
    });
    const res = await renderRasterPng(loc, { path: tif, width: 64, height: 64, targetCrs: 'EPSG:32631' });
    assert.equal(await pngBandType(res.png), 'Byte', '重投影后的底图也必须是 8 位');
    // 最后一步由 gdal_translate 出 PNG（warp 只负责落中间瓦片）
    assert.equal(res.command[0], 'gdal_translate', `最后一步应是 translate：${res.command.join(' ')}`);
    assert.ok(res.command.includes('-scale'), `应带 -scale：${res.command.join(' ')}`);
    // 瓦片是中间产物，在临时目录里（改完就被清掉）
    assert.ok(
      res.command.some((a) => /tile\.tif$/.test(a)),
      `命令应指向中间瓦片：${res.command.join(' ')}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
