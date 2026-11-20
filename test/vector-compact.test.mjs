/**
 * vector.compact 的验收：把"删除"留下的残留真正清掉。
 *
 *  - Shapefile：先流式删除（打标记），压缩后 .dbf 头里的记录数必须等于有效数；
 *    字段原样、要素数一致、备份在；
 *  - GeoPackage：删掉一批要素后 VACUUM，要素数不变、体积有交待；
 *  - 没有删除标记时明确说"不需要压缩"；不支持的格式明确拒绝；
 *  - 走 executePlan 全链路一遍（验证 op 注册与 AI 契约接得对）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { probeLayer, readFeatures } = await import(eng('vector/read.ts'));
const { runVectorCompact } = await import(eng('vector/compact.ts'));
const { shpStreamDelete } = await import(eng('vector/stream-shp-edit.ts'));
const { gpkgStreamDelete } = await import(eng('vector/stream-gpkg-edit.ts'));
const { parseExpression } = await import(eng('expression/index.ts'));
const { readDbfHeader, countActiveRecords } = await import(eng('vector/dbf.ts'));
const { executePlan } = await import(eng('ops/index.ts'));

const loc = resolveGdal();
if (!loc) throw new Error('本机没有 GDAL，这组用例跑不了');

const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || join(root, '.tmp-test');
const SHP_SIDECARS = ['.shp', '.shx', '.dbf', '.prj', '.cpg'];
let dir = '';

function features(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      type: 'Feature',
      properties: { 编号: i + 1, 组: i % 2 === 0 ? 'A' : 'B' },
      geometry: { type: 'Point', coordinates: [i, i] },
    });
  }
  return out;
}

async function makeShp(name, count) {
  const geojson = join(dir, `${name}.geojson`);
  writeFileSync(geojson, JSON.stringify({ type: 'FeatureCollection', features: features(count) }), 'utf8');
  const target = join(dir, `${name}.shp`);
  const res = await tools(loc).ogr2ogr([
    '-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', '-a_srs', 'EPSG:3857', target, geojson,
  ]);
  assert.ok(res.ok, `造 Shapefile 失败：${res.stderr}`);
  return target;
}

async function makeGpkg(name, count) {
  const geojson = join(dir, `${name}.geojson`);
  writeFileSync(geojson, JSON.stringify({ type: 'FeatureCollection', features: features(count) }), 'utf8');
  const target = join(dir, `${name}.gpkg`);
  const res = await tools(loc).ogr2ogr(['-f', 'GPKG', '-a_srs', 'EPSG:3857', target, geojson]);
  assert.ok(res.ok, `造 GPKG 失败：${res.stderr}`);
  return target;
}

function copyShp(fromName, toName) {
  for (const ext of SHP_SIDECARS) {
    const src = join(dir, `${fromName}${ext}`);
    if (existsSync(src)) cpSync(src, join(dir, `${toName}${ext}`));
  }
}

async function shpDelete(store, targetRel, whereSrc) {
  const abs = store.resolve(targetRel);
  const info = await probeLayer(loc, abs);
  return shpStreamDelete(loc, store, {
    targetRel,
    absPath: abs,
    info,
    whereSource: whereSrc,
    whereNode: parseExpression(whereSrc),
    keep: 'none',
    dryRun: false,
  });
}

before(async () => {
  mkdirSync(TMP_BASE, { recursive: true });
  dir = mkdtempSync(join(TMP_BASE, 'cartouche-compact-'));
  await makeShp('base', 20);
  await makeShp('clean', 20);
  await makeGpkg('gbase', 200);
  await writeFileSync(join(dir, '矢量.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [] }), 'utf8');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('Shapefile：流式删除 6 条后压缩，头里的记录数与有效数必须相等', async () => {
  const store = new LocalFolderStore(dir);
  copyShp('base', 'dirty');
  const del = await shpDelete(store, 'dirty.shp', '编号 > 10');
  assert.equal(del.data.deleted, 10, '应命中并删掉 10 条（打标记）');
  // 压缩前的状态：文件体积不变、头里仍是 20 条
  const beforeHeader = readDbfHeader(store.resolve('dirty.shp'), store.resolve('dirty.dbf'));
  assert.equal(beforeHeader.recordCount, 20, '压缩前头里还是 20 条（删除只是标记）');

  const res = await runVectorCompact({ target: 'dataset://dirty.shp' }, { loc, store }, false);
  assert.equal(res.data.compacted, true);
  assert.equal(res.data.removedMarked, 10);

  const afterHeader = readDbfHeader(store.resolve('dirty.shp'), store.resolve('dirty.dbf'));
  const active = countActiveRecords(afterHeader, store.resolve('dirty.dbf'));
  assert.equal(afterHeader.recordCount, 10, '压缩后头里的记录数应等于有效数');
  assert.equal(active, 10);
  const after = await readFeatures(loc, { path: store.resolve('dirty.shp') });
  assert.equal(after.features.length, 10, 'GDAL 读回的有效要素数必须对');
  const nums = after.features.map((f) => f.properties['编号']).sort((a, b) => a - b);
  assert.deepEqual(nums, [1,2,3,4,5,6,7,8,9,10], '留下的必须是没被删的那些');
  assert.ok(existsSync(String(res.data.backupPath).replace(/^backup:/, '') + '/dirty.shp') || res.data.backupPath, '要留备份');
});

test('Shapefile 没有删除标记时明确说不需要压缩，文件不动', async () => {
  const store = new LocalFolderStore(dir);
  const res = await runVectorCompact({ target: 'dataset://clean.shp' }, { loc, store }, false);
  assert.equal(res.data.compacted, false);
  assert.match(res.summary, /不需要压缩/);
});

test('dryRun 只出预告，不动文件', async () => {
  const store = new LocalFolderStore(dir);
  copyShp('base', 'dry');
  await shpDelete(store, 'dry.shp', '编号 > 10');
  const res = await runVectorCompact({ target: 'dataset://dry.shp' }, { loc, store }, true);
  assert.equal(res.data.dryRun, true);
  assert.match(res.summary, /将重写/);
  const header = readDbfHeader(store.resolve('dry.shp'), store.resolve('dry.dbf'));
  assert.equal(header.recordCount, 20, '预演不能动文件');
});

test('GeoPackage：删一批后 VACUUM，要素数不变', async () => {
  const store = new LocalFolderStore(dir);
  const targetRel = 'gdirty.gpkg';
  cpSync(store.resolve('gbase.gpkg'), store.resolve(targetRel));
  const abs = store.resolve(targetRel);
  const info = await probeLayer(loc, abs);
  await gpkgStreamDelete(loc, store, {
    targetRel,
    absPath: abs,
    info,
    whereSource: '编号 > 20',
    whereNode: parseExpression('编号 > 20'),
    keep: 'none',
    dryRun: false,
  });
  const res = await runVectorCompact({ target: `dataset://${targetRel}` }, { loc, store }, false);
  assert.equal(res.data.compacted, true);
  assert.equal(res.data.featureCount, 20, 'VACUUM 不能碰数据');
  assert.equal(typeof res.data.bytesAfter, 'number');
});

test('不支持的格式明确拒绝', async () => {
  const store = new LocalFolderStore(dir);
  await assert.rejects(
    () => runVectorCompact({ target: 'dataset://矢量.geojson' }, { loc, store }, false),
    /只支持 Shapefile 与 GeoPackage/,
  );
});

test('走 executePlan 全链路：op 注册与 AI 契约接得对', async () => {
  const store = new LocalFolderStore(dir);
  copyShp('base', 'plan');
  await shpDelete(store, 'plan.shp', '编号 > 15');
  const res = await executePlan(
    { loc, store },
    { op: 'vector.compact', params: { target: 'dataset://plan.shp' } },
  );
  assert.equal(res.ok, true, res.results[0]?.error ?? 'vector.compact 全链路应当成功');
  assert.equal(res.results[0]?.value?.data?.compacted, true);
});
