/**
 * 超大 GeoPackage keep=largest 的验收（原生 SQL 量算口径）。
 *
 * 普通路径的口径：有面按面积比（线、点算 0），没面只有线按长度比，
 * 平手留文件里先出现的那条。流式路径用 SpatiaLite 的 ST_Area / ST_Length
 * 在 SQL 里排序 —— 两个口径必须在"哪一条被留下"上完全一致。
 *
 * 每个用例用自己的文件副本：删除是有副作用的，共用夹具会互相污染。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { probeLayer, readFeatures } = await import(eng('vector/read.ts'));
const { gpkgStreamDelete } = await import(eng('vector/stream-gpkg-edit.ts'));
const { parseExpression } = await import(eng('expression/index.ts'));

const loc = resolveGdal();
if (!loc) throw new Error('本机没有 GDAL，这组用例跑不了');

const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || join(root, '.tmp-test');
let dir = '';

async function makeGpkg(name, features) {
  const geojson = join(dir, `${name}-base.geojson`);
  writeFileSync(geojson, JSON.stringify({ type: 'FeatureCollection', features }), 'utf8');
  const target = join(dir, `${name}-base.gpkg`);
  const res = await tools(loc).ogr2ogr(['-f', 'GPKG', '-a_srs', 'EPSG:3857', target, geojson]);
  assert.ok(res.ok, `造 GPKG 失败：${res.stderr}`);
}

/** 每个用例拿自己的副本：target 名 = 用例名 */
function copyGpkg(baseName, asName) {
  cpSync(join(dir, `${baseName}-base.gpkg`), join(dir, `${asName}.gpkg`));
  return `${asName}.gpkg`;
}

function square(x, y, size) {
  return {
    type: 'Polygon',
    coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]],
  };
}

function line(x1, y1, x2, y2) {
  return { type: 'LineString', coordinates: [[x1, y1], [x2, y2]] };
}

async function streamDelete(store, targetRel, whereSrc, keep) {
  const abs = store.resolve(targetRel);
  const info = await probeLayer(loc, abs);
  return gpkgStreamDelete(loc, store, {
    targetRel,
    absPath: abs,
    info,
    whereSource: whereSrc,
    whereNode: parseExpression(whereSrc),
    keep,
    dryRun: false,
  });
}

before(async () => {
  mkdirSync(TMP_BASE, { recursive: true });
  dir = mkdtempSync(join(TMP_BASE, 'cartouche-gpkg-largest-'));
  // 面：同组三块，面积 100 / 400 / 900；平手组两块都是 400
  await makeGpkg('poly', [
    { type: 'Feature', properties: { 组: 'A', 名: '小' }, geometry: square(0, 0, 10) },
    { type: 'Feature', properties: { 组: 'A', 名: '中' }, geometry: square(0, 0, 20) },
    { type: 'Feature', properties: { 组: 'A', 名: '大' }, geometry: square(0, 0, 30) },
    { type: 'Feature', properties: { 组: 'B', 名: '平1' }, geometry: square(0, 0, 20) },
    { type: 'Feature', properties: { 组: 'B', 名: '平2' }, geometry: square(0, 0, 20) },
  ]);
  // 线：同组两条，长度 10 / 50
  await makeGpkg('line', [
    { type: 'Feature', properties: { 组: 'L', 名: '短' }, geometry: line(0, 0, 10, 0) },
    { type: 'Feature', properties: { 组: 'L', 名: '长' }, geometry: line(0, 0, 50, 0) },
  ]);
  // 点：没有大小之分
  await makeGpkg('point', [
    { type: 'Feature', properties: { 组: 'P', 名: '点1' }, geometry: { type: 'Point', coordinates: [0, 0] } },
    { type: 'Feature', properties: { 组: 'P', 名: '点2' }, geometry: { type: 'Point', coordinates: [1, 1] } },
  ]);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('面图层 keep=largest：留面积最大的那条，其余删光', async () => {
  const store = new LocalFolderStore(dir);
  const targetRel = copyGpkg('poly', 'poly-max');
  const res = await streamDelete(store, targetRel, "组 = 'A'", 'largest');
  assert.equal(res.data.deleted, 2);
  assert.equal(res.data.remaining, 3);
  const after = await readFeatures(loc, { path: store.resolve(targetRel) });
  assert.equal(after.features.length, 3);
  assert.equal(after.features[0].properties['名'], '大', '应留下 900 m² 的那块');
});

test('平手时留文件里先出现的那条（与普通路径的顺序口径一致）', async () => {
  const store = new LocalFolderStore(dir);
  const targetRel = copyGpkg('poly', 'poly-tie');
  const res = await streamDelete(store, targetRel, "组 = 'B'", 'largest');
  assert.equal(res.data.deleted, 1);
  const after = await readFeatures(loc, { path: store.resolve(targetRel) });
  const names = after.features.map((f) => f.properties['名']);
  assert.ok(names.includes('平1'), `应保留先出现的「平1」，实际剩：${names.join('、')}`);
  assert.ok(!names.includes('平2'), '后出现的平手项应被删掉');
});

test('线图层 keep=largest：按长度比', async () => {
  const store = new LocalFolderStore(dir);
  const targetRel = copyGpkg('line', 'line-max');
  const res = await streamDelete(store, targetRel, "组 = 'L'", 'largest');
  assert.equal(res.data.deleted, 1);
  const after = await readFeatures(loc, { path: store.resolve(targetRel) });
  assert.equal(after.features[0].properties['名'], '长', '应留下 50 m 的那条线');
});

test('点图层 keep=largest：明确拒绝并给出替代方案，文件原样', async () => {
  const store = new LocalFolderStore(dir);
  const targetRel = copyGpkg('point', 'point-err');
  await assert.rejects(
    () => streamDelete(store, targetRel, "组 = 'P'", 'largest'),
    /没有大小之分/,
  );
  const after = await readFeatures(loc, { path: store.resolve(targetRel) });
  assert.equal(after.features.length, 2, '拒收之后一条都没删');
});

test('保留原因里带量算值（用户要能核对为什么留这条）', async () => {
  const store = new LocalFolderStore(dir);
  const targetRel = copyGpkg('poly', 'poly-reason');
  const res = await streamDelete(store, targetRel, "名 in ('大','中')", 'largest');
  assert.match(res.data.kept.reason, /面积/);
  assert.match(res.data.kept.reason, /900/);
});
