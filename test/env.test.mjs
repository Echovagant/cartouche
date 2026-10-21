import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);

test('Node 可直接加载 TypeScript 源码（类型擦除）', () => {
  assert.equal(typeof resolveGdal, 'function');
});

test('能在本机定位到 GDAL', () => {
  const loc = resolveGdal();
  assert.ok(loc, '应能定位到 GDAL（未安装时本用例会失败，属预期）');
  assert.ok(loc.binDir.includes('gdal') || loc.binDir.includes('GDAL'));
});
