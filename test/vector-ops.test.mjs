/**
 * 两个 op 的参数与结果形状：vector.query / vector.addField。
 *
 * 结果形状必须与已经落地的 dataset.* op 完全一致（kind/summary/data）——
 * 那条路是确认卡与报告已经在吃的形状，形状不一样就等于多一条分支。
 *
 * 注意：这两个 op 目前**还没有登记进 ops/executor.ts**（登记由主会话统一做，
 * 两边并行改同一个文件会冲突）。这里直接调实现来验。
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
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { readFeatures } = await import(eng('vector/read.ts'));
const { runVectorQuery } = await import(eng('vector/query.ts'));
const { runVectorAddField } = await import(eng('vector/field.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || tmpdir();

const FEATURES = [
  { NAME: 'Beijing', POP2020: 1000, RATIO: 1.5 },
  { NAME: 'Shanghai', POP2020: 2000, RATIO: 2.5 },
  { NAME: 'Beijing West', POP2020: 3000, RATIO: 3.5 },
];

let dir = '';
let shp = '';
let store = null;

before(async () => {
  if (!loc) return;
  dir = await mkdtemp(join(TMP_BASE, 'cartouche-vector-ops-'));
  shp = join(dir, 'cities.shp');
  const geojson = join(dir, 'cities.geojson');
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
  const res = await gdal.ogr2ogr(['-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', shp, geojson]);
  assert.ok(res.ok, `造 Shapefile 失败：${res.stderr}`);
  store = new LocalFolderStore(dir);
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/* ── vector.query ─────────────────────────────────────────── */

test('vector.query：结果形状与非栅格型 op 一致', async () => {
  const res = await runVectorQuery({ target: 'dataset://cities.shp' }, { loc, store });
  assert.equal(res.kind, 'value');
  assert.equal(typeof res.summary, 'string');
  assert.ok(res.summary.length > 0, '摘要不能是空串');
  assert.equal(res.outputPath, undefined, '查询不产出文件，不该有 outputPath');
  const data = res.data;
  assert.equal(data.featureCount, 3);
  assert.equal(data.totalCount, 3);
  assert.equal(data.truncated, false);
  assert.equal(Array.isArray(data.features), true);
  assert.equal(data.features.length, 3);
  // 要素的形状：{ properties, geometry }
  const first = data.features[0];
  assert.equal(first.properties.NAME, 'Beijing');
  assert.equal(first.geometry.type, 'Point');
});

test('vector.query：条件（SQL）生效', async () => {
  const res = await runVectorQuery(
    { target: 'dataset://cities.shp', where: 'POP2020 > 1500' },
    { loc, store },
  );
  assert.equal(res.data.featureCount, 2);
  assert.deepEqual(res.data.features.map((f) => f.properties.NAME), ['Shanghai', 'Beijing West']);
});

test('vector.query：条件（人话）生效', async () => {
  const res = await runVectorQuery(
    { target: 'dataset://cities.shp', where: 'POP2020 大于 1500' },
    { loc, store },
  );
  assert.equal(res.data.featureCount, 2);
});

test('vector.query：选列与限量生效', async () => {
  const res = await runVectorQuery(
    { target: 'dataset://cities.shp', fields: ['NAME'], limit: 2 },
    { loc, store },
  );
  assert.equal(res.data.featureCount, 2);
  assert.equal(res.data.totalCount, 3);
  assert.equal(res.data.truncated, true);
  assert.deepEqual(Object.keys(res.data.features[0].properties), ['NAME']);
});

test('vector.query：摘要里要说清查到了多少条', async () => {
  const res = await runVectorQuery({ target: 'dataset://cities.shp' }, { loc, store });
  assert.match(res.summary, /3/);
});

test('vector.query：缺 target 要报错', async () => {
  await assert.rejects(() => runVectorQuery({}, { loc, store }), /target/);
});

test('vector.query：绝对路径的 target 要被路径闸门挡掉', async () => {
  await assert.rejects(
    () => runVectorQuery({ target: 'C:/Windows/System32/drivers/etc/hosts' }, { loc, store }),
    /相对路径/,
  );
});

test('vector.query：layer:// 引用不是文件路径，要报错', async () => {
  await assert.rejects(
    () => runVectorQuery({ target: 'layer://2024_basemap' }, { loc, store }),
    /不是文件路径/,
  );
});

test('vector.query：limit 不是正整数要报错', async () => {
  await assert.rejects(
    () => runVectorQuery({ target: 'dataset://cities.shp', limit: 0 }, { loc, store }),
    /limit/,
  );
});

/* ── vector.addField ──────────────────────────────────────── */

test('vector.addField：结果形状与参数契约一致', async () => {
  const res = await runVectorAddField(
    { target: 'dataset://cities.shp', name: 'HALF', expression: 'POP2020 / 2' },
    { loc, store },
  );
  assert.equal(res.kind, 'value');
  assert.match(res.summary, /HALF/);
  assert.equal(res.data.fieldName, 'HALF');
  assert.equal(res.data.updated, 3);
  assert.equal(res.data.total, 3);
});

test('vector.addField：写完之后这一列真的在文件里，值也对', async () => {
  await runVectorAddField(
    { target: 'dataset://cities.shp', name: 'DOUBLE', expression: 'POP2020 * 2' },
    { loc, store },
  );
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.features[0].properties.DOUBLE, 2000);
  assert.equal(after.features[2].properties.DOUBLE, 6000);
});

test('vector.addField：条件只对符合条件的要素赋值，其余留空', async () => {
  await runVectorAddField(
    {
      target: 'dataset://cities.shp',
      name: 'BIGONLY',
      expression: "'是'",
      where: 'POP2020 大于 1500',
    },
    { loc, store },
  );
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.features[0].properties.BIGONLY, null, '没命中的要素应当留空');
  assert.equal(after.features[1].properties.BIGONLY, '是');
  assert.equal(after.features[2].properties.BIGONLY, '是');
});

test('vector.addField：人话表达式也能用', async () => {
  const res = await runVectorAddField(
    { target: 'dataset://cities.shp', name: 'UPPERNAME', expression: "UPPER(NAME)" },
    { loc, store },
  );
  assert.equal(res.data.updated, 3);
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.features[0].properties.UPPERNAME, 'BEIJING');
});

test('vector.addField：写回后原文件有备份', async () => {
  const res = await runVectorAddField(
    { target: 'dataset://cities.shp', name: 'BACKUPCHK', expression: '1' },
    { loc, store },
  );
  assert.ok(res.data.backupPath, '写回必须留下备份');
});

test('vector.addField：列名已存在要报错（不能默默覆盖）', async () => {
  await assert.rejects(
    () =>
      runVectorAddField(
        { target: 'dataset://cities.shp', name: 'NAME', expression: '1' },
        { loc, store },
      ),
    /已经有/,
  );
});

test('vector.addField：缺参数要报错', async () => {
  await assert.rejects(() => runVectorAddField({ name: 'X', expression: '1' }, { loc, store }), /target/);
  await assert.rejects(
    () => runVectorAddField({ target: 'dataset://cities.shp', expression: '1' }, { loc, store }),
    /name/,
  );
  await assert.rejects(
    () => runVectorAddField({ target: 'dataset://cities.shp', name: 'X' }, { loc, store }),
    /expression/,
  );
});

test('vector.addField：表达式里用了不存在的列要报错', async () => {
  await assert.rejects(
    () =>
      runVectorAddField(
        { target: 'dataset://cities.shp', name: 'X', expression: 'NOPE + 1' },
        { loc, store },
      ),
    /NOPE/,
  );
});

test('vector.addField：人话翻不了要报错（不许猜）', async () => {
  await assert.rejects(
    () =>
      runVectorAddField(
        { target: 'dataset://cities.shp', name: 'X', expression: 'POP2020 超出 100' },
        { loc, store },
      ),
    /没看懂/,
  );
});
