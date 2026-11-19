/**
 * 超大 GeoPackage 的原生分组汇总验收。
 *
 * 用同一份小 GPKG 与普通路径（previewOp）对拍：
 *  - 分组顺序必须按文件首次出现；
 *  - count / sum / mean / min / max / distinct 的值逐行一致；
 *  - area / length 与引擎的平面鞋带公式、环周长一致（含带洞面与空几何）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { probeLayer } = await import(eng('vector/read.ts'));
const { previewOp } = await import(eng('ops/index.ts'));
const { gpkgStreamSummarize } = await import(eng('vector/stream-gpkg-summary.ts'));
const { crsMeasureOf, areaUnitSquareMeters } = await import(eng('feature/measure.ts'));
const { columnKindOf } = await import(eng('feature/common.ts'));

const loc = resolveGdal();
if (!loc) throw new Error('本机没有 GDAL，这组用例跑不了');

const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || join(root, '.tmp-test');
let dir = '';

function rect(x, y, size) {
  return {
    type: 'Polygon',
    coordinates: [[[x, y], [x, y + size], [x + size, y + size], [x + size, y], [x, y]]],
  };
}

/** 组顺序刻意打乱：乙、甲、乙、甲、丙；最后一条没有几何 */
function makeFeatures() {
  return [
    { type: 'Feature', properties: { g: '乙', 子: 'x', v: 10, w: 1 }, geometry: rect(0, 0, 10) },
    { type: 'Feature', properties: { g: '甲', 子: 'x', v: 20, w: 2 }, geometry: rect(100, 100, 20) },
    { type: 'Feature', properties: { g: '乙', 子: 'y', v: null, w: 3 }, geometry: rect(300, 300, 30) },
    { type: 'Feature', properties: { g: '甲', 子: 'x', v: 30, w: null }, geometry: rect(500, 500, 10) },
    { type: 'Feature', properties: { g: '丙', 子: 'z', v: 5, w: 5 }, geometry: null },
  ];
}

async function makeGpkg(name) {
  const target = join(dir, name);
  writeFileSync(
    join(dir, `${name}.geojson`),
    JSON.stringify({ type: 'FeatureCollection', features: makeFeatures() }),
    'utf8',
  );
  const made = await tools(loc).ogr2ogr([
    '-f', 'GPKG', '-a_srs', 'EPSG:3857', '-nln', 'sum', target, join(dir, `${name}.geojson`),
  ]);
  assert.ok(made.ok, `造 GPKG 失败：${made.stderr}`);
  return target;
}

/** 按普通路径的规则准备原生汇总的输入 */
async function streamInput(targetRel, absPath, groupBy, aggregates, areaUnit) {
  const info = await probeLayer(loc, absPath);
  const groupFields = groupBy.map((name) => {
    const f = info.fields.find((x) => x.name === name);
    assert.ok(f, `应当有「${name}」这一列`);
    return f;
  });
  const groupKeySet = new Set(groupFields.map((f) => f.name.toLowerCase()));
  const numericFields = info.fields.filter(
    (f) =>
      !groupKeySet.has(f.name.toLowerCase()) &&
      (columnKindOf(f.type) === 'integer' || columnKindOf(f.type) === 'real'),
  );
  const distinctFields = info.fields.filter(
    (f) => !groupKeySet.has(f.name.toLowerCase()),
  );
  const measure = crsMeasureOf(info);
  const wantsArea = aggregates.includes('area');
  const wantsLength = aggregates.includes('length');
  const areaFactor =
    wantsArea && areaUnit
      ? ((measure.metersPerUnit ?? 1) ** 2) / areaUnitSquareMeters(areaUnit)
      : 1;
  return {
    targetRel,
    absPath,
    info,
    groupFields,
    groupNames: groupFields.map((f) => f.name),
    aggregates,
    numericFields,
    distinctFields,
    wantsArea,
    wantsLength,
    ...(areaUnit ? { rawAreaUnit: areaUnit } : {}),
    areaFactor,
    lengthUnit: measure.unitLabel,
    measureKind: measure.kind,
    dryRun: false,
  };
}

before(async () => {
  mkdirSync(TMP_BASE, { recursive: true });
  dir = mkdtempSync(join(TMP_BASE, 'cartouche-gpkg-sum-'));
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('原生汇总：分组顺序与逐列统计和普通路径一致', async () => {
  const gpkg = await makeGpkg('basic.gpkg');
  const store = new LocalFolderStore(dir);
  const groupBy = ['g'];
  const aggregates = ['count', 'sum', 'mean', 'min', 'max', 'distinct'];

  const expected = await previewOp(
    { loc, store },
    { op: 'feature.summarize', params: { target: 'dataset://basic.gpkg', groupBy, aggregates } },
  );
  assert.equal(expected.ok, true, expected.error ?? '普通路径应当成功');
  const want = expected.value.data;

  const input = await streamInput('basic.gpkg', gpkg, groupBy, aggregates);
  const res = await gpkgStreamSummarize(loc, input);
  const got = res.data;

  assert.deepEqual(got.columns, want.columns);
  assert.deepEqual(got.rows, want.rows);
  assert.equal(got.groupCount, want.groupCount);
  assert.equal(got.featureCount, want.featureCount);
  assert.deepEqual(got.rows.map((r) => r['g']), ['乙', '甲', '丙']);
});

test('原生汇总：面积与长度（含空几何）和普通路径一致', async () => {
  const gpkg = await makeGpkg('area.gpkg');
  const store = new LocalFolderStore(dir);
  const groupBy = ['g'];
  const aggregates = ['count', 'area', 'length'];

  const expected = await previewOp(
    { loc, store },
    {
      op: 'feature.summarize',
      params: { target: 'dataset://area.gpkg', groupBy, aggregates, areaUnit: 'm2' },
    },
  );
  assert.equal(expected.ok, true, expected.error ?? '普通路径应当成功');
  const want = expected.value.data;

  const input = await streamInput('area.gpkg', gpkg, groupBy, aggregates, 'm2');
  const res = await gpkgStreamSummarize(loc, input);
  const got = res.data;

  assert.deepEqual(got.rows, want.rows);
  assert.deepEqual(got.rows.map((r) => r['g']), ['乙', '甲', '丙']);
  // 空几何那一组的面积与长度按 0
  const last = got.rows.find((r) => r['g'] === '丙');
  assert.equal(last['area'], 0);
  assert.equal(last['length'], 0);
  assert.match(res.summary, /1 条要素没有几何/);
});

test('原生汇总：多字段分组与 decoded 值', async () => {
  const gpkg = await makeGpkg('multi.gpkg');
  const store = new LocalFolderStore(dir);
  const groupBy = ['g', '子'];
  const aggregates = ['count', 'sum'];

  const expected = await previewOp(
    { loc, store },
    { op: 'feature.summarize', params: { target: 'dataset://multi.gpkg', groupBy, aggregates } },
  );
  assert.equal(expected.ok, true, expected.error ?? '普通路径应当成功');
  const want = expected.value.data;

  const input = await streamInput('multi.gpkg', gpkg, groupBy, aggregates);
  const res = await gpkgStreamSummarize(loc, input);
  assert.deepEqual(res.data.rows, want.rows);
  assert.deepEqual(res.data.rows.map((r) => [r['g'], r['子']]), [
    ['乙', 'x'],
    ['甲', 'x'],
    ['乙', 'y'],
    ['丙', 'z'],
  ]);
});
