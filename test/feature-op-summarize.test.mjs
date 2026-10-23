/**
 * feature.summarize：按字段分组汇总。
 *
 * 这个 op 的测试重点是三件容易出错的地方：
 *  1. **面积单位**：不给 areaUnit 必须报错；给了要按给的单位换算（m² / 公顷 / 亩 / km²）。
 *  2. **经纬度图层**：按平面算面积没有意义，必须报错，不给一个看着精确的数字。
 *  3. **分组与逐列统计**：分组字段、count/sum/mean/min/max/distinct 的口径要对。
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
const { runFeatureSummarize } = await import(eng('feature/summarize.ts'));

const loc = resolveGdal();
const gdal = tools(loc);
const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || tmpdir();

/** 四个面（坐标是米）。A 类两块：10000 + 2500；B 类两块：10000 + 100。 */
const ROWS = [
  { NAME: 'A1', TYPE: 'A', POP: 1, RATIO: 0.5, box: [0, 0, 100] },
  { NAME: 'A2', TYPE: 'A', POP: 2, RATIO: 1.5, box: [0, 0, 50] },
  { NAME: 'B1', TYPE: 'B', POP: 3, RATIO: 2.5, box: [200, 200, 100] },
  { NAME: 'B2', TYPE: 'B', POP: 4, RATIO: 3.5, box: [0, 0, 10] },
];

let dir = '';
let store = null;
let shp = '';
let geoShp = '';

/** 造一份米制投影的面数据。 */
async function makeFixture() {
  const src = join(dir, 'src');
  await mkdir(src, { recursive: true });
  const geojson = join(src, 'plots.geojson');
  await writeFile(
    geojson,
    JSON.stringify({
      type: 'FeatureCollection',
      features: ROWS.map((r) => {
        const [x, y, s] = r.box;
        return {
          type: 'Feature',
          properties: { NAME: r.NAME, TYPE: r.TYPE, POP: r.POP, RATIO: r.RATIO },
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

/** 同一份数据，但标成经纬度（EPSG:4326）。坐标缩小到度的量级（米 → 度，看着才合理）。 */
async function makeGeographicFixture() {
  const src = join(dir, 'src');
  await mkdir(src, { recursive: true });
  const geojson = join(src, 'plots-geo.geojson');
  await writeFile(
    geojson,
    JSON.stringify({
      type: 'FeatureCollection',
      features: ROWS.map((r) => {
        const [x, y, s] = r.box;
        const k = 1 / 1000;
        return {
          type: 'Feature',
          properties: { NAME: r.NAME, TYPE: r.TYPE, POP: r.POP, RATIO: r.RATIO },
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [x * k, y * k], [(x + s) * k, y * k], [(x + s) * k, (y + s) * k],
              [x * k, (y + s) * k], [x * k, y * k],
            ]],
          },
        };
      }),
    }),
    'utf8',
  );
  const res = await gdal.ogr2ogr([
    '-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', '-a_srs', 'EPSG:4326', geoShp, geojson,
  ]);
  assert.ok(res.ok, `造 Shapefile 失败：${res.stderr}`);
}

/** 找出某一组的行。 */
function groupOf(res, type) {
  const row = res.data.rows.find((r) => r.TYPE === type);
  assert.ok(row, `结果里没有 ${type} 这一组`);
  return row;
}

before(async () => {
  if (!loc) return;
  dir = await mkdtemp(join(TMP_BASE, 'cartouche-feature-sum-'));
  shp = join(dir, 'plots.shp');
  geoShp = join(dir, 'plots-geo.shp');
  store = new LocalFolderStore(dir);
  await makeFixture();
  await makeGeographicFixture();
});

beforeEach(async () => {
  if (!loc) return;
  await makeFixture();
  await makeGeographicFixture();
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/* ── 基本行为 ──────────────────────────────────────────────── */

test('feature.summarize：结果形状与非栅格型 op 一致', async () => {
  const res = await runFeatureSummarize(
    { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['count'] },
    { loc, store },
  );
  assert.equal(res.kind, 'value');
  assert.ok(res.summary.length > 0);
  assert.equal(res.outputPath, undefined, '汇总不产出文件');
  assert.equal(res.data.groupCount, 2);
  assert.equal(res.data.featureCount, 4);
  assert.deepEqual(res.data.groupBy, ['TYPE']);
});

test('feature.summarize：按字段分组，每组一行', async () => {
  const res = await runFeatureSummarize(
    { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['count'] },
    { loc, store },
  );
  assert.equal(res.data.rows.length, 2);
  assert.equal(groupOf(res, 'A').count, 2);
  assert.equal(groupOf(res, 'B').count, 2);
});

test('feature.summarize：sum / mean / min / max 逐个数值列算', async () => {
  const res = await runFeatureSummarize(
    { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['sum', 'mean', 'min', 'max'] },
    { loc, store },
  );
  const a = groupOf(res, 'A');
  assert.equal(a.sum_POP, 3);
  assert.equal(a.mean_POP, 1.5);
  assert.equal(a.min_POP, 1);
  assert.equal(a.max_POP, 2);
  assert.equal(a.sum_RATIO, 2);
  const b = groupOf(res, 'B');
  assert.equal(b.sum_POP, 7);
  assert.equal(b.mean_POP, 3.5);
});

test('feature.summarize：分组字段本身不参与逐列统计', async () => {
  const res = await runFeatureSummarize(
    { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['sum'] },
    { loc, store },
  );
  assert.ok(!res.data.columns.includes('sum_TYPE'), '分组字段是键，不该被当成被统计的量');
});

test('feature.summarize：distinct 逐列去重计数', async () => {
  const res = await runFeatureSummarize(
    { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['distinct'] },
    { loc, store },
  );
  const a = groupOf(res, 'A');
  assert.equal(a.distinct_NAME, 2);
  assert.equal(a.distinct_POP, 2);
  assert.equal(a.distinct_RATIO, 2);
});

test('feature.summarize：多个分组字段', async () => {
  const res = await runFeatureSummarize(
    { target: 'dataset://plots.shp', groupBy: ['TYPE', 'NAME'], aggregates: ['count'] },
    { loc, store },
  );
  assert.equal(res.data.groupCount, 4, '两个字段分组就是四个组');
});

/* ── 面积与单位 ────────────────────────────────────────────── */

test('feature.summarize：面积按 areaUnit 换算', async () => {
  const res = await runFeatureSummarize(
    { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['area'], areaUnit: 'm2' },
    { loc, store },
  );
  assert.equal(groupOf(res, 'A').area, 12500, 'A 类面积 = 10000 + 2500');
  assert.equal(groupOf(res, 'B').area, 10100, 'B 类面积 = 10000 + 100');
});

test('feature.summarize：面积单位换成公顷 / 亩 / 平方公里', async () => {
  const ha = await runFeatureSummarize(
    { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['area'], areaUnit: 'ha' },
    { loc, store },
  );
  assert.equal(groupOf(ha, 'A').area, 1.25, '12500 m² = 1.25 公顷');

  const mu = await runFeatureSummarize(
    { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['area'], areaUnit: 'mu' },
    { loc, store },
  );
  assert.equal(groupOf(mu, 'A').area, 1.875, '12500 m² = 1.875 亩');

  const km2 = await runFeatureSummarize(
    { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['area'], areaUnit: 'km2' },
    { loc, store },
  );
  assert.equal(groupOf(km2, 'A').area, 0.0125, '12500 m² = 0.0125 km²');
});

test('feature.summarize：算面积不给 areaUnit 要报错（不能默默用默认单位）', async () => {
  await assert.rejects(
    () =>
      runFeatureSummarize(
        { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['area'] },
        { loc, store },
      ),
    /areaUnit/,
  );
});

test('feature.summarize：不认识的面积单位要报错', async () => {
  await assert.rejects(
    () =>
      runFeatureSummarize(
        { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['area'], areaUnit: 'acre' },
        { loc, store },
      ),
    /面积单位/,
  );
});

test('feature.summarize：经纬度图层算面积要报错', async () => {
  await assert.rejects(
    () =>
      runFeatureSummarize(
        { target: 'dataset://plots-geo.shp', groupBy: ['TYPE'], aggregates: ['area'], areaUnit: 'm2' },
        { loc, store },
      ),
    /经纬度|投影/,
  );
});

test('feature.summarize：长度按面的周长算，单位是图层的坐标单位', async () => {
  const res = await runFeatureSummarize(
    { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['length'] },
    { loc, store },
  );
  assert.equal(groupOf(res, 'A').length, 600, 'A 类周长 = 400 + 200');
  assert.equal(groupOf(res, 'B').length, 440, 'B 类周长 = 400 + 40');
  assert.equal(res.data.lengthUnit, '米');
});

test('feature.summarize：经纬度图层的长度要说清单位是度', async () => {
  const res = await runFeatureSummarize(
    { target: 'dataset://plots-geo.shp', groupBy: ['TYPE'], aggregates: ['length'] },
    { loc, store },
  );
  assert.equal(res.data.lengthUnit, '度');
  assert.ok(
    res.data.caveats.some((c) => c.includes('度')),
    '经纬度下的长度必须说清单位是度',
  );
  // 同一批面，坐标缩到度的量级：周长 600 m → 0.6°
  assert.equal(groupOf(res, 'A').length, 0.6);
});

/* ── 预演与落盘 ────────────────────────────────────────────── */

test('feature.summarize：预演不写盘', async () => {
  const before = await readFeatures(loc, { path: shp });
  const res = await runFeatureSummarize(
    { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['count'] },
    { loc, store },
    true,
  );
  assert.equal(res.data.dryRun, true);
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.features.length, before.features.length);
  assert.deepEqual(
    after.features.map((f) => f.properties.POP),
    before.features.map((f) => f.properties.POP),
    '汇总不该动数据',
  );
});

/* ── 出错必须说清 ──────────────────────────────────────────── */

test('feature.summarize：分组列不存在要报错', async () => {
  await assert.rejects(
    () =>
      runFeatureSummarize(
        { target: 'dataset://plots.shp', groupBy: ['NOPE'], aggregates: ['count'] },
        { loc, store },
      ),
    /NOPE/,
  );
});

test('feature.summarize：不认识的统计项要报错', async () => {
  await assert.rejects(
    () =>
      runFeatureSummarize(
        { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['median'] },
        { loc, store },
      ),
    /median/,
  );
});

test('feature.summarize：缺参数要报错', async () => {
  await assert.rejects(
    () => runFeatureSummarize({ groupBy: ['TYPE'], aggregates: ['count'] }, { loc, store }),
    /target/,
  );
  await assert.rejects(
    () => runFeatureSummarize({ target: 'dataset://plots.shp', aggregates: ['count'] }, { loc, store }),
    /groupBy/,
  );
  await assert.rejects(
    () => runFeatureSummarize({ target: 'dataset://plots.shp', groupBy: ['TYPE'] }, { loc, store }),
    /aggregates/,
  );
});

test('feature.summarize：绝对路径的 target 要被路径闸门挡掉', async () => {
  await assert.rejects(
    () =>
      runFeatureSummarize(
        { target: 'C:/Windows/System32/drivers/etc/hosts', groupBy: ['TYPE'], aggregates: ['count'] },
        { loc, store },
      ),
    /相对路径/,
  );
});

test('feature.summarize：给了 where 要报错（契约里没有这一项）', async () => {
  await assert.rejects(
    () =>
      runFeatureSummarize(
        { target: 'dataset://plots.shp', groupBy: ['TYPE'], aggregates: ['count'], where: "TYPE = 'A'" },
        { loc, store },
      ),
    /where/,
  );
});
