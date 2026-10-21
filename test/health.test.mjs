import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
const { tools } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'runner.ts')).href);
const { runHealthCheck } = await import(pathToFileURL(join(root, 'src', 'engine', 'health', 'checks.ts')).href);

const loc = resolveGdal();
const gdal = tools(loc);

/** 造一个 20x20 的 ASCII Grid（无地理信息） */
async function makeAsc(dir) {
  const n = 20;
  const lines = [`ncols ${n}`, `nrows ${n}`, 'xllcorner 120.30', 'yllcorner 30.52', 'cellsize 0.001', 'NODATA_value -9999'];
  for (let y = 0; y < n; y++) {
    const row = [];
    for (let x = 0; x < n; x++) row.push(String((x * y) % 255));
    lines.push(row.join(' '));
  }
  const p = join(dir, 'src.asc');
  await writeFile(p, lines.join('\n') + '\n');
  return p;
}

async function makeFixtures() {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-health-'));
  const asc = await makeAsc(dir);

  // A: 无坐标系的栅格（Esri 原始组合：世界文件 + prj 侧车，但 GDAL 读不到 prj）
  const bare = join(dir, 'bare.tff');
  await gdal.translate(['-of', 'GTiff', asc, bare]);
  await writeFile(join(dir, 'bare.tfw'), '0.001\n0\n0\n-0.001\n120.3005\n30.5395\n');
  await writeFile(
    join(dir, 'bare.prj'),
    'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
      'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]\n',
  );

  // B: 坐标系内嵌的栅格
  const embedded = join(dir, 'embedded.tff');
  await gdal.translate(['-of', 'GTiff', '-a_srs', 'EPSG:4326', asc, embedded]);

  return { dir, bare, embedded };
}

test('体检：Esri 原始组合（.tff+.tfw+.prj）因 GDAL 读不到 prj 而判定为缺坐标系 → 阻断', async () => {
  const { dir, bare } = await makeFixtures();
  try {
    const report = await runHealthCheck(loc, bare);
    assert.equal(report.kind, 'raster');
    const blocker = report.findings.find((f) => f.ruleId === 'R-CRS-001');
    assert.ok(blocker, '应产出 R-CRS-001');
    assert.equal(blocker.severity, 'blocker');
    assert.equal(report.passed, false);
    assert.equal(report.blockers.length >= 1, true);
    // 提示要明确指向"内嵌"
    assert.match(blocker.hint ?? '', /内嵌/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('体检：坐标系内嵌的栅格不触发 CRS 阻断', async () => {
  const { dir, embedded } = await makeFixtures();
  try {
    const report = await runHealthCheck(loc, embedded);
    const crsBlocker = report.findings.find((f) => f.ruleId === 'R-CRS-001');
    assert.equal(crsBlocker, undefined, '内嵌坐标系后不应再有 R-CRS-001');
    assert.equal(report.passed, true, `不该有阻断项，实际：${JSON.stringify(report.blockers)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('体检：世界文件提供仿射参数时不应误报"缺少地理定位"', async () => {
  const { dir, bare } = await makeFixtures();
  try {
    const report = await runHealthCheck(loc, bare);
    const geoBlocker = report.findings.find((f) => f.ruleId === 'R-GEO-001');
    assert.equal(geoBlocker, undefined, '有 .tfw 时不应报 R-GEO-001');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('体检：Shapefile 走矢量规则，.prj 有效则无 CRS 阻断', async () => {
  const { dir } = await makeFixtures();
  try {
    const geojson = join(dir, 'poly.geojson');
    await writeFile(
      geojson,
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { 名称: '甲' },
            geometry: { type: 'Polygon', coordinates: [[[120.3, 30.52], [120.32, 30.52], [120.32, 30.54], [120.3, 30.54], [120.3, 30.52]]] },
          },
        ],
      }),
    );
    const shp = join(dir, 'poly.shp');
    await gdal.ogr2ogr(['-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', shp, geojson]);

    const report = await runHealthCheck(loc, shp);
    assert.equal(report.kind, 'vector');
    const crs = report.findings.find((f) => f.ruleId === 'V-CRS-001');
    assert.equal(crs, undefined, '有 .prj 的 shapefile 不应报 V-CRS-001');
    assert.equal(report.passed, true, `不该有阻断项，实际：${JSON.stringify(report.blockers)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('体检：不存在的路径返回阻断级结论而不是抛异常', async () => {
  const { dir } = await makeFixtures();
  try {
    const report = await runHealthCheck(loc, join(dir, 'not-here.tif'));
    assert.equal(report.passed, false);
    assert.equal(report.blockers.length, 1);
    assert.equal(report.blockers[0].ruleId, 'H-OPEN-001');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('体检：零面积面要素被识别', async () => {
  const { dir } = await makeFixtures();
  try {
    const geojson = join(dir, 'degenerate.geojson');
    await writeFile(
      geojson,
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { id: 1 },
            geometry: { type: 'Polygon', coordinates: [[[120.3, 30.52], [120.3, 30.52], [120.3, 30.52], [120.3, 30.52]]] },
          },
        ],
      }),
    );
    const shp = join(dir, 'degenerate.shp');
    await gdal.ogr2ogr(['-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', shp, geojson]);
    const report = await runHealthCheck(loc, shp);
    const zero = report.findings.find((f) => f.ruleId === 'V-GEOM-002');
    assert.ok(zero, '应识别出零面积面要素');
    assert.equal(zero.affectedCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('体检：GBK 编码的属性表应触发 V-ENC-002（转 UTF-8 交差会丢生僻字）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-health-'));
  try {
    const geojson = join(dir, 'cn.geojson');
    await writeFile(
      geojson,
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { 名称: '测试图斑', 编码: 1024 },
            geometry: {
              type: 'Polygon',
              coordinates: [[[120.3, 30.52], [120.32, 30.52], [120.32, 30.54], [120.3, 30.54], [120.3, 30.52]]],
            },
          },
        ],
      }),
      'utf8',
    );
    const shp = join(dir, 'gbk.shp');
    await gdal.ogr2ogr(['-f', 'ESRI Shapefile', '-lco', 'ENCODING=GBK', shp, geojson]);

    const report = await runHealthCheck(loc, shp);
    const enc = report.findings.find((f) => f.ruleId === 'V-ENC-002');
    assert.ok(enc, 'GBK 编码应触发 V-ENC-002');
    assert.equal(enc.severity, 'warn');
    assert.ok(enc.title.includes('GBK'), enc.title);
    assert.ok(
      !report.findings.find((f) => f.ruleId === 'V-ENC-001'),
      '有 .cpg 声明编码时不应再报 V-ENC-001（未声明编码）',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('体检：UTF-8 编码的属性表不应触发 V-ENC-002', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-health-'));
  try {
    const geojson = join(dir, 'cn.geojson');
    await writeFile(
      geojson,
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { 名称: '测试图斑' },
            geometry: {
              type: 'Polygon',
              coordinates: [[[120.3, 30.52], [120.32, 30.52], [120.32, 30.54], [120.3, 30.54], [120.3, 30.52]]],
            },
          },
        ],
      }),
      'utf8',
    );
    const shp = join(dir, 'utf8.shp');
    await gdal.ogr2ogr(['-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', shp, geojson]);

    const report = await runHealthCheck(loc, shp);
    assert.ok(
      !report.findings.find((f) => f.ruleId === 'V-ENC-002'),
      'UTF-8 不应触发 V-ENC-002',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
