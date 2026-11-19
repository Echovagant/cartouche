/**
 * 流式改名的验收（GeoPackage / Shapefile）。
 *
 * 这两个格式的字段名是**元数据**，超大图层不必整层读进内存：
 *  - GPKG：`ALTER TABLE … RENAME COLUMN`（SQLite 原地改）；
 *  - SHP：只改 `.dbf` 头里的 11 字节描述符。
 *
 * 这组用例盯的是四件事：
 *  1. 改完之后列名真的变了、**值一个都没动**；
 *  2. 改之前有备份，备份文件真的在；
 *  3. Shapefile 的 10 字节上限：超长名字被截断，且按文件编码（UTF-8 / GBK）写入；
 *  4. 截断之后撞名要在**写盘之前**拦住，原文件保持原样。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { readFeatures, probeLayer } = await import(eng('vector/read.ts'));
const { streamRenameKind, executeStreamRename } = await import(eng('vector/stream-rename.ts'));

const loc = resolveGdal();
if (!loc) throw new Error('本机没有 GDAL，这组用例跑不了');

const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || join(root, '.tmp-test');
const SAMPLE_FILES = ['sample.shp', 'sample.dbf', 'sample.shx', 'sample.prj', 'sample.cpg'];
const GBK_FILES = ['gbk_sample.shp', 'gbk_sample.dbf', 'gbk_sample.shx', 'gbk_sample.prj', 'gbk_sample.cpg'];

let dir = '';
let gpkg = '';
let srcGeojson = '';

/** 复制样本到临时工作区（测试要写盘，不能动仓库里的样本） */
function workspaceWith(prefix, files) {
  mkdirSync(TMP_BASE, { recursive: true });
  const wd = mkdtempSync(join(TMP_BASE, prefix));
  for (const f of files) cpSync(join(root, 'fixtures', f), join(wd, f));
  return wd;
}

/** 取要素的属性值（按给定列顺序） */
function valuesOf(features, fields) {
  return features.map((f) => fields.map((k) => f.properties[k] ?? null));
}

before(async () => {
  dir = workspaceWith('cartouche-stream-', []);
  const src = join(dir, 'src.geojson');
  srcGeojson = src;
  writeFileSync(
    src,
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { 名称: '甲', 编码: 1 }, geometry: { type: 'Point', coordinates: [120.3, 30.5] } },
        { type: 'Feature', properties: { 名称: '乙', 编码: 2 }, geometry: { type: 'Point', coordinates: [120.4, 30.6] } },
      ],
    }),
    'utf8',
  );
  gpkg = join(dir, '城市.gpkg');
  const res = await tools(loc).ogr2ogr(['-f', 'GPKG', '-nln', '城市', gpkg, src]);
  assert.ok(res.ok, `造 GPKG 失败：${res.stderr}`);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('能流式改名的格式只有 GPKG 与 SHP', () => {
  assert.equal(streamRenameKind('a.gpkg'), 'gpkg');
  assert.equal(streamRenameKind('a.SHP'), 'shp');
  assert.equal(streamRenameKind('a.geojson'), null);
  assert.equal(streamRenameKind('a.shp.xml'), null);
});

test('GPKG：接力与互换改名（A→B、B→A）不撞名', async () => {
  const target = join(dir, 'swap.gpkg');
  const made = await tools(loc).ogr2ogr(['-f', 'GPKG', '-nln', '城市', target, srcGeojson]);
  assert.ok(made.ok, `造互换用例的 GPKG 失败：${made.stderr}`);

  const store = new LocalFolderStore(dir);
  const beforeRead = await readFeatures(loc, { path: target });
  const before = valuesOf(beforeRead.features, ['名称', '编码']);

  const res = await executeStreamRename(loc, store, 'swap.gpkg', target, '城市', [
    { from: '名称', requestedTo: '编码' },
    { from: '编码', requestedTo: '名称' },
  ]);
  assert.deepEqual(res.actualTo, ['编码', '名称']);

  const afterRead = await readFeatures(loc, { path: target });
  assert.deepEqual(valuesOf(afterRead.features, ['编码', '名称']), before);
});

test('GPKG：原生改列，值不动，留了备份', async () => {
  const store = new LocalFolderStore(dir);
  const beforeRead = await readFeatures(loc, { path: gpkg });
  const before = valuesOf(beforeRead.features, ['名称', '编码']);

  const res = await executeStreamRename(loc, store, '城市.gpkg', gpkg, '城市', [
    { from: '名称', requestedTo: 'NAME' },
    { from: '编码', requestedTo: 'CODE' },
  ]);
  assert.deepEqual(res.actualTo, ['NAME', 'CODE']);
  assert.ok(res.backupPath, '应当有备份路径');
  assert.ok(existsSync(join(dir, res.backupPath)), `备份应当真的存在：${res.backupPath}`);

  const info = await probeLayer(loc, gpkg);
  const names = info.fields.map((f) => f.name);
  assert.deepEqual(names, ['NAME', 'CODE']);

  const afterRead = await readFeatures(loc, { path: gpkg });
  assert.deepEqual(valuesOf(afterRead.features, ['NAME', 'CODE']), before);
});

test('SHP（UTF-8）：只改 .dbf 头，值不动，留了备份', async () => {
  const wd = workspaceWith('cartouche-stream-shp-', SAMPLE_FILES);
  try {
    const store = new LocalFolderStore(wd);
    const shp = join(wd, 'sample.shp');
    const beforeRead = await readFeatures(loc, { path: shp });
    const before = valuesOf(beforeRead.features, ['名称', '编码']);

    const res = await executeStreamRename(loc, store, 'sample.shp', shp, 'sample', [
      { from: '名称', requestedTo: 'NAME' },
    ]);
    assert.deepEqual(res.actualTo, ['NAME']);
    assert.ok(res.backupPath && existsSync(join(wd, res.backupPath)), '备份应当存在');

    const info = await probeLayer(loc, shp);
    const names = info.fields.map((f) => f.name);
    assert.ok(names.includes('NAME'), `应当有 NAME，实有：${names.join('、')}`);
    assert.ok(!names.includes('名称'), '旧列名不该还在');

    const afterRead = await readFeatures(loc, { path: shp });
    assert.deepEqual(valuesOf(afterRead.features, ['NAME', '编码']), before);
  } finally {
    rmSync(wd, { recursive: true, force: true });
  }
});

test('SHP（GBK）：按文件编码写入新名字，值不动', async () => {
  const wd = workspaceWith('cartouche-stream-gbk-', GBK_FILES);
  try {
    const store = new LocalFolderStore(wd);
    const shp = join(wd, 'gbk_sample.shp');
    const beforeRead = await readFeatures(loc, { path: shp });
    const before = valuesOf(beforeRead.features, ['名称', '编码']);

    const res = await executeStreamRename(loc, store, 'gbk_sample.shp', shp, 'gbk_sample', [
      { from: '名称', requestedTo: '新名字' },
    ]);
    assert.deepEqual(res.actualTo, ['新名字']);

    const info = await probeLayer(loc, shp);
    const names = info.fields.map((f) => f.name);
    assert.ok(names.includes('新名字'), `GBK 文件里应当有「新名字」，实有：${names.join('、')}`);

    const afterRead = await readFeatures(loc, { path: shp });
    assert.deepEqual(valuesOf(afterRead.features, ['新名字', '编码']), before);
  } finally {
    rmSync(wd, { recursive: true, force: true });
  }
});

test('SHP：超过 10 字节的名字按字节截断，实际列名以截断为准', async () => {
  const wd = workspaceWith('cartouche-stream-cut-', SAMPLE_FILES);
  try {
    const store = new LocalFolderStore(wd);
    const shp = join(wd, 'sample.shp');
    const res = await executeStreamRename(loc, store, 'sample.shp', shp, 'sample', [
      { from: '名称', requestedTo: 'LONGNAMETHATTRUNCATES' },
    ]);
    assert.deepEqual(res.actualTo, ['LONGNAMETH']);

    const info = await probeLayer(loc, shp);
    assert.ok(info.fields.some((f) => f.name === 'LONGNAMETH'));
  } finally {
    rmSync(wd, { recursive: true, force: true });
  }
});

test('SHP：截断后撞名要在写盘前拦住，原文件不动', async () => {
  const wd = workspaceWith('cartouche-stream-dup-', SAMPLE_FILES);
  try {
    const store = new LocalFolderStore(wd);
    const shp = join(wd, 'sample.shp');
    await assert.rejects(
      () =>
        executeStreamRename(loc, store, 'sample.shp', shp, 'sample', [
          { from: '名称', requestedTo: 'ABCDEFGHIJ1' },
          { from: '编码', requestedTo: 'ABCDEFGHIJ2' },
        ]),
      /两列同名/,
    );

    const info = await probeLayer(loc, shp);
    const names = info.fields.map((f) => f.name);
    assert.deepEqual(names, ['名称', '编码'], '失败之后列名必须原样');
  } finally {
    rmSync(wd, { recursive: true, force: true });
  }
});
