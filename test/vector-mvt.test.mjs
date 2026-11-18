/**
 * 按需 MVT 瓦片：坐标换算、切片、缓存命中。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
const { tools } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'runner.ts')).href);
const { buildMvtTile, tileBbox4326, lonLatToTile } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'export', 'index.ts')).href
);

const loc = resolveGdal();

test('XYZ 与经纬度互转：0/0/0 覆盖全球', () => {
  const bbox = tileBbox4326(0, 0, 0);
  assert.deepEqual(bbox.slice(0, 1), [-180]);
  assert.deepEqual(bbox.slice(2, 3), [180]);
  assert.ok(Math.abs(bbox[1] + 85.0511287798066) < 1e-9);
  assert.ok(Math.abs(bbox[3] - 85.0511287798066) < 1e-9);
  const t = lonLatToTile(0, 0, 1);
  assert.deepEqual(t, { x: 1, y: 1 });
});

test('按需切 MVT：产出合法瓦片并命中缓存', { skip: loc ? false : 'GDAL 不可用' }, async () => {
  const fixture = join(root, 'fixtures', 'sample.shp');
  const tile = lonLatToTile(120.31, 30.53, 14);
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-mvt-test-'));
  try {
    // 复制到临时目录，避免把 .cartouche 缓存写进 fixtures
    const { copyFile } = await import('node:fs/promises');
    const src = join(dir, 'sample.shp');
    for (const ext of ['.shp', '.shx', '.dbf', '.prj', '.cpg']) {
      const from = join(root, 'fixtures', `sample${ext}`);
      if (existsSync(from)) await copyFile(from, join(dir, `sample${ext}`));
    }
    const first = await buildMvtTile(loc, { path: src, z: 14, x: tile.x, y: tile.y });
    assert.ok(first && first.bytes.length > 0, '应产出瓦片');
    assert.equal(first.generated, true);
    assert.ok(existsSync(first.cachePath));

    const info = await tools(loc).ogrInfo(['-so', first.cachePath]);
    assert.ok(info.ok, `瓦片应能被 GDAL 读取：${info.stderr}`);

    const second = await buildMvtTile(loc, { path: src, z: 14, x: tile.x, y: tile.y });
    assert.ok(second && second.generated === false, '第二次应命中缓存');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('数据范围外的瓦片返回空并记住空结果', { skip: loc ? false : 'GDAL 不可用' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-mvt-empty-'));
  try {
    const { copyFile } = await import('node:fs/promises');
    const src = join(dir, 'sample.shp');
    for (const ext of ['.shp', '.shx', '.dbf', '.prj', '.cpg']) {
      const from = join(root, 'fixtures', `sample${ext}`);
      if (existsSync(from)) await copyFile(from, join(dir, `sample${ext}`));
    }
    // 样本在 120.3E / 30.5N，选一块地球另一侧的瓦片
    const far = lonLatToTile(-60, -30, 12);
    const first = await buildMvtTile(loc, { path: src, z: 12, x: far.x, y: far.y });
    assert.equal(first, null, '范围外应返回空瓦片');
    const { readdirSync } = await import('node:fs');
    const hashDir = join(dir, '.cartouche', 'mvt');
    assert.ok(existsSync(hashDir), '应建立缓存目录');
    const hash = readdirSync(hashDir)[0];
    assert.ok(
      existsSync(join(hashDir, hash, '12', String(far.x), `${far.y}.empty`)),
      '应留下空瓦片记号',
    );

    const second = await buildMvtTile(loc, { path: src, z: 12, x: far.x, y: far.y });
    assert.equal(second, null, '第二次仍返回空');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
