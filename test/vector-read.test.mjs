/**
 * 矢量要素读取：GeoJSON 与 Shapefile 各一份。
 *
 * 盯的是四件事：
 *  1. 两种格式都能读出要素与几何；
 *  2. 条件筛选生效（SQL 与人话两条路）；
 *  3. 选列与限量生效，totalCount 仍然是真总数；
 *  4. 出错的地方要说得清（哪个文件、缺哪一列）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { readFeatures, probeLayer } = await import(eng('vector/read.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

/**
 * 临时目录位置。
 *
 * 默认走系统临时目录（与仓库里其它测试同一套做法，保证换台机器也跑得起来）。
 * 这台机器的 C 盘空间紧张，跑测试时可以用 CARTOUCHE_TEST_TMP 指到 D 盘。
 */
const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || tmpdir();

const FEATURES = [
  { NAME: 'Beijing', POP2020: 1000, RATIO: 1.5 },
  { NAME: 'Shanghai', POP2020: 2000, RATIO: 2.5 },
  { NAME: 'Beijing West', POP2020: 3000, RATIO: 3.5 },
];

let dir = '';
let geojson = '';
let shp = '';

before(async () => {
  if (!loc) return;
  dir = await mkdtemp(join(TMP_BASE, 'cartouche-vector-read-'));
  geojson = join(dir, 'cities.geojson');
  shp = join(dir, 'cities.shp');
  await writeFile(
    geojson,
    JSON.stringify({
      type: 'FeatureCollection',
      features: FEATURES.map((p, i) => ({
        type: 'Feature',
        properties: p,
        geometry: { type: 'Point', coordinates: [120.3 + i * 0.01, 30.5 + i * 0.01] },
      })),
    }),
    'utf8',
  );
  // 由 GeoJSON 转成 Shapefile：顺带验证写回路径上的驱动选择
  const res = await gdal.ogr2ogr(['-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', shp, geojson]);
  assert.ok(res.ok, `造 Shapefile 失败：${res.stderr}`);
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('读 GeoJSON：要素、属性与几何都在', async () => {
  const r = await readFeatures(loc, { path: geojson });
  assert.equal(r.featureCount, 3);
  assert.equal(r.totalCount, 3);
  assert.equal(r.truncated, false);
  assert.equal(r.features[0].properties.NAME, 'Beijing');
  assert.equal(r.features[0].geometry.type, 'Point');
  assert.deepEqual(r.features[0].geometry.coordinates, [120.3, 30.5]);
});

test('读 Shapefile：要素、属性与几何都在', async () => {
  const r = await readFeatures(loc, { path: shp });
  assert.equal(r.featureCount, 3);
  assert.equal(r.features[0].properties.NAME, 'Beijing');
  assert.equal(r.features[0].geometry.type, 'Point');
});

test('图层结构能探出来（列名、要素数、坐标系）', async () => {
  const info = await probeLayer(loc, shp);
  assert.equal(info.featureCount, 3);
  const names = info.fields.map((f) => f.name);
  assert.ok(names.includes('NAME'), `列名里应当有 NAME，实为 ${names.join('、')}`);
  assert.ok(names.includes('POP2020'));
  assert.equal(info.epsg, 4326);
});

test('条件筛选生效（SQL）', async () => {
  const r = await readFeatures(loc, { path: shp, where: 'POP2020 > 1500' });
  assert.equal(r.featureCount, 2);
  assert.equal(r.totalCount, 2);
  assert.deepEqual(r.features.map((f) => f.properties.NAME), ['Shanghai', 'Beijing West']);
});

test('条件筛选生效（人话）', async () => {
  const r = await readFeatures(loc, { path: shp, where: 'POP2020 大于 1500' });
  assert.equal(r.featureCount, 2);
  assert.deepEqual(r.features.map((f) => f.properties.NAME), ['Shanghai', 'Beijing West']);
});

test('条件里可以组合逻辑', async () => {
  const r = await readFeatures(loc, {
    path: shp,
    where: "POP2020 大于 1000 并且 NAME 包含 'Beijing'",
  });
  assert.equal(r.featureCount, 1);
  assert.equal(r.features[0].properties.NAME, 'Beijing West');
});

test('选列生效：只返回要的那几列', async () => {
  const r = await readFeatures(loc, { path: shp, fields: ['NAME'] });
  assert.deepEqual(Object.keys(r.features[0].properties), ['NAME']);
});

test('限量生效，但 totalCount 仍然是真总数', async () => {
  const r = await readFeatures(loc, { path: shp, limit: 2 });
  assert.equal(r.featureCount, 2);
  assert.equal(r.totalCount, 3);
  assert.equal(r.truncated, true);
});

test('有条件时限量作用在筛选之后', async () => {
  const r = await readFeatures(loc, { path: shp, where: 'POP2020 > 1000', limit: 1 });
  assert.equal(r.featureCount, 1);
  assert.equal(r.totalCount, 2);
  assert.equal(r.truncated, true);
});

test('条件命中 0 条：不是错，是空结果', async () => {
  const r = await readFeatures(loc, { path: shp, where: 'POP2020 > 99999' });
  assert.equal(r.featureCount, 0);
  assert.equal(r.totalCount, 0);
  assert.equal(r.truncated, false);
});

/* ── 反例 ─────────────────────────────────────────────────── */

test('文件不存在：要说清是哪个文件', async () => {
  await assert.rejects(
    () => readFeatures(loc, { path: join(dir, 'nope.shp') }),
    (err) => {
      assert.match(err.message, /nope\.shp/);
      assert.match(err.message, /不存在/);
      return true;
    },
  );
});

test('条件里用了不存在的列：要点名，并列出这一层有哪些列', async () => {
  await assert.rejects(
    () => readFeatures(loc, { path: shp, where: 'NOPE > 1' }),
    (err) => {
      assert.match(err.message, /NOPE/);
      assert.match(err.message, /POP2020/);
      return true;
    },
  );
});

test('选列里用了不存在的列：要报错，不能悄悄少给一列', async () => {
  await assert.rejects(
    () => readFeatures(loc, { path: shp, fields: ['NOPE'] }),
    (err) => {
      assert.match(err.message, /NOPE/);
      return true;
    },
  );
});

test('条件里拿文字比数字列：必须报错', async () => {
  await assert.rejects(
    () => readFeatures(loc, { path: shp, where: "POP2020 > 'abc'" }),
    (err) => {
      assert.match(err.message, /类型对不上|数字/);
      return true;
    },
  );
});

test('人话翻不了：明确说没看懂', async () => {
  await assert.rejects(
    () => readFeatures(loc, { path: shp, where: 'POP2020 超出 100' }),
    (err) => {
      assert.match(err.message, /没看懂/);
      return true;
    },
  );
});
