/**
 * vector.addField 的面积伪列 AREA。
 *
 * 盯住四件事：
 *   1. 投影坐标系下面要素的面积按平方米写进新列；
 *   2. 经纬度 / 没有坐标系 / 点线图层必须明确拒绝，不写一列 0；
 *   3. 图层本来就有 AREA 列时，真实列优先，不被伪列顶掉；
 *   4. AREA 在 where 条件里也能用（只给大面赋值）。
 *
 * 几何全部是构造数据（正方形），面积可以手算，不依赖任何真实数据。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { readFeatures } = await import(eng('vector/read.ts'));
const { runVectorAddField } = await import(eng('vector/field.ts'));

const loc = resolveGdal();
const gdal = loc ? tools(loc) : null;

let dir = '';
let store = null;

/** 一个轴对齐正方形（100m×100m 或 500m×500m），面积可手算 */
function square(x, y, size) {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [x, y],
        [x + size, y],
        [x + size, y + size],
        [x, y + size],
        [x, y],
      ],
    ],
  };
}

async function createLayer(name, features, srs) {
  const geojson = join(dir, `${name}.geojson`);
  await writeFile(
    geojson,
    JSON.stringify({
      type: 'FeatureCollection',
      features: features.map((f) => ({ type: 'Feature', ...f })),
    }),
    'utf8',
  );
  const shp = join(dir, `${name}.shp`);
  const args = ['-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8'];
  if (srs) args.push('-a_srs', srs);
  args.push(shp, geojson);
  const res = await gdal.ogr2ogr(args);
  assert.ok(res.ok, `造 ${name}.shp 失败：${res.stderr}`);
  return shp;
}

before(async () => {
  if (!loc) return;
  dir = await mkdtemp(join(tmpdir(), 'cartouche-addfield-area-'));
  store = new LocalFolderStore(dir);
  // 投影坐标系：米制，100×100 与 500×500 两个面
  await createLayer(
    'parcels',
    [
      { properties: { NAME: '小地块' }, geometry: square(500000, 3330000, 100) },
      { properties: { NAME: '大地块' }, geometry: square(500200, 3330000, 500) },
    ],
    'EPSG:32650',
  );
  // 经纬度：同样的坐标形状，但坐标系是度
  await createLayer(
    'geo',
    [{ properties: { NAME: '经纬度面' }, geometry: square(120.3, 30.5, 0.01) }],
    'EPSG:4326',
  );
  // 没有坐标系：把 .prj 删掉（Shapefile 靠它标坐标系）
  await createLayer(
    'nocrs',
    [{ properties: { NAME: '没坐标系' }, geometry: square(500000, 3330000, 100) }],
    'EPSG:32650',
  );
  rmSync(join(dir, 'nocrs.prj'), { force: true });
  // 点图层：没有面积
  await createLayer(
    'points',
    [{ properties: { NAME: '点' }, geometry: { type: 'Point', coordinates: [500000, 3330000] } }],
    'EPSG:32650',
  );
  // 自带 AREA 真实列：真实列必须优先
  await createLayer(
    'realarea',
    [{ properties: { NAME: '真实列', AREA: 7 }, geometry: square(500000, 3330000, 100) }],
    'EPSG:32650',
  );
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function skipIfNoGdal(t) {
  if (!loc) {
    t.skip('本机没有 GDAL');
    return true;
  }
  return false;
}

test('AREA：投影坐标系下面要素面积按平方米写进新列', async (t) => {
  if (skipIfNoGdal(t)) return;
  const res = await runVectorAddField(
    { target: 'dataset://parcels.shp', name: 'A_M2', expression: 'AREA' },
    { loc, store },
  );
  assert.match(res.summary, /平方米/, '摘要要说清 AREA 是平方米');
  const read = await readFeatures(loc, { path: join(dir, 'parcels.shp') });
  const values = read.features
    .map((f) => Number(f.properties.A_M2))
    .sort((a, b) => a - b);
  assert.equal(values.length, 2);
  assert.ok(Math.abs(values[0] - 10000) < 1e-6, `100×100 应为 10000，实际 ${values[0]}`);
  assert.ok(Math.abs(values[1] - 250000) < 1e-6, `500×500 应为 250000，实际 ${values[1]}`);
});

test('AREA：表达式里可以继续换算（AREA / 10000 = 公顷）', async (t) => {
  if (skipIfNoGdal(t)) return;
  await runVectorAddField(
    { target: 'dataset://parcels.shp', name: 'A_HA', expression: 'AREA / 10000' },
    { loc, store },
  );
  const read = await readFeatures(loc, { path: join(dir, 'parcels.shp') });
  const values = read.features
    .map((f) => Number(f.properties.A_HA))
    .sort((a, b) => a - b);
  assert.deepEqual(values, [1, 25], '10000m²=1ha，250000m²=25ha');
});

test('AREA：where 里也能用，只给大面赋值', async (t) => {
  if (skipIfNoGdal(t)) return;
  await runVectorAddField(
    {
      target: 'dataset://parcels.shp',
      name: 'BIG_AREA',
      expression: 'ROUND(AREA)',
      where: 'AREA > 20000',
    },
    { loc, store },
  );
  const read = await readFeatures(loc, { path: join(dir, 'parcels.shp') });
  const small = read.features.find((f) => Math.round(Number(f.properties.A_M2)) === 10000);
  const big = read.features.find((f) => Math.round(Number(f.properties.A_M2)) === 250000);
  assert.ok(
    small?.properties.BIG_AREA === null || small?.properties.BIG_AREA === '',
    `小地块不该被赋值，实际 ${JSON.stringify(small?.properties.BIG_AREA)}`,
  );
  assert.equal(Number(big?.properties.BIG_AREA), 250000);
});

test('AREA：预演只报面积口径，不写盘', async (t) => {
  if (skipIfNoGdal(t)) return;
  const res = await runVectorAddField(
    { target: 'dataset://parcels.shp', name: 'DRY_RUN', expression: 'AREA' },
    { loc, store },
    true,
  );
  assert.match(res.summary, /预演/);
  assert.match(res.summary, /平方米/);
  const read = await readFeatures(loc, { path: join(dir, 'parcels.shp') });
  assert.ok(
    read.features.every((f) => !('DRY_RUN' in f.properties)),
    '预演绝不能把列写进文件',
  );
});

test('AREA：经纬度图层明确拒绝，并告诉用户先重投影', async (t) => {
  if (skipIfNoGdal(t)) return;
  await assert.rejects(
    () =>
      runVectorAddField(
        { target: 'dataset://geo.shp', name: 'A_M2', expression: 'AREA' },
        { loc, store },
      ),
    /度²|投影/,
  );
});

test('AREA：没有坐标系的图层明确拒绝', async (t) => {
  if (skipIfNoGdal(t)) return;
  await assert.rejects(
    () =>
      runVectorAddField(
        { target: 'dataset://nocrs.shp', name: 'A_M2', expression: 'AREA' },
        { loc, store },
      ),
    /投影坐标系|坐标单位/,
  );
});

test('AREA：点图层没有面积，明确拒绝而不是写一列 0', async (t) => {
  if (skipIfNoGdal(t)) return;
  await assert.rejects(
    () =>
      runVectorAddField(
        { target: 'dataset://points.shp', name: 'A_M2', expression: 'AREA' },
        { loc, store },
      ),
    /点\/线要素/,
  );
});

test('AREA：图层本来就有 AREA 列时，真实列优先', async (t) => {
  if (skipIfNoGdal(t)) return;
  await runVectorAddField(
    { target: 'dataset://realarea.shp', name: 'COPY', expression: 'AREA' },
    { loc, store },
  );
  const read = await readFeatures(loc, { path: join(dir, 'realarea.shp') });
  assert.equal(Number(read.features[0]?.properties.COPY), 7, '不能拿几何面积顶掉真实列');
});

test('AREA：不用 AREA 的算式在经纬度图层上照常能算（别误伤）', async (t) => {
  if (skipIfNoGdal(t)) return;
  const res = await runVectorAddField(
    { target: 'dataset://geo.shp', name: 'NAME2', expression: 'NAME' },
    { loc, store },
  );
  assert.match(res.summary, /1 条要素赋了值/);
});
