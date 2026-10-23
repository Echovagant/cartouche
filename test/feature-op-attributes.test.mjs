/**
 * feature.setAttributes：按条件批量改属性。
 *
 * 这个 op 的价值在于"批量"：条件命中一批要素，一次改完。
 * 所以测试的重点是三件事：
 *  1. 改的值真的写进文件了（不是只在内存里算了一遍）；
 *  2. 没命中的要素一个都没动（改多一条就是数据事故）；
 *  3. 出错时说得清是哪一列、哪个值、为什么 —— 不许静默跳过。
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
const { readFeatures, probeLayer } = await import(eng('vector/read.ts'));
const { runFeatureSetAttributes } = await import(eng('feature/attributes.ts'));

const loc = resolveGdal();
const gdal = tools(loc);
const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || tmpdir();

const FEATURES = [
  { NAME: '甲', POP: 100, RATIO: 1.5, STATUS: '待核查' },
  { NAME: '乙', POP: 200, RATIO: 2.5, STATUS: '待核查' },
  { NAME: '丙', POP: 300, RATIO: 3.5, STATUS: '已核查' },
  { NAME: '丁', POP: 400, RATIO: 4.5, STATUS: '已核查' },
];

let dir = '';
let store = null;
let shp = '';

/** 重建一份干净的 Shapefile（每个用例都从同一份数据开始）。 */
async function makeFixture() {
  const src = join(dir, 'src');
  await mkdir(src, { recursive: true });
  const geojson = join(src, 'cities.geojson');
  await writeFile(
    geojson,
    JSON.stringify({
      type: 'FeatureCollection',
      features: FEATURES.map((p, i) => ({
        type: 'Feature',
        properties: p,
        geometry: { type: 'Point', coordinates: [120 + i * 0.01, 30 + i * 0.01] },
      })),
    }),
    'utf8',
  );
  const res = await gdal.ogr2ogr([
    '-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', shp, geojson,
  ]);
  assert.ok(res.ok, `造 Shapefile 失败：${res.stderr}`);
}

before(async () => {
  if (!loc) return;
  dir = await mkdtemp(join(TMP_BASE, 'cartouche-feature-attr-'));
  shp = join(dir, 'cities.shp');
  store = new LocalFolderStore(dir);
  await makeFixture();
});

beforeEach(async () => {
  if (!loc) return;
  await makeFixture();
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/* ── 基本行为 ──────────────────────────────────────────────── */

test('feature.setAttributes：结果形状与非栅格型 op 一致', async () => {
  const res = await runFeatureSetAttributes(
    { target: 'dataset://cities.shp', where: "STATUS = '待核查'", set: { STATUS: '已核查' } },
    { loc, store },
  );
  assert.equal(res.kind, 'value');
  assert.equal(typeof res.summary, 'string');
  assert.ok(res.summary.length > 0, '摘要不能是空串');
  assert.equal(res.outputPath, undefined, '改属性不产出新文件');
  assert.equal(res.data.updated, 2);
  assert.equal(res.data.total, 4);
  assert.deepEqual(res.data.fields, ['STATUS']);
});

test('feature.setAttributes：值真的写进文件了', async () => {
  await runFeatureSetAttributes(
    { target: 'dataset://cities.shp', where: "STATUS = '待核查'", set: { STATUS: '已核查' } },
    { loc, store },
  );
  const after = await readFeatures(loc, { path: shp });
  assert.deepEqual(
    after.features.map((f) => f.properties.STATUS),
    ['已核查', '已核查', '已核查', '已核查'],
  );
});

test('feature.setAttributes：没命中的要素一个都不动', async () => {
  await runFeatureSetAttributes(
    { target: 'dataset://cities.shp', where: 'POP > 250', set: { RATIO: 99 } },
    { loc, store },
  );
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.features[0].properties.RATIO, 1.5, '没命中的要素不该被改');
  assert.equal(after.features[1].properties.RATIO, 2.5, '没命中的要素不该被改');
  assert.equal(after.features[2].properties.RATIO, 99);
  assert.equal(after.features[3].properties.RATIO, 99);
});

test('feature.setAttributes：人话条件也能用', async () => {
  const res = await runFeatureSetAttributes(
    { target: 'dataset://cities.shp', where: 'POP 大于 250', set: { RATIO: 0 } },
    { loc, store },
  );
  assert.equal(res.data.updated, 2);
});

test('feature.setAttributes：一次改多个字段', async () => {
  const res = await runFeatureSetAttributes(
    {
      target: 'dataset://cities.shp',
      where: 'POP > 250',
      set: { RATIO: 7, STATUS: '复查' },
    },
    { loc, store },
  );
  assert.equal(res.data.updated, 2);
  assert.deepEqual(res.data.fields, ['RATIO', 'STATUS']);
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.features[2].properties.RATIO, 7);
  assert.equal(after.features[2].properties.STATUS, '复查');
  assert.equal(after.features[0].properties.STATUS, '待核查');
});

test('feature.setAttributes：写回之后原文件有备份', async () => {
  const res = await runFeatureSetAttributes(
    { target: 'dataset://cities.shp', where: 'POP > 0', set: { RATIO: 1 } },
    { loc, store },
  );
  assert.ok(res.data.backupPath, '写回必须留下备份');
});

test('feature.setAttributes：坐标系没丢，列也都在', async () => {
  const before = await probeLayer(loc, shp);
  await runFeatureSetAttributes(
    { target: 'dataset://cities.shp', where: 'POP > 0', set: { RATIO: 1 } },
    { loc, store },
  );
  const after = await probeLayer(loc, shp);
  assert.equal(after.epsg, before.epsg, '写回之后坐标系变了');
  assert.equal(after.featureCount, 4, '要素数不该变');
  assert.deepEqual(
    after.fields.map((f) => f.name).sort(),
    before.fields.map((f) => f.name).sort(),
    '写回之后原来的列都还在',
  );
});

/* ── 预演 ──────────────────────────────────────────────────── */

test('feature.setAttributes：预演不写盘，并说清会改多少条', async () => {
  const before = await readFeatures(loc, { path: shp });
  const res = await runFeatureSetAttributes(
    { target: 'dataset://cities.shp', where: 'POP > 250', set: { RATIO: 42 } },
    { loc, store },
    true,
  );
  assert.equal(res.data.dryRun, true);
  assert.equal(res.data.updated, 2);
  assert.match(res.summary, /2/);
  const after = await readFeatures(loc, { path: shp });
  assert.deepEqual(
    after.features.map((f) => f.properties.RATIO),
    before.features.map((f) => f.properties.RATIO),
    '预演不能改文件',
  );
});

test('feature.setAttributes：预演要说清会变成什么', async () => {
  const res = await runFeatureSetAttributes(
    { target: 'dataset://cities.shp', where: 'POP > 250', set: { STATUS: '复查' } },
    { loc, store },
    true,
  );
  assert.equal(res.data.values.STATUS, '复查');
  assert.ok(Array.isArray(res.data.samples) && res.data.samples.length > 0, '预演要给出样例');
  assert.equal(res.data.samples[0].values.STATUS, '复查');
});

/* ── 出错必须说清 ──────────────────────────────────────────── */

test('feature.setAttributes：条件命中 0 条要报错，不能当成功', async () => {
  await assert.rejects(
    () =>
      runFeatureSetAttributes(
        { target: 'dataset://cities.shp', where: 'POP > 99999', set: { RATIO: 1 } },
        { loc, store },
      ),
    /0 条命中/,
  );
});

test('feature.setAttributes：set 里的列不存在要报错，并列出真有的列', async () => {
  await assert.rejects(
    () =>
      runFeatureSetAttributes(
        { target: 'dataset://cities.shp', where: 'POP > 0', set: { NOPE: 1 } },
        { loc, store },
      ),
    /NOPE/,
  );
});

test('feature.setAttributes：条件里的列不存在要报错', async () => {
  await assert.rejects(
    () =>
      runFeatureSetAttributes(
        { target: 'dataset://cities.shp', where: 'NOPE > 0', set: { RATIO: 1 } },
        { loc, store },
      ),
    /NOPE/,
  );
});

test('feature.setAttributes：缺参数要报错', async () => {
  await assert.rejects(
    () => runFeatureSetAttributes({ where: 'POP > 0', set: { RATIO: 1 } }, { loc, store }),
    /target/,
  );
  await assert.rejects(
    () => runFeatureSetAttributes({ target: 'dataset://cities.shp', set: { RATIO: 1 } }, { loc, store }),
    /where/,
  );
  await assert.rejects(
    () => runFeatureSetAttributes({ target: 'dataset://cities.shp', where: 'POP > 0' }, { loc, store }),
    /set/,
  );
});

test('feature.setAttributes：绝对路径的 target 要被路径闸门挡掉', async () => {
  await assert.rejects(
    () =>
      runFeatureSetAttributes(
        { target: 'C:/Windows/System32/drivers/etc/hosts', where: 'POP > 0', set: { RATIO: 1 } },
        { loc, store },
      ),
    /相对路径/,
  );
});

test('feature.setAttributes：往数字列写文字要报错', async () => {
  await assert.rejects(
    () =>
      runFeatureSetAttributes(
        { target: 'dataset://cities.shp', where: 'POP > 0', set: { POP: '很多' } },
        { loc, store },
      ),
    /数字列/,
  );
});

test('feature.setAttributes：值说不清要报错', async () => {
  await assert.rejects(
    () =>
      runFeatureSetAttributes(
        { target: 'dataset://cities.shp', where: 'POP > 0', set: { RATIO: { a: 1 } } },
        { loc, store },
      ),
    /说不清/,
  );
});

test('feature.setAttributes：往文字列写数字要写成文字', async () => {
  await runFeatureSetAttributes(
    { target: 'dataset://cities.shp', where: 'POP > 0', set: { NAME: 123 } },
    { loc, store },
  );
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.features[0].properties.NAME, '123');
});

/* ── Shapefile 列名截断 ────────────────────────────────────── */

test('feature.setAttributes：列名被 Shapefile 截断时，按全名也能改', async () => {
  // LONG_FIELD_NAME 有 15 字节，Shapefile 的列名上限是 10 字节 → 文件里存的是 LONG_FIELD
  const longShp = join(dir, 'longname.shp');
  const geojson = join(dir, 'src', 'longname.geojson');
  await writeFile(
    geojson,
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { LONG_FIELD_NAME: '甲' },
          geometry: { type: 'Point', coordinates: [1, 1] },
        },
        {
          type: 'Feature',
          properties: { LONG_FIELD_NAME: '乙' },
          geometry: { type: 'Point', coordinates: [2, 2] },
        },
      ],
    }),
    'utf8',
  );
  const made = await gdal.ogr2ogr([
    '-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', longShp, geojson,
  ]);
  assert.ok(made.ok, `造 Shapefile 失败：${made.stderr}`);

  const info = await probeLayer(loc, longShp);
  const actual = info.fields.map((f) => f.name);
  assert.equal(actual.length, 1);
  assert.ok(
    Buffer.byteLength(actual[0], 'utf8') <= 10,
    `Shapefile 的列名应当被截断到 10 字节以内，实际是 ${actual[0]}`,
  );

  // 按截断前的全名指定 → 引擎要认得出来，并说清被截断成了什么
  const res = await runFeatureSetAttributes(
    { target: 'dataset://longname.shp', where: '1 = 1', set: { LONG_FIELD_NAME: '改过' } },
    { loc, store },
  );
  assert.equal(res.data.updated, 2);
  assert.match(res.summary, /截断/);
  const after = await readFeatures(loc, { path: longShp });
  assert.deepEqual(after.features.map((f) => f.properties[actual[0]]), ['改过', '改过']);
});

/* ── 表达式值 ──────────────────────────────────────────────── */

test('feature.setAttributes：整数列里的小数要取整，并说清楚', async () => {
  const res = await runFeatureSetAttributes(
    { target: 'dataset://cities.shp', where: 'POP = 100', set: { POP: 2.5 } },
    { loc, store },
  );
  assert.match(res.summary, /四舍五入/);
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.features[0].properties.POP, 3, '整数列里的 2.5 取整成 3');
  const info = await probeLayer(loc, shp);
  const pop = info.fields.find((f) => f.name === 'POP');
  assert.match(pop.type, /Integer/i, '整数列不能因为写了小数就变成小数列');
});

test('feature.setAttributes：整层改成整数会让小数列变成整数列，要说出来', async () => {
  const res = await runFeatureSetAttributes(
    { target: 'dataset://cities.shp', where: 'POP > 0', set: { RATIO: 1 } },
    { loc, store },
  );
  assert.match(res.summary, /类型/);
  assert.match(res.summary, /RATIO/);
});
test('feature.setAttributes：set 里可以用表达式逐条算', async () => {
  const res = await runFeatureSetAttributes(
    {
      target: 'dataset://cities.shp',
      where: 'POP > 0',
      set: { RATIO: { expression: 'POP / 100' } },
    },
    { loc, store },
  );
  assert.equal(res.data.updated, 4);
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.features[0].properties.RATIO, 1);
  assert.equal(after.features[3].properties.RATIO, 4);
});

test('feature.setAttributes：表达式用不存在的列要报错', async () => {
  await assert.rejects(
    () =>
      runFeatureSetAttributes(
        {
          target: 'dataset://cities.shp',
          where: 'POP > 0',
          set: { RATIO: { expression: 'NOPE + 1' } },
        },
        { loc, store },
      ),
    /NOPE/,
  );
});
