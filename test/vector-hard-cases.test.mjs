/**
 * 两个**实测出来的引擎缺陷**的回归测试（2026-10-24 真实数据评测时撞到的）。
 *
 * A. 多图层 GeoPackage 读不出来
 *    - 现象：ogr2ogr 把每个图层都往同一个 GeoJSON 里写，第二个图层就报
 *      「Layer 'x' does not already exist in the output dataset」，整个文件读不了；
 *    - 附带：parseLayerInfo 把所有图层的列名累加（变成「名称,编号,名称,编号」）。
 *
 * B. 跨坐标���的空间连接不报错，静默产出错结果
 *    - 现象：4326 的面与 3857 的点连出「匹配 2 条」——结果在空间上是错的，
 *      但看上去完全正常，用户不会发现。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { readFeatures, probeLayer } = await import(eng('vector/read.ts'));
const { runVectorSpatialJoin } = await import(eng('vector/spatial-join.ts'));

const loc = resolveGdal();
const gdal = tools(loc);
const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || tmpdir();

let dir = '';
let store = null;

function geojson(props, coords) {
  return {
    type: 'FeatureCollection',
    features: props.map((p, i) => ({
      type: 'Feature',
      properties: p,
      geometry: { type: 'Point', coordinates: coords(i) },
    })),
  };
}

/** 造一个多图层 GeoPackage：两个图层各 2 条要素，列名相同但值不同 */
async function makeMultiLayerGpkg() {
  const src = join(dir, 'src');
  await mkdir(src, { recursive: true });
  await writeFile(
    join(src, '第一层.geojson'),
    JSON.stringify(geojson([{ 名称: '甲', 编号: 1 }, { 名称: '乙', 编号: 2 }], (i) => [100 + i, 30 + i])),
    'utf8',
  );
  await writeFile(
    join(src, '第二层.geojson'),
    JSON.stringify(geojson([{ 名称: '丙', 编号: 3 }, { 名称: '丁', 编号: 4 }], (i) => [110 + i, 35 + i])),
    'utf8',
  );
  const gpkg = join(dir, '多图层.gpkg');
  const first = await gdal.ogr2ogr(['-f', 'GPKG', gpkg, join(src, '第一层.geojson')]);
  assert.ok(first.ok, `造 GPKG 第一层失败：${first.stderr}`);
  const second = await gdal.ogr2ogr(['-f', 'GPKG', '-update', gpkg, join(src, '第二层.geojson')]);
  assert.ok(second.ok, `造 GPKG 第二层失败：${second.stderr}`);
  return gpkg;
}

/** 造两个坐标系不同的图层：面在 4326，点在 3857 */
async function makeMixedCrs() {
  const src = join(dir, 'src2');
  await mkdir(src, { recursive: true });
  const poly = join(src, '面.geojson');
  const pt = join(src, '点.geojson');
  await writeFile(
    poly,
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { 名称: '区', 人口: 100 },
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
        },
      ],
    }),
    'utf8',
  );
  await writeFile(
    pt,
    JSON.stringify(
      geojson([{ 名称: '点', 类别: 'A' }], () => [1113194, 333958]),
    ),
    'utf8',
  );
  // 面：4326（经纬度）
  const polyShp = join(dir, '面.shp');
  const c1 = await gdal.ogr2ogr(['-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', polyShp, poly]);
  assert.ok(c1.ok, `造面图层失败：${c1.stderr}`);
  // 点：3857（Web Mercator）—— 用 -a_srs 指定坐标系
  const ptShp = join(dir, '点.shp');
  const c2 = await gdal.ogr2ogr([
    '-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', '-a_srs', 'EPSG:3857', ptShp, pt,
  ]);
  assert.ok(c2.ok, `造点图层失败：${c2.stderr}`);
  return { polyShp, ptShp };
}

before(async () => {
  if (!loc) return;
  dir = await mkdtemp(join(TMP_BASE, 'cartouche-hard-vector-'));
  store = new LocalFolderStore(dir);
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('多图层 GeoPackage：能读出要素，列名不重复，并说清还有哪些图层', async () => {
  if (!loc) return;
  const gpkg = await makeMultiLayerGpkg();

  const info = await probeLayer(loc, gpkg);
  assert.equal(info.layerNames.length, 2, '两个图层都要被记下来');
  assert.equal(info.layerName, '第一层');
  // 关键：列名不能跨图层累加（修之前是「名称,编号,名称,编号」）
  assert.deepEqual(info.fields.map((f) => f.name), ['名称', '编号']);

  const res = await readFeatures(loc, { path: gpkg });
  assert.equal(res.features.length, 2, '读得出第一层的要素');
  assert.equal(res.layerName, '第一层');
  assert.deepEqual([...res.otherLayerNames], ['第二层'], '还有哪些图层必须说清楚');
  assert.deepEqual(res.fields, ['名称', '编号'], '列名不重复');
});

test('多图层 GeoPackage：按条件查也走得通', async () => {
  if (!loc) return;
  const gpkg = await makeMultiLayerGpkg();
  const res = await readFeatures(loc, { path: gpkg, where: '编号 = 2' });
  assert.equal(res.featureCount, 1, '条件筛选生效');
  assert.equal(res.features[0].properties['名称'], '乙');
});

test('跨坐标系的两个图层做空间连接：必须明确拒绝，不能静默出错结果', async () => {
  if (!loc) return;
  const { polyShp, ptShp } = await makeMixedCrs();

  const target = await probeLayer(loc, polyShp);
  const source = await probeLayer(loc, ptShp);
  assert.notEqual(target.epsg, source.epsg, '前提：这两个图层的坐标系确实不同');

  await assert.rejects(
    () =>
      runVectorSpatialJoin(
        {
          target: 'dataset://面.shp',
          source: 'dataset://点.shp',
          relation: 'within',
          aggregate: 'count',
        },
        { loc, store },
        false,
      ),
    /坐标系不一样/,
    '必须说清是坐标系的问题，并给出怎么改',
  );
});
