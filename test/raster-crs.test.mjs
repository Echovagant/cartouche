import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { isLongitudeLatitude } = await import(eng('gdal/probe.ts'));

/**
 * 这些用例锁的是一条**判断口径**：栅格的坐标能不能直接当经纬度用。
 *
 * 这条判断决定前端能不能用画笔/框选 —— 判错的后果很隐蔽：
 * 位置算错之后画出来的东西落在别处，而且"看着像对的"（用户不会怀疑是坐标系的事）。
 */

const DEGREE_GT = [120.3, 0.001, 0, 30.54, 0, -0.001];
const METER_GT = [385000, 10, 0, 3435000, 0, -10];

test('CRS：EPSG 就是 4326 → 是经纬度', () => {
  assert.equal(isLongitudeLatitude({ present: true, epsg: 4326, source: 'embedded' }, DEGREE_GT), true);
});

test('CRS：authority 写着 EPSG:4326 也算', () => {
  assert.equal(
    isLongitudeLatitude({ present: true, authority: 'EPSG:4326', source: 'sidecar' }, DEGREE_GT),
    true,
  );
});

test('CRS：只有 WKT（GDAL 常常不给 EPSG 代码）也能认出 WGS 84', () => {
  assert.equal(
    isLongitudeLatitude(
      {
        present: true,
        wkt: 'GEOGCRS["WGS 84",ENSEMBLE["World Geodetic System 1984 ensemble"]]',
        source: 'embedded',
      },
      DEGREE_GT,
    ),
    true,
  );
  assert.equal(
    isLongitudeLatitude(
      { present: true, wkt: 'GEOGCS["WGS 84",DATUM["WGS_1984"]]', source: 'embedded' },
      DEGREE_GT,
    ),
    true,
  );
});

test('CRS：完全没有 CRS，但 geotransform 是度量级 → 按 4326 处理（与出图约定一致）', () => {
  assert.equal(isLongitudeLatitude({ present: false, source: 'none' }, DEGREE_GT), true);
});

test('CRS：完全没有 CRS，但 geotransform 明显是米 → 不能当经纬度', () => {
  assert.equal(isLongitudeLatitude({ present: false, source: 'none' }, METER_GT), false);
});

test('CRS：有 CRS 但不是 4326（哪怕像元很小）→ 不能当经纬度', () => {
  assert.equal(
    isLongitudeLatitude({ present: true, epsg: 4490, source: 'embedded' }, DEGREE_GT),
    false,
  );
});

test('CRS：投影坐标系（带 3857 之类）→ 不能当经纬度', () => {
  assert.equal(
    isLongitudeLatitude({ present: true, epsg: 3857, source: 'embedded' }, METER_GT),
    false,
  );
});

test('CRS：缺 geotransform 且没有 CRS → 不能判（宁可不判）', () => {
  assert.equal(isLongitudeLatitude({ present: false, source: 'none' }, null), false);
});
