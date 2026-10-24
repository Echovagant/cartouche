/**
 * 两个**实测出来的引擎缺陷**的回归测试（2026-10-24 真实数据评测时撞到的）。
 *
 * A. 多图层 GeoPackage 读不出来
 *    - 现象：ogr2ogr 把每个图层都往同一个 GeoJSON 里写，第二个图层就报
 *      「Layer 'x' does not already exist in the output dataset」，整个文件读不了；
 *    - 附带：parseLayerInfo 把所有图层的列名累加（变成「名称,编号,名称,编号」）。
 *
 * B. 跨坐标系的空间连接不报错，静默产出错结果
 *    - 现象：4326 的面与 3857 的点连出「匹配 2 条」——结果在空间上是错的，
 *      但看上去完全正常，用户不会发现。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
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
const { runVectorRenameFields } = await import(eng('vector/rename-fields.ts'));

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

/* ── 无坐标系 + 中文列名：不能被读成「零列」 ─────────────────────── */

test('无坐标系 + 中文列名的 Shapefile：列名要读得出来，坐标系要认成「没有」', async () => {
  if (!loc) return;
  const src = join(dir, 'src3');
  await mkdir(src, { recursive: true });
  const srcFile = join(src, '中文列名.geojson');
  await writeFile(
    srcFile,
    JSON.stringify(
      geojson(
        [
          { 名称: '甲', 编号: 1 },
          { 名称: '乙', 编号: 2 },
        ],
        (i) => [116.3 + i * 0.01, 39.95 + i * 0.01],
      ),
    ),
    'utf8',
  );
  const shp = join(dir, '中文列名.shp');
  // 不给 -a_srs：这一层**没有**坐标系
  const conv = await gdal.ogr2ogr(['-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', shp, srcFile]);
  assert.ok(conv.ok, `造图层失败：${conv.stderr}`);
  // GeoJSON 驱动会按 RFC 7946 自动补 WGS84 —— 要造「没有坐标系」这一层，
  // 得把 .prj 删掉（这正是甲方数据里常见的那种情况）
  await rm(join(dir, '中文列名.prj'), { force: true });

  const info = await probeLayer(loc, shp);
  assert.deepEqual(info.fields.map((f) => f.name), ['名称', '编号'], '中文列名要读得出来');
  assert.equal(info.srsWkt, null, '没有坐标系要认成 null（不是一串乱码）');
  assert.equal(info.epsg, null);

  const res = await readFeatures(loc, { path: shp });
  assert.equal(res.featureCount, 2);
  assert.deepEqual(res.fields, ['名称', '编号']);
});

/* ── 空图层写回：不能把字段定义写丢 ─────────────────────────────── */

test('空图层写回：字段定义不能丢，原文件必须一个字节都没动', async () => {
  if (!loc) return;
  const src = join(dir, 'src4');
  await mkdir(src, { recursive: true });
  const emptyFile = join(src, '空层.geojson');
  // 有属性表但**一条要素都没有**
  await writeFile(
    emptyFile,
    JSON.stringify({ type: 'FeatureCollection', features: [] }),
    'utf8',
  );
  const shp = join(dir, '空层.shp');
  // 先造一个带字段的空图层：写一个要素进去，再把要素删掉（字段定义留着）
  const seeded = join(src, '带要素.geojson');
  await writeFile(
    seeded,
    JSON.stringify(
      geojson(
        [
          { 名称: '甲', 编号: 1, 面积: 10 },
        ],
        () => [116.3, 39.95],
      ),
    ),
    'utf8',
  );
  const c1 = await gdal.ogr2ogr(['-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', shp, seeded]);
  assert.ok(c1.ok, `造带要素图层失败：${c1.stderr}`);
  // 用 ogr2ogr 造一个「有字段定义、零要素」的图层：
  // -where 1=0 把要素全滤掉，但列的定义照抄（写到另一个文件再换名）
  const emptied = join(dir, '空层2.shp');
  const c2 = await gdal.ogr2ogr([
    '-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', '-where', '1=0', emptied, shp,
  ]);
  assert.ok(c2.ok, `清空要素失败：${c2.stderr}`);
  // 换回原名（Shapefile 的伴随文件靠同名被认出来）
  for (const suffix of ['.shp', '.shx', '.dbf', '.prj', '.cpg']) {
    const from = join(dir, `空层2${suffix}`);
    const to = join(dir, `空层${suffix}`);
    if (existsSync(from)) await rename(from, to);
  }

  const before = await probeLayer(loc, shp);
  assert.equal(before.featureCount, 0, '前提：这一层没有要素');
  assert.equal(before.fields.length, 3, '前提：字段定义还在');

  const hashBefore = await hashDir(dir, '空层');

  await assert.rejects(
    () =>
      runVectorRenameFields(
        { target: 'dataset://空层.shp', mapping: { 名称: '新名称' } },
        { loc, store },
        false,
      ),
    /字段定义丢了|没有要素/,
    '必须说清是「写出去的文件会丢字段」，而不是别的',
  );

  const hashAfter = await hashDir(dir, '空层');
  assert.equal(hashAfter, hashBefore, '原数据必须一个字节都没动');
});

/** 把某个文件及同名伴随文件的内容摘要拼起来（用来比对「一个字节都没动」） */
async function hashDir(base, stem) {
  const names = (await readdir(base)).filter((n) => n.startsWith(stem)).sort();
  const h = createHash('sha256');
  for (const n of names) {
    h.update(n);
    h.update(await readFile(join(base, n)));
  }
  return h.digest('hex');
}
