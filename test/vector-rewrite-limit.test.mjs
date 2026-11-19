/**
 * 超大图层整层重写的保护：体积文案与阈值边界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { rewriteSizeError, MAX_REWRITE_BYTES } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'vector', 'limits.ts')).href
);

test('整层重写保护：512 MB 及以下放行', () => {
  assert.equal(rewriteSizeError(10 * 1024 * 1024), null);
  assert.equal(rewriteSizeError(MAX_REWRITE_BYTES), null);
});

test('整层重写保护：超过 512 MB 明确拒绝并给出下一步', () => {
  const mb600 = rewriteSizeError(600 * 1024 * 1024);
  assert.ok(mb600, '600 MB 应被拒绝');
  assert.match(mb600, /600 MB/);
  assert.match(mb600, /512 MB/);
  assert.match(mb600, /拆分或导出/);

  const gb5 = rewriteSizeError(5.04 * 1024 * 1024 * 1024);
  assert.ok(gb5);
  assert.match(gb5, /5\.0 GB/);
});

test('整层重写保护：统计汇总用同一阈值但有对应措辞', () => {
  const msg = rewriteSizeError(5.04 * 1024 * 1024 * 1024, '统计汇总');
  assert.ok(msg);
  assert.match(msg, /统计汇总/);
  assert.match(msg, /拆分或导出/);
});
