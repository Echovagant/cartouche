/**
 * 探查出来的坐标系信息必须带得出 EPSG 码。
 *
 * 背景（2026-10-23 实测）：GDAL 3.13 的 `gdalinfo -json` 里
 * `coordinateSystem.id` **经常整个不存在**（fixtures/embedded.tff 就是），
 * 只剩一段 WKT。而探查层原来只认「id 是字符串」这一种形状，
 * 于是 embedded.tff 被探成「没有 EPSG」——
 * 交差体检报告里就写成「自定义/未标注 EPSG」（report/compat-report.ts）。
 * 那是给 GIS 同事看的结论，写错了比不写更糟。
 *
 * 这条用例盯三件事：
 *   1. 内嵌坐标系的 GeoTIFF 要认得出 EPSG 码；
 *   2. 投影坐标系的要认**投影自己的**那个码（不是基准地理 CRS 的 4326）；
 *   3. 真的没有坐标系的（世界文件那种）仍然是「没有」，不能为了凑数硬给一个。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { probeDataset } = await import(eng('gdal/probe.ts'));

const loc = resolveGdal();
const EXE_SUFFIX = loc?.exeSuffix ?? '';

/** gdal_create 在不在：在才能造带指定坐标系的样本 */
function hasGdalCreate() {
  if (!loc) return false;
  try {
    execFileSync(join(loc.binDir, `gdal_create${EXE_SUFFIX}`), ['--help'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    // 工具不存在才是 ENOENT；退出码非 0 说明工具在、只是 --help 不是合法用法
    return err.code !== 'ENOENT';
  }
}

test('探查：内嵌坐标系的 GeoTIFF 要认得出 EPSG 码', async () => {
  const { dataset, error } = await probeDataset(loc, join(root, 'fixtures', 'embedded.tff'));
  assert.ok(dataset, `探查失败：${error?.message ?? '未知原因'}`);
  assert.equal(dataset.crs.present, true, 'embedded.tff 内嵌了坐标系');
  assert.equal(dataset.crs.epsg, 4326, '必须认得出 EPSG:4326（gdalinfo 的 id 字段整个不存在时要从 WKT 取）');
  assert.equal(dataset.crs.authority, 'EPSG:4326');
  assert.equal(dataset.crs.source, 'embedded', '坐标系在文件内');
});

test('探查：世界文件那种真的没坐标系的，仍然是「没有」', async () => {
  const { dataset } = await probeDataset(loc, join(root, 'fixtures', 'worldref.tff'));
  assert.ok(dataset, '探查本身要成功');
  assert.equal(dataset.crs.present, false, 'worldref.tff 没有内嵌坐标系，不许为了凑数硬给一个 EPSG');
});

test('探查：投影坐标系要取投影自己那个码，不是基准地理 CRS 的 4326', async (t) => {
  if (!hasGdalCreate()) {
    t.skip('本机没有 gdal_create，造不出带坐标系的样本');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-probe-crs-'));
  try {
    const tif = join(dir, 'utm.tif');
    execFileSync(
      join(loc.binDir, `gdal_create${EXE_SUFFIX}`),
      [
        '-outsize', '64', '64',
        '-bands', '1', '-ot', 'Byte', '-burn', '1',
        // UTM 31N：它的 WKT 里 BASEGEOGCRS 自带的 ID["EPSG",4326] 排在前面，
        // 投影自己的 ID["EPSG",32631] 在最后 —— 取第一个会把这张图误判成 4326。
        '-a_srs', 'EPSG:32631',
        '-a_ullr', '500000', '4000000', '500640', '3999360',
        '-of', 'GTiff', tif,
      ],
      { stdio: 'ignore' },
    );
    assert.ok(existsSync(tif), '样本没造出来');

    const { dataset, error } = await probeDataset(loc, tif);
    assert.ok(dataset, `探查失败：${error?.message ?? '未知原因'}`);
    assert.equal(dataset.crs.epsg, 32631, '要取投影自己的 32631，不能是基准地理 CRS 的 4326');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
