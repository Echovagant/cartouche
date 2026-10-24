/**
 * 写回 GeoPackage：GPKG 是**容器**（底层 SQLite），写回只能动其中一层。
 *
 * 这一组盯的是四件事：
 *  1. 写回后能打开，要素数、列、坐标系都对；
 *  2. **同一文件里其它图层一个字都不能变**（数量、列名都要对得上）；
 *  3. 图层**顺序**要保持 —— ogr2ogr 的 -overwrite 会把被写的层挪到末尾，
 *     不还原的话，引擎下次读到的就不是同一层了；
 *  4. 失败要能回到原样；空图层写回不能把字段定义丢了。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
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

let dir = '';
let single = '';
let multi = '';

const FEATURES = [
  { NAME: 'Beijing', POP2020: 1000 },
  { NAME: 'Shanghai', POP2020: 2000 },
];

function fc(props, coords) {
  return {
    type: 'FeatureCollection',
    features: props.map((p, i) => ({
      type: 'Feature',
      properties: p,
      geometry: { type: 'Point', coordinates: coords(i) },
    })),
  };
}

before(async () => {
  if (!loc) return;
  dir = await mkdtemp(join(TMP_BASE, 'cartouche-gpkg-write-'));
  const src = join(dir, 'src');
  await mkdir(src, { recursive: true });
  // 单图层 GPKG
  const a = join(src, 'a.geojson');
  await writeFile(a, JSON.stringify(fc(FEATURES, (i) => [120.3 + i * 0.01, 30.5 + i * 0.01])), 'utf8');
  single = join(dir, '单图层.gpkg');
  const c1 = await gdal.ogr2ogr(['-f', 'GPKG', '-nln', '城市', single, a]);
  assert.ok(c1.ok, `造单图层 GPKG 失败：${c1.stderr}`);

  // 多图层 GPKG：三个图层，各 2 条要素，列名不同
  multi = join(dir, '多图层.gpkg');
  for (const [layer, name, offset] of [
    ['第一层', '甲', 0],
    ['第二层', '乙', 1],
    ['第三层', '丙', 2],
  ]) {
    const f = join(src, `${layer}.geojson`);
    await writeFile(
      f,
      JSON.stringify(
        fc(
          [
            { 名称: `${name}一`, 编号: offset * 10 + 1 },
            { 名称: `${name}二`, 编号: offset * 10 + 2 },
          ],
          (i) => [120.3 + offset + i * 0.01, 30.5 + offset + i * 0.01],
        ),
      ),
      'utf8',
    );
    const args = ['-f', 'GPKG'];
    if (offset > 0) args.push('-update');
    args.push('-nln', layer, multi, f);
    const c = await gdal.ogr2ogr(args);
    assert.ok(c.ok, `造多图层 GPKG 失败（${layer}）：${c.stderr}`);
  }
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** 列出 GPKG 里的图层名（按 ogrinfo 的枚举顺序 —— 顺序本身就是要守的东西） */
async function layerNames(path) {
  const res = await gdal.ogrInfo(['-so', '-al', path]);
  assert.ok(res.ok, `读 GPKG 失败：${res.stderr}`);
  return res.stdout
    .split(/\r?\n/)
    .filter((l) => /^Layer name:/.test(l))
    .map((l) => l.replace(/^Layer name:\s*/, '').trim());
}

/** 每个图层的要素数 */
async function layerCounts(path) {
  const res = await gdal.ogrInfo(['-so', '-al', path]);
  const out = new Map();
  let current = null;
  for (const line of res.stdout.split(/\r?\n/)) {
    const named = /^Layer name:\s*(.+)$/.exec(line);
    if (named) {
      current = named[1].trim();
      out.set(current, 0);
      continue;
    }
    const count = /^Feature Count:\s*(\d+)/.exec(line);
    if (count && current) out.set(current, Number(count[1]));
  }
  return out;
}

test('写回单图层 GPKG：写完能打开，要素与属性都对', async () => {
  if (!loc) return;
  const store = new LocalFolderStore(dir);
  const before = await readFeatures(loc, { path: single });
  const res = await writeFeatures(loc, store, {
    target: '单图层.gpkg',
    features: before.features.map((f) => ({
      properties: { ...f.properties, SCORE: 7 },
      geometry: f.geometry,
    })),
  });
  assert.equal(res.featureCount, 2);
  assert.equal(res.layerName, '城市', '写的是哪一层要说清楚');

  const after = await readFeatures(loc, { path: single });
  assert.equal(after.featureCount, 2);
  assert.equal(after.features[0].properties.SCORE, 7);
});

test('写回单图层 GPKG：坐标系不能丢', async () => {
  if (!loc) return;
  const store = new LocalFolderStore(dir);
  const before = await probeLayer(loc, single);
  const features = (await readFeatures(loc, { path: single })).features;
  await writeFeatures(loc, store, { target: '单图层.gpkg', features });
  const after = await probeLayer(loc, single);
  assert.equal(after.epsg, before.epsg, '坐标系不能因为来回转就变了');
});

test('写回多图层 GPKG：只动一层，其它图层与图层顺序都不许变', async () => {
  if (!loc) return;
  const store = new LocalFolderStore(dir);
  const namesBefore = await layerNames(multi);
  const countsBefore = await layerCounts(multi);
  assert.equal(namesBefore.length, 3, '前提：这一份 GPKG 里有三个图层');

  const target = '多图层.gpkg';
  const features = (await readFeatures(loc, { path: multi })).features;
  const res = await writeFeatures(loc, store, {
    target,
    features: features.map((f) => ({
      properties: { ...f.properties, 标记: '改过' },
      geometry: f.geometry,
    })),
  });
  assert.equal(res.layerName, namesBefore[0], '默认写的是第一层（与读路径一致）');

  const namesAfter = await layerNames(multi);
  assert.deepEqual(namesAfter, namesBefore, '图层顺序不能变 —— 变了下次读到的就不是同一层');

  const countsAfter = await layerCounts(multi);
  for (const [name, n] of countsBefore) {
    assert.equal(countsAfter.get(name), n, `图层「${name}」的要素数不能变`);
  }

  // 另外两层的列名也要一字不差
  for (const name of namesBefore.slice(1)) {
    const res2 = await gdal.ogrInfo(['-so', multi, name]);
    assert.ok(res2.ok, `读图层「${name}」失败：${res2.stderr}`);
    assert.match(res2.stdout, /名称: String/, `图层「${name}」的列不能被动过`);
  }
});

test('写回多图层 GPKG：可以指定写哪一层', async () => {
  if (!loc) return;
  const store = new LocalFolderStore(dir);
  const res = await gdal.ogrInfo(['-so', multi, '第二层']);
  assert.ok(res.ok, `读图层失败：${res.stderr}`);
  const features = (await readFeatures(loc, { path: multi })).features;
  const r = await writeFeatures(loc, store, {
    target: '多图层.gpkg',
    layerName: '第二层',
    features,
  });
  assert.equal(r.layerName, '第二层');
  const counts = await layerCounts(multi);
  assert.equal(counts.get('第二层'), 2, '第二层的要素数要还在');
  assert.equal(counts.get('第一层'), 2, '第一层不能被动');
});

test('写回 GPKG：指定一个不存在的图层要当场拒绝', async () => {
  if (!loc) return;
  const store = new LocalFolderStore(dir);
  await assert.rejects(
    () => writeFeatures(loc, store, { target: '多图层.gpkg', layerName: '不存在的那层', features: [] }),
    (err) => {
      assert.match(err.message, /没有.*这一层/);
      return true;
    },
  );
});

test('写回 GPKG：换到一半失败要能回到原样', async () => {
  if (!loc) return;
  const store = new LocalFolderStore(dir);
  const before = await layerCounts(multi);

  let count = 0;
  const broken = {
    kind: store.kind,
    resolve: (p) => store.resolve(p),
    exists: (p) => store.exists(p),
    read: (p) => store.read(p),
    write: (p, d) => store.write(p, d),
    list: (p) => store.list(p),
    stat: (p) => store.stat(p),
    remove: (p) => store.remove(p),
    copy: (f, t) => store.copy(f, t),
    rename: (f, t) => {
      count += 1;
      if (count === 1) throw new Error('模拟：第一次替换失败');
      return store.rename(f, t);
    },
    assertWritable: (p) => store.assertWritable(p),
  };

  const features = (await readFeatures(loc, { path: multi })).features;
  await assert.rejects(
    () => writeFeatures(loc, broken, { target: '多图层.gpkg', features }),
    (err) => {
      assert.match(err.message, /回滚|失败/);
      return true;
    },
  );

  const after = await layerCounts(multi);
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort(), '回滚后要素数要一致');
  const names = await layerNames(multi);
  assert.equal(names.length, 3, '回滚后图层数要一致');
});

test('写回 GPKG：备份要连伴随文件一起留（-wal 里可能还有没并回主库的数据）', async () => {
  if (!loc) return;
  const store = new LocalFolderStore(dir);
  const features = (await readFeatures(loc, { path: multi })).features;
  const res = await writeFeatures(loc, store, { target: '多图层.gpkg', features });
  assert.ok(res.backupPath, '写回必须留下备份');
  const backupDir = join(dir, res.backupPath);
  assert.ok(existsSync(backupDir), `备份目录应当存在：${backupDir}`);
  const names = await readdir(backupDir);
  assert.ok(
    names.some((n) => n.endsWith('.gpkg')),
    `备份里要有主库：${names.join('、')}`,
  );
});
