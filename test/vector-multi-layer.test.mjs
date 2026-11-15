/**
 * 多图层容器（GeoPackage）→ GeoJSON 的合并行为。
 *
 * 2026-11-15 的两个真实事故钉在这里：
 *   1. GeoJSON 输出驱动是**单图层**的：整文件转换多图层容器
 *      报 "Layer … cannot be created"，gpkg/kmz 加载直接 500；
 *   2. 逐层从原始容器转换对 KML/KMZ 是 O(N×全文件) 解析
 *      （中国水系 kmz 3450 层跑了 20 分钟都没完）。
 *
 * 现在的行为：≤20 层逐层转再合并；>20 层只装第一个有内容的图层并在 note 里说清。
 * 本测试用 GDAL 现场造一个双图层 GPKG（无预置夹具），两条路径各钉一条。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveGdal } = await import(
  new URL('../src/engine/gdal/env.ts', import.meta.url).href
);
const { vectorToGeoJson } = await import(
  new URL('../src/engine/export/vector-geojson.ts', import.meta.url).href
);

const loc = resolveGdal();

/** 造一个小 GeoJSON 文件（一个点） */
function pointGeoJson(dir, name, marker) {
  const p = join(dir, name);
  writeFileSync(
    p,
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { marker },
          geometry: { type: 'Point', coordinates: [114.5 + Math.random() * 0.1, 38.0] },
        },
      ],
    }),
    'utf8',
  );
  return p;
}

describe('多图层容器 → GeoJSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-multilayer-'));
  const gpkg = join(dir, 'two-layers.gpkg');

  // 现场造双图层 GPKG：第二层用 -update -append -nln 追加
  execFileSync(
    join(resolveGdal().binDir, 'ogr2ogr' + (process.platform === 'win32' ? '.exe' : '')),
    ['-f', 'GPKG', gpkg, pointGeoJson(dir, 'a.geojson', 'layer-a'), '-nln', '图层甲'],
  );
  execFileSync(
    join(resolveGdal().binDir, 'ogr2ogr' + (process.platform === 'win32' ? '.exe' : '')),
    ['-f', 'GPKG', '-update', '-append', '-nln', '图层乙', gpkg, pointGeoJson(dir, 'b.geojson', 'layer-b')],
  );

  test('双图层容器合并成一个 FeatureCollection（两层的要素都在）', async () => {
    const res = await vectorToGeoJson(loc, { path: gpkg });
    assert.equal(res.featureCount, 2, '两层各 1 个要素，合并后应为 2');
    const markers = res.geojson.features.map((f) => f.properties.marker).sort();
    assert.deepEqual(markers, ['layer-a', 'layer-b'], '两层的内容都要在');
    assert.equal(res.truncated, false);
  });

  test('limit 生效：截断被如实标出', async () => {
    const res = await vectorToGeoJson(loc, { path: gpkg, limit: 1 });
    assert.equal(res.featureCount, 1);
    assert.equal(res.truncated, true);
  });

  test('单图层源行为不变（回归：不再走多图层路径）', async () => {
    const single = pointGeoJson(dir, 'single.geojson', 'only');
    const res = await vectorToGeoJson(loc, { path: single });
    assert.equal(res.featureCount, 1);
    assert.equal(res.note, undefined);
  });

  test('bbox 视口裁剪：范围外的要素不返回（分块加载第一阶段）', async () => {
    // 夹具的点在 114.5~114.6/38.0 附近；一个完全无关的 bbox 应裁出 0 个要素
    const away = await vectorToGeoJson(loc, { path: gpkg, bbox: [110, 30, 111, 31] });
    assert.equal(away.featureCount, 0, '无关视口应当裁出 0 个要素');

    // 覆盖夹具点的视口应全量返回
    const hit = await vectorToGeoJson(loc, { path: gpkg, bbox: [114, 37, 116, 39] });
    assert.equal(hit.featureCount, 2, '覆盖视口应返回两层的要素');
  });
});
