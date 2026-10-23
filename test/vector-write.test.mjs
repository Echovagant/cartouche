/**
 * 矢量写回：备份、替换、校验、回滚。
 *
 * 这一组是整个矢量链路里最不能出错的地方 ——
 * 写坏的数据比没写更糟：用户看不出哪里错，只看得出图不对。
 *
 * 盯的是四件事：
 *  1. 写完的文件**能打开**（要素数对、坐标系没丢）；
 *  2. 备份是**整套**（只有 .shp 没有 .dbf 的备份，回滚出来是打不开的）；
 *  3. 换到一半失败要能**回到原样**；
 *  4. 不支持的格式、越界的路径要当场拒绝。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { readFeatures, probeLayer } = await import(eng('vector/read.ts'));
const { writeFeatures } = await import(eng('vector/write.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || tmpdir();

const FEATURES = [
  { NAME: 'Beijing', POP2020: 1000 },
  { NAME: 'Shanghai', POP2020: 2000 },
];

let dir = '';
let geojson = '';
let shp = '';

before(async () => {
  if (!loc) return;
  dir = await mkdtemp(join(TMP_BASE, 'cartouche-vector-write-'));
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
  const res = await gdal.ogr2ogr(['-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', shp, geojson]);
  assert.ok(res.ok, `造 Shapefile 失败：${res.stderr}`);
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** 造一份带新列的要素。 */
function withExtra(extra) {
  return FEATURES.map((p) => ({ properties: { ...p, ...extra }, geometry: { type: 'Point', coordinates: [120.3, 30.5] } }));
}

/**
 * 一个会在第 N 次 rename 时失败的 store。
 *
 * 用来模拟"换到一半失败"——这是写回最需要兜住的场景。
 */
function failingStore(base, failAt) {
  let count = 0;
  return {
    kind: base.kind,
    resolve: (p) => base.resolve(p),
    exists: (p) => base.exists(p),
    read: (p) => base.read(p),
    write: (p, d) => base.write(p, d),
    list: (p) => base.list(p),
    stat: (p) => base.stat(p),
    remove: (p) => base.remove(p),
    copy: (f, t) => base.copy(f, t),
    rename: (f, t) => {
      count += 1;
      if (count === failAt) throw new Error(`模拟：第 ${count} 次替换失败`);
      return base.rename(f, t);
    },
    assertWritable: (p) => base.assertWritable(p),
  };
}

test('写回 Shapefile：写完能打开，要素与属性都对', async () => {
  const store = new LocalFolderStore(dir);
  const res = await writeFeatures(loc, store, {
    target: 'cities.shp',
    features: withExtra({ SCORE: 7 }),
  });
  assert.equal(res.featureCount, 2);
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.featureCount, 2);
  assert.equal(after.features[0].properties.SCORE, 7);
  assert.equal(after.features[1].properties.NAME, 'Shanghai');
});

test('写回 Shapefile：坐标系原样带过去（投影不能丢）', async () => {
  const before = await probeLayer(loc, shp);
  assert.equal(before.epsg, 4326);
  const store = new LocalFolderStore(dir);
  await writeFeatures(loc, store, { target: 'cities.shp', features: withExtra({ SCORE: 8 }) });
  const after = await probeLayer(loc, shp);
  assert.equal(after.epsg, 4326, '坐标系不能因为来回转就变了');
});

test('写回 Shapefile：备份是整套文件（缺 .dbf 的备份回滚出来是打不开的）', async () => {
  const store = new LocalFolderStore(dir);
  const res = await writeFeatures(loc, store, {
    target: 'cities.shp',
    features: withExtra({ SCORE: 9 }),
  });
  assert.ok(res.backupPath, '写回必须留下备份');
  const backupDir = join(dir, res.backupPath);
  assert.ok(existsSync(backupDir), `备份目录应当存在：${backupDir}`);
  const names = await readdir(backupDir);
  for (const suffix of ['.shp', '.dbf', '.shx', '.prj']) {
    assert.ok(
      names.some((n) => n.toLowerCase().endsWith(suffix)),
      `备份里应当有 ${suffix} 这一份，实为 ${names.join('、')}`,
    );
  }
});

test('写回 Shapefile：换到一半失败要能回到原样', async () => {
  const store = new LocalFolderStore(dir);
  // 先写一份作为"原样"的基准
  await writeFeatures(loc, store, { target: 'cities.shp', features: withExtra({ SCORE: 1 }) });
  const before = await readFeatures(loc, { path: shp });

  const broken = failingStore(store, 2);
  await assert.rejects(
    () => writeFeatures(loc, broken, { target: 'cities.shp', features: withExtra({ SCORE: 2 }) }),
    (err) => {
      assert.match(err.message, /回滚|失败/);
      return true;
    },
  );

  // 关键：原文件必须还是回滚前的样子，不能停在"换了一半"的中间态
  const after = await readFeatures(loc, { path: shp });
  assert.equal(after.featureCount, before.featureCount);
  assert.equal(after.features[0].properties.SCORE, before.features[0].properties.SCORE);
  assert.equal(after.features[0].properties.NAME, 'Beijing');
});

test('写回 GeoJSON：写完能打开', async () => {
  const store = new LocalFolderStore(dir);
  const res = await writeFeatures(loc, store, {
    target: 'cities.geojson',
    features: withExtra({ SCORE: 3 }),
  });
  assert.equal(res.featureCount, 2);
  const after = await readFeatures(loc, { path: geojson });
  assert.equal(after.featureCount, 2);
  assert.equal(after.features[0].properties.SCORE, 3);
});

test('写回不支持的格式：当场拒绝，不猜', async () => {
  const store = new LocalFolderStore(dir);
  await assert.rejects(
    () => writeFeatures(loc, store, { target: 'cities.txt', features: withExtra({}) }),
    (err) => {
      assert.match(err.message, /\.shp|\.geojson/);
      return true;
    },
  );
});

test('写回越界的路径：当场拒绝', async () => {
  const store = new LocalFolderStore(dir);
  await assert.rejects(
    () => writeFeatures(loc, store, { target: 'C:/Windows/System32/drivers/etc/hosts', features: [] }),
    (err) => {
      assert.match(err.message, /相对路径/);
      return true;
    },
  );
});

test('写回带 .. 的路径：当场拒绝', async () => {
  const store = new LocalFolderStore(dir);
  await assert.rejects(
    () => writeFeatures(loc, store, { target: '../escape.shp', features: [] }),
    (err) => {
      assert.match(err.message, /\.\./);
      return true;
    },
  );
});
