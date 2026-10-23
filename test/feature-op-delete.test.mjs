/**
 * feature.delete：按条件删除要素。
 *
 * 删除是不可撤销的一步，所以这个 op 的测试重点是：
 *  1. 删掉的确实没了、留下的确实还在（数量与内容都要核）；
 *  2. `keep` 的四种取值各自的判定口径（none / first / last / largest）；
 *  3. 该停下来的情况必须停下来并说清原因：
 *     0 条命中（不能假装删过）、按 keep 规则一条也删不掉、会把图层删空。
 */
import { test, before, beforeEach, after } from 'node:test';
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
const { readFeatures } = await import(eng('vector/read.ts'));
const { runFeatureDelete } = await import(eng('feature/delete.ts'));

const loc = resolveGdal();
const gdal = tools(loc);
const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || tmpdir();

/** 三个面（米制坐标）：面积分别是 100、400、900 m²。 */
const PARCELS = [
  { NAME: '小', TYPE: 'A', AREA: 100 },
  { NAME: '中', TYPE: 'A', AREA: 400 },
  { NAME: '大', TYPE: 'A', AREA: 900 },
  { NAME: '别的类', TYPE: 'B', AREA: 50 },
];

/** 三个面 + 三个点（点没有大小之分，keep=largest 判不出来）。 */
const POINTS = [
  { NAME: 'P1', TYPE: 'A' },
  { NAME: 'P2', TYPE: 'A' },
];

let dir = '';
let store = null;
let shp = '';
let pointShp = '';

/** 造一份面数据：坐标是米（EPSG:3857 标签，坐标单位是米）。 */
async function makeParcels() {
  const src = join(dir, 'src');
  await mkdir(src, { recursive: true });
  const geojson = join(src, 'parcels.geojson');
  const squares = [
    [0, 0, 10],
    [100, 100, 20],
    [200, 200, 30],
    [500, 500, 10],
  ];
  await writeFile(
    geojson,
    JSON.stringify({
      type: 'FeatureCollection',
      features: PARCELS.map((p, i) => {
        const [x, y, s] = squares[i];
        return {
          type: 'Feature',
          properties: p,
          geometry: {
            type: 'Polygon',
            coordinates: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]],
          },
        };
      }),
    }),
    'utf8',
  );
  const res = await gdal.ogr2ogr([
    '-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', '-a_srs', 'EPSG:3857', shp, geojson,
  ]);
  assert.ok(res.ok, `造 Shapefile 失败：${res.stderr}`);
}

/** 造一份点数据（keep=largest 在点数据上没有意义，要报错）。 */
async function makePoints() {
  const src = join(dir, 'src');
  await mkdir(src, { recursive: true });
  const geojson = join(src, 'points.geojson');
  await writeFile(
    geojson,
    JSON.stringify({
      type: 'FeatureCollection',
      features: POINTS.map((p, i) => ({
        type: 'Feature',
        properties: p,
        geometry: { type: 'Point', coordinates: [120 + i, 30] },
      })),
    }),
    'utf8',
  );
  const res = await gdal.ogr2ogr([
    '-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', pointShp, geojson,
  ]);
  assert.ok(res.ok, `造 Shapefile 失败：${res.stderr}`);
}

before(async () => {
  if (!loc) return;
  dir = await mkdtemp(join(TMP_BASE, 'cartouche-feature-del-'));
  shp = join(dir, 'parcels.shp');
  pointShp = join(dir, 'points.shp');
  store = new LocalFolderStore(dir);
  await makeParcels();
  await makePoints();
});

beforeEach(async () => {
  if (!loc) return;
  await makeParcels();
  await makePoints();
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/* ── 基本行为 ──────────────────────────────────────────────── */

test('feature.delete：结果形状与非栅格型 op 一致', async () => {
  const res = await runFeatureDelete(
    { target: 'dataset://parcels.shp', where: "TYPE = 'B'" },
    { loc, store },
  );
  assert.equal(res.kind, 'value');
  assert.ok(res.summary.length > 0);
  assert.equal(res.outputPath, undefined);
  assert.equal(res.data.matched, 1);
  assert.equal(res.data.deleted, 1);
  assert.equal(res.data.remaining, 3);
});

test('feature.delete：删掉的真的没了，留下的还在', async () => {
  await runFeatureDelete(
    { target: 'dataset://parcels.shp', where: "TYPE = 'B'" },
    { loc, store },
  );
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.features.length, 3);
  assert.deepEqual(
    after.features.map((f) => f.properties.NAME),
    ['小', '中', '大'],
  );
});

test('feature.delete：留下的要素属性没被改坏', async () => {
  await runFeatureDelete(
    { target: 'dataset://parcels.shp', where: "TYPE = 'B'" },
    { loc, store },
  );
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.features[0].properties.AREA, 100);
  assert.equal(after.features[2].properties.AREA, 900);
});

test('feature.delete：写回之后原文件有备份', async () => {
  const res = await runFeatureDelete(
    { target: 'dataset://parcels.shp', where: "TYPE = 'B'" },
    { loc, store },
  );
  assert.ok(res.data.backupPath, '删除必须留下备份');
});

/* ── keep 的四种口径 ───────────────────────────────────────── */

test('feature.delete：keep=none（默认）命中的全删', async () => {
  const res = await runFeatureDelete(
    { target: 'dataset://parcels.shp', where: "TYPE = 'A'" },
    { loc, store },
  );
  assert.equal(res.data.keep, 'none');
  assert.equal(res.data.deleted, 3);
  assert.equal(res.data.remaining, 1);
  const after = await readFeatures(loc, { path: shp });
  assert.deepEqual(after.features.map((f) => f.properties.NAME), ['别的类']);
});

test('feature.delete：keep=first 留下图层里的第一条', async () => {
  const res = await runFeatureDelete(
    { target: 'dataset://parcels.shp', where: "TYPE = 'A'", keep: 'first' },
    { loc, store },
  );
  assert.equal(res.data.deleted, 2);
  assert.equal(res.data.kept.featureIndex, 1);
  const after = await readFeatures(loc, { path: shp });
  assert.deepEqual(after.features.map((f) => f.properties.NAME), ['小', '别的类']);
});

test('feature.delete：keep=last 留下图层里的最后一条', async () => {
  const res = await runFeatureDelete(
    { target: 'dataset://parcels.shp', where: "TYPE = 'A'", keep: 'last' },
    { loc, store },
  );
  assert.equal(res.data.deleted, 2);
  assert.equal(res.data.kept.featureIndex, 3);
  const after = await readFeatures(loc, { path: shp });
  assert.deepEqual(after.features.map((f) => f.properties.NAME), ['大', '别的类']);
});

test('feature.delete：keep=largest 留下面积最大的那条', async () => {
  const res = await runFeatureDelete(
    { target: 'dataset://parcels.shp', where: "TYPE = 'A'", keep: 'largest' },
    { loc, store },
  );
  assert.equal(res.data.deleted, 2);
  const after = await readFeatures(loc, { path: shp });
  assert.deepEqual(
    after.features.map((f) => f.properties.NAME),
    ['大', '别的类'],
    '面积最大的（大）是保留的那条',
  );
});

test('feature.delete：keep=largest 在全是点的图层上判不出来，要报错', async () => {
  await assert.rejects(
    () =>
      runFeatureDelete(
        { target: 'dataset://points.shp', where: "TYPE = 'A'", keep: 'largest' },
        { loc, store },
      ),
    /没有大小之分/,
  );
});

/* ── 预演 ──────────────────────────────────────────────────── */

test('feature.delete：预演不写盘，并说清会删几条', async () => {
  const res = await runFeatureDelete(
    { target: 'dataset://parcels.shp', where: "TYPE = 'A'" },
    { loc, store },
    true,
  );
  assert.equal(res.data.dryRun, true);
  assert.equal(res.data.deleted, 3);
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.features.length, 4, '预演不能删文件里的要素');
});

/* ── 出错必须说清 ──────────────────────────────────────────── */

test('feature.delete：条件命中 0 条要报错，不能当成功', async () => {
  await assert.rejects(
    () => runFeatureDelete({ target: 'dataset://parcels.shp', where: 'AREA > 99999' }, { loc, store }),
    /0 条命中/,
  );
});

test('feature.delete：keep 只能取契约里的四个值', async () => {
  await assert.rejects(
    () =>
      runFeatureDelete(
        { target: 'dataset://parcels.shp', where: "TYPE = 'B'", keep: 'biggest' },
        { loc, store },
      ),
    /keep/,
  );
});

test('feature.delete：keep 给成了别的类型要报错（不能默默当成 none 全删）', async () => {
  await assert.rejects(
    () =>
      runFeatureDelete(
        { target: 'dataset://parcels.shp', where: "TYPE = 'A'", keep: 5 },
        { loc, store },
      ),
    /keep/,
  );
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.features.length, 4, '报错之后数据没被动过');
});

test('feature.delete：按 keep 规则一条也删不掉时要报错', async () => {
  await assert.rejects(
    () =>
      runFeatureDelete(
        { target: 'dataset://parcels.shp', where: "TYPE = 'B'", keep: 'first' },
        { loc, store },
      ),
    /一条也删不掉/,
  );
});

test('feature.delete：会把图层删空时要报错（字段定义会丢）', async () => {
  await assert.rejects(
    () => runFeatureDelete({ target: 'dataset://parcels.shp', where: 'AREA > 0' }, { loc, store }),
    /清空图层/,
  );
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.features.length, 4, '报错之后数据没被动过');
});

test('feature.delete：缺参数要报错', async () => {
  await assert.rejects(
    () => runFeatureDelete({ where: "TYPE = 'A'" }, { loc, store }),
    /target/,
  );
  await assert.rejects(
    () => runFeatureDelete({ target: 'dataset://parcels.shp' }, { loc, store }),
    /where/,
  );
});

test('feature.delete：绝对路径的 target 要被路径闸门挡掉', async () => {
  await assert.rejects(
    () =>
      runFeatureDelete(
        { target: 'C:/Windows/System32/drivers/etc/hosts', where: "TYPE = 'A'" },
        { loc, store },
      ),
    /相对路径/,
  );
});

test('feature.delete：条件里的列不存在要报错', async () => {
  await assert.rejects(
    () => runFeatureDelete({ target: 'dataset://parcels.shp', where: 'NOPE > 0' }, { loc, store }),
    /NOPE/,
  );
});
