import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
const { tools } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'runner.ts')).href);
const { datasetExtent, vectorToGeoJson } =
  await import(pathToFileURL(join(root, 'src', 'engine', 'export', 'index.ts')).href);

const loc = resolveGdal();
const gdal = tools(loc);
const fixtures = join(root, 'fixtures');
const rasterFixture = join(fixtures, 'embedded.tff');
const vectorFixture = join(fixtures, 'sample.shp');

/** 样本在 120.3E / 30.5N 附近 → UTM 50N 带号是 51（zone = floor((120.3+180)/6)+1） */
const UTM_EPSG = 'EPSG:32651';

/** 收集 GeoJSON 里所有坐标点 */
function collectCoords(node, out = []) {
  if (Array.isArray(node)) {
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      out.push([node[0], node[1]]);
    } else {
      for (const child of node) collectCoords(child, out);
    }
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectCoords(value, out);
  }
  return out;
}

/* ────────── 4326 的源：范围应当直接就是经纬度 ────────── */

test('数据集范围：4326 栅格给出的是经纬度包围盒', async () => {
  const res = await datasetExtent(loc, { path: rasterFixture });
  assert.equal(res.kind, 'raster');
  assert.equal(res.sourceEpsg, 4326);
  assert.equal(res.reprojected, false);

  const info = JSON.parse((await gdal.info(rasterFixture, ['-json'])).stdout);
  const gt = info.geoTransform;
  const [w, h] = info.size;
  const expectMinX = gt[0];
  const expectMaxX = gt[0] + gt[1] * w;
  const expectMaxY = gt[3];
  const expectMinY = gt[3] + gt[5] * h;

  assert.ok(Math.abs(res.bbox[0] - expectMinX) < 1e-9, `minX 应为 ${expectMinX}，实为 ${res.bbox[0]}`);
  assert.ok(Math.abs(res.bbox[1] - expectMinY) < 1e-9, `minY 应为 ${expectMinY}，实为 ${res.bbox[1]}`);
  assert.ok(Math.abs(res.bbox[2] - expectMaxX) < 1e-9, `maxX 应为 ${expectMaxX}，实为 ${res.bbox[2]}`);
  assert.ok(Math.abs(res.bbox[3] - expectMaxY) < 1e-9, `maxY 应为 ${expectMaxY}，实为 ${res.bbox[3]}`);
});

test('数据集范围：4326 矢量给出的是经纬度包围盒', async () => {
  const res = await datasetExtent(loc, { path: vectorFixture });
  assert.equal(res.kind, 'vector');
  assert.equal(res.sourceEpsg, 4326);
  assert.equal(res.reprojected, false);
  // 样本在杭州，所有坐标都必须在合理经纬度范围内
  assert.ok(res.bbox[0] > 100 && res.bbox[0] < 130, `经度范围不对：${res.bbox[0]}`);
  assert.ok(res.bbox[1] > 20 && res.bbox[1] < 40, `纬度范围不对：${res.bbox[1]}`);
});

/* ────────── 投影坐标系的源：必须换算回 4326 ────────── */

test('数据集范围：投影坐标系的栅格会换算回经纬度', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-extent-raster-'));
  const projected = join(dir, 'utm.tif');
  try {
    const warp = await gdal.warp(['-t_srs', UTM_EPSG, '-of', 'GTiff', rasterFixture, projected]);
    assert.ok(warp.ok, `投影样本生成失败：${warp.stderr}`);

    const res = await datasetExtent(loc, { path: projected });
    assert.equal(res.kind, 'raster');
    assert.equal(res.sourceEpsg, 32651);
    assert.equal(res.reprojected, true, '投影源应当发生重投影');

    const original = await datasetExtent(loc, { path: rasterFixture });
    // 容差按**源像元大小**给：gdalwarp 的目标范围是按像元取整算出来的，
    // 换算回来必然差不到一个像元（实测 40×30 的样本差 0.00083°，像元是 0.001°）。
    // 这个精度对"把视野移到数据上"完全够用；它不是测量精度。
    const info = JSON.parse((await gdal.info(rasterFixture, ['-json'])).stdout);
    const tol = Math.abs(info.geoTransform[1]) * 2;
    for (let i = 0; i < 4; i++) {
      assert.ok(
        Math.abs(res.bbox[i] - original.bbox[i]) < tol,
        `第 ${i} 项应约为 ${original.bbox[i]}（容差 ${tol}），实为 ${res.bbox[i]}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('数据集范围：投影坐标系的矢量会换算回经纬度', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-extent-vector-'));
  const projected = join(dir, 'utm.geojson');
  try {
    // 用 GeoJSON 做中间格式：ESRI Shapefile 驱动扛不住中文字段名
    const conv = await gdal.ogr2ogr(['-f', 'GeoJSON', '-t_srs', UTM_EPSG, projected, vectorFixture]);
    assert.ok(conv.ok, `投影样本生成失败：${conv.stderr}`);

    const res = await datasetExtent(loc, { path: projected });
    assert.equal(res.kind, 'vector');
    assert.equal(res.sourceEpsg, 32651);
    assert.equal(res.reprojected, true);

    const original = await datasetExtent(loc, { path: vectorFixture });
    for (let i = 0; i < 4; i++) {
      assert.ok(
        Math.abs(res.bbox[i] - original.bbox[i]) < 1e-4,
        `第 ${i} 项应约为 ${original.bbox[i]}，实为 ${res.bbox[i]}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ────────── 回归：GeoJSON 必须落在 4326 ────────── */

test('回归：矢量转 GeoJSON 指定 targetCrs 后，坐标是经纬度而不是投影坐标', async () => {
  // 这是 2026-10-21 浏览器实测抓到的真 bug：
  // ogr2ogr 不给 -t_srs 时**按源 CRS 输出**（UTM 东坐标 816690 / 北坐标 3381042），
  // MapLibre 当成经纬度解析 → 要素飞到几百万度外，地图上一片空白。
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-geojson-crs-'));
  const projected = join(dir, 'utm.geojson');
  try {
    const conv = await gdal.ogr2ogr(['-f', 'GeoJSON', '-t_srs', UTM_EPSG, projected, vectorFixture]);
    assert.ok(conv.ok, `投影样本生成失败：${conv.stderr}`);

    const res = await vectorToGeoJson(loc, { path: projected, targetCrs: 'EPSG:4326' });
    const points = collectCoords(res.geojson);
    assert.ok(points.length > 0, '应有坐标点');
    for (const [x, y] of points) {
      assert.ok(x > 100 && x < 130, `经度应落在杭州附近，实为 ${x}`);
      assert.ok(y > 20 && y < 40, `纬度应落在杭州附近，实为 ${y}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('回归：不指定 targetCrs 时输出的是源 CRS（说明这条路径确实危险）', async () => {
  // 这条测试是为了钉住 GDAL 的真实行为：不给 -t_srs 就是源 CRS。
  // 如果哪天 GDAL 改成默认输出 4326，这条测试会失败并提醒我们更新注释与文档。
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-geojson-crs-'));
  const projected = join(dir, 'utm.geojson');
  try {
    const conv = await gdal.ogr2ogr(['-f', 'GeoJSON', '-t_srs', UTM_EPSG, projected, vectorFixture]);
    assert.ok(conv.ok, `投影样本生成失败：${conv.stderr}`);

    const res = await vectorToGeoJson(loc, { path: projected });
    const points = collectCoords(res.geojson);
    assert.ok(points.length > 0);
    const [x] = points[0];
    assert.ok(x > 100000, `未指定 targetCrs 时应输出投影坐标（东坐标量级），实为 ${x}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ────────── 异常 ────────── */

test('数据集范围：文件不存在时报错', async () => {
  await assert.rejects(
    () => datasetExtent(loc, { path: join(fixtures, 'no-such-dataset.tif') }),
    /范围|无法确定/,
  );
});
