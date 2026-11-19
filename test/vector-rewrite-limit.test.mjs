/**
 * 超大图层整层重写的保护：体积文案与阈值边界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { rewriteSizeError, MAX_REWRITE_BYTES, layerSizeBytes, assertRewriteSize } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'vector', 'limits.ts')).href
);

/** 临时目录：默认落在仓库里的 .tmp-test（已 gitignore） */
const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || join(root, '.tmp-test');

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

test('Shapefile 的体量取 .shp / .dbf 的较大者', () => {
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TMP_BASE, 'cartouche-size-'));
  try {
    const shp = join(dir, 'big.shp');
    writeFileSync(shp, Buffer.alloc(16));
    const dbf = join(dir, 'big.dbf');
    writeFileSync(dbf, Buffer.alloc(16));
    // 几何很小、属性表很大：只看 .shp 会漏掉这种图层
    const fd = openSync(dbf, 'r+');
    try {
      ftruncateSync(fd, 600 * 1024 * 1024);
    } finally {
      closeSync(fd);
    }

    assert.equal(layerSizeBytes(shp), 600 * 1024 * 1024);
    assert.throws(() => assertRewriteSize(shp), /600 MB/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GeoPackage 的 -wal 也计入体量', () => {
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TMP_BASE, 'cartouche-size-wal-'));
  try {
    const gpkg = join(dir, 'big.gpkg');
    writeFileSync(gpkg, Buffer.alloc(16));
    const wal = `${gpkg}-wal`;
    writeFileSync(wal, Buffer.alloc(16));
    const fd = openSync(wal, 'r+');
    try {
      ftruncateSync(fd, 600 * 1024 * 1024);
    } finally {
      closeSync(fd);
    }

    assert.equal(layerSizeBytes(gpkg), 16 + 600 * 1024 * 1024);
    assert.throws(() => assertRewriteSize(gpkg), /512 MB/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
