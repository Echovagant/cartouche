/**
 * 体检的坐标与跨图层检查：坐标值范围、轴序、范围合理性、离群要素、
 * 字段类型，以及与参照层的坐标系 / 范围 / 偏移比较。
 *
 * 这一族检查的价值在于它们抓的都是**静默错误**：
 * 数据能打开、能出图，但算出来的面积、长度、叠加结果全是错的，
 * 而界面上一点异常都看不出来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { runHealthCheck } = await import(eng('health/checks.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || tmpdir();

/** 造一个带指定坐标系的 GeoJSON 图层 */
async function makeGeojson(dir, name, features, crsEpsg) {
  const obj = {
    type: 'FeatureCollection',
    ...(crsEpsg ? { crs: { type: 'name', properties: { name: `urn:ogc:def:crs:EPSG::${crsEpsg}` } } } : {}),
    features,
  };
  const p = join(dir, `${name}.geojson`);
  await writeFile(p, JSON.stringify(obj), 'utf8');
  return p;
}

function point(name, x, y) {
  return {
    type: 'Feature',
    properties: { name },
    geometry: { type: 'Point', coordinates: [x, y] },
  };
}

async function withDir(fn) {
  const dir = await mkdtemp(join(TMP_BASE, 'cartouche-scope-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ruleIds = (report) => report.findings.map((f) => f.ruleId);
const coverageOf = (report, check) => report.coverage?.find((c) => c.check === check);

/* ── 坐标值范围 ─────────────────────────────────────────── */

test('坐标值超出该坐标系的范围必须报出来（V-CRS-003）', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(
      dir,
      'range',
      [point('正常', 116.0, 39.9), point('离谱', -1e9, -1e9)],
      4326,
    );
    const report = await runHealthCheck(loc, p);
    const f = report.findings.find((x) => x.ruleId === 'V-CRS-003');
    assert.ok(f, `应报出 V-CRS-003，实际：${JSON.stringify(ruleIds(report))}`);
    assert.equal(f.affectedCount, 1);
    assert.equal(f.severity, 'error');
    assert.equal(coverageOf(report, 'crs-range-sanity')?.status, 'checked');
  });
});

test('图层整体范围越界也要说（V-CRS-005）', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(dir, 'extent', [point('离谱', -1e9, -1e9)], 4326);
    const report = await runHealthCheck(loc, p);
    const f = report.findings.find((x) => x.ruleId === 'V-CRS-005');
    assert.ok(f, `应报出 V-CRS-005，实际：${JSON.stringify(ruleIds(report))}`);
  });
});

/* ── 轴序 ───────────────────────────────────────────────── */

test('经纬度写反必须报出来（V-CRS-004）', async () => {
  await withDir(async (dir) => {
    // x 全在 ±90° 内、y 超过 90° → x 是纬度、y 是经度
    const p = await makeGeojson(
      dir,
      'swapped',
      [point('北京', 39.9, 116.4), point('上海', 31.2, 121.5)],
      4326,
    );
    const report = await runHealthCheck(loc, p);
    const f = report.findings.find((x) => x.ruleId === 'V-CRS-004');
    assert.ok(f, `应报出 V-CRS-004，实际：${JSON.stringify(ruleIds(report))}`);
    assert.equal(f.severity, 'error');
  });
});

test('轴序正常时不得报"写反"', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(
      dir,
      'normal',
      [point('北京', 116.4, 39.9), point('上海', 121.5, 31.2)],
      4326,
    );
    const report = await runHealthCheck(loc, p);
    assert.ok(
      !report.findings.find((x) => x.ruleId === 'V-CRS-004' && x.severity === 'error'),
      '经纬度没写反就不该报错',
    );
  });
});

/* ── 离群要素 ───────────────────────────────────────────── */

test('离群要素必须报出来（V-EXT-001）', async () => {
  await withDir(async (dir) => {
    const features = [];
    for (let i = 0; i < 8; i++) features.push(point(`正常${i}`, 116 + i * 0.01, 39.9));
    features.push(point('离群', 116.5, 39.9));
    const p = await makeGeojson(dir, 'outlier', features, 4326);
    const report = await runHealthCheck(loc, p);
    const f = report.findings.find((x) => x.ruleId === 'V-EXT-001');
    assert.ok(f, `应报出 V-EXT-001，实际：${JSON.stringify(ruleIds(report))}`);
    assert.equal(f.affectedCount, 1);
  });
});

test('要素太少时离群检查标成"未检查"，不算查过', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(dir, 'few', [point('a', 116, 39.9), point('b', 117, 40)], 4326);
    const report = await runHealthCheck(loc, p);
    const cov = coverageOf(report, 'outlier-extent');
    assert.equal(cov?.status, 'skipped');
    assert.ok(cov.reason, '没查成必须写原因');
  });
});

/* ── 字段类型 ───────────────────────────────────────────── */

test('数字存成文本必须报出来（V-FIELD-003）', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(
      dir,
      'fieldtype',
      [
        { type: 'Feature', properties: { code: '001' }, geometry: { type: 'Point', coordinates: [116, 39.9] } },
        { type: 'Feature', properties: { code: '002' }, geometry: { type: 'Point', coordinates: [117, 39.9] } },
      ],
      4326,
    );
    const report = await runHealthCheck(loc, p);
    const f = report.findings.find((x) => x.ruleId === 'V-FIELD-003');
    assert.ok(f, `应报出 V-FIELD-003，实际：${JSON.stringify(ruleIds(report))}`);
    assert.match(f.title, /code/);
  });
});

test('文本字段里是普通文字就不该报（不得误报）', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(
      dir,
      'textfield',
      [
        { type: 'Feature', properties: { name: '甲区' }, geometry: { type: 'Point', coordinates: [116, 39.9] } },
        { type: 'Feature', properties: { name: '乙区' }, geometry: { type: 'Point', coordinates: [117, 39.9] } },
      ],
      4326,
    );
    const report = await runHealthCheck(loc, p);
    assert.ok(!report.findings.find((x) => x.ruleId === 'V-FIELD-003'), '普通文本不该报');
  });
});

/* ── 跨图层比较 ─────────────────────────────────────────── */

test('与参照层坐标系不一致必须报出来（V-CRS-002）', async () => {
  await withDir(async (dir) => {
    const target = await makeGeojson(dir, 'a', [point('p', 116, 39.9)], 4326);
    const reference = await makeGeojson(dir, 'b', [point('p', 12913060, 4851421)], 3857);
    const report = await runHealthCheck(loc, target, { reference });
    const f = report.findings.find((x) => x.ruleId === 'V-CRS-002');
    assert.ok(f, `应报出 V-CRS-002，实际：${JSON.stringify(ruleIds(report))}`);
    assert.equal(f.severity, 'error');
    assert.equal(coverageOf(report, 'crs-mismatch')?.status, 'checked');
  });
});

test('与参照层坐标系一致时不得报不一致', async () => {
  await withDir(async (dir) => {
    const target = await makeGeojson(dir, 'a', [point('p', 116, 39.9)], 4326);
    const reference = await makeGeojson(dir, 'b', [point('p', 117, 40)], 4326);
    const report = await runHealthCheck(loc, target, { reference });
    assert.ok(!report.findings.find((x) => x.ruleId === 'V-CRS-002'), '坐标系一致不该报');
    assert.equal(coverageOf(report, 'crs-mismatch')?.status, 'checked');
  });
});

test('与参照层范围不重叠必须报出来（V-EXT-002）', async () => {
  await withDir(async (dir) => {
    const target = await makeGeojson(dir, 'a', [point('p', 116, 39.9)], 4326);
    const reference = await makeGeojson(dir, 'b', [point('p', 30, 10)], 4326);
    const report = await runHealthCheck(loc, target, { reference });
    const f = report.findings.find((x) => x.ruleId === 'V-EXT-002');
    assert.ok(f, `应报出 V-EXT-002，实际：${JSON.stringify(ruleIds(report))}`);
  });
});

test('范围有重叠时不得报不重叠', async () => {
  await withDir(async (dir) => {
    const square = (x0, y0) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x0 + 1, y0], [x0 + 1, y0 + 1], [x0, y0 + 1], [x0, y0]]] },
    });
    const target = await makeGeojson(dir, 'a', [square(0, 0)], 4326);
    const reference = await makeGeojson(dir, 'b', [square(0.5, 0.5)], 4326);
    const report = await runHealthCheck(loc, target, { reference });
    assert.ok(!report.findings.find((x) => x.ruleId === 'V-EXT-002'), '范围重叠不该报');
  });
});

test('整体平移必须报出来（V-CRS-006）', async () => {
  await withDir(async (dir) => {
    // 两个图层形状一模一样，只是整体挪了 0.1 度
    const ring = [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]];
    const target = await makeGeojson(dir, 'a', [
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: ring } },
    ], 4326);
    const shifted = ring.map((r) => r.map(([x, y]) => [x + 0.1, y + 0.1]));
    const reference = await makeGeojson(dir, 'b', [
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: shifted } },
    ], 4326);
    const report = await runHealthCheck(loc, target, { reference });
    const f = report.findings.find((x) => x.ruleId === 'V-CRS-006');
    assert.ok(f, `应报出 V-CRS-006，实际：${JSON.stringify(ruleIds(report))}`);
  });
});

test('两个图层范围大小不同不算"整体平移"（不得误报）', async () => {
  await withDir(async (dir) => {
    const target = await makeGeojson(dir, 'a', [
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } },
    ], 4326);
    const reference = await makeGeojson(dir, 'b', [
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]] } },
    ], 4326);
    const report = await runHealthCheck(loc, target, { reference });
    assert.ok(!report.findings.find((x) => x.ruleId === 'V-CRS-006'), '大小不同只是覆盖范围不同');
  });
});
