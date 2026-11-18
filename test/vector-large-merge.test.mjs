/**
 * 大要素集的合并回归：`features.push(...layerFeatures)` 在 30 万点时
 * 会触发 "Maximum call stack size exceeded"，这里锁住修复后的逐条追加。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
const { tools } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'runner.ts')).href);
const { vectorToGeoJson } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'export', 'index.ts')).href
);

const loc = resolveGdal();

test('20 万点单层：合并不再触发调用栈溢出', { skip: loc ? false : 'GDAL 不可用' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-large-merge-'));
  try {
    const csv = join(dir, 'points.csv');
    const lines = ['lon,lat,id'];
    for (let i = 0; i < 200000; i++) {
      lines.push(`${100 + (i % 1000) * 0.001},${30 + Math.floor(i / 1000) * 0.001},${i}`);
    }
    await writeFile(csv, lines.join('\n'));
    const shp = join(dir, 'points.shp');
    const res = await tools(loc).ogr2ogr([
      '-f', 'ESRI Shapefile', shp, csv,
      '-oo', 'X_POSSIBLE_NAMES=lon', '-oo', 'Y_POSSIBLE_NAMES=lat',
      '-a_srs', 'EPSG:4326',
    ]);
    assert.ok(res.ok, `造夹具失败：${res.stderr}`);

    const out = await vectorToGeoJson(loc, { path: shp, targetCrs: 'EPSG:4326' });
    assert.equal(out.featureCount, 200000);
    assert.equal(out.truncated, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
