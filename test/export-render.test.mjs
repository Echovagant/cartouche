import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
const { tools } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'runner.ts')).href);
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
