/**
 * 体检的几何拓扑检查：自相交、面重叠、零长度线、重复顶点、环、尖刺。
 *
 * 这一组用例盯的是两件事：
 *   1. **真问题必须报出来** —— 引擎以前只有空几何与零面积两条规则，
 *      自相交、面重叠这些"能查却没查"的问题，体检报告读起来像"查过、没问题"。
 *   2. **干净数据不能误报** —— 公开数据里合法地存在很锐的角、
 *      相邻面之间的边界缝隙；把它们报成问题，工具就没人信了。
 *
 * 引擎能不能查这些，取决于本机 GDAL 有没有编进 SpatiaLite
 * （拓扑判定走 GEOS）。用例因此分成两组：
 *   - 与 SpatiaLite 无关的（零长度线、重复顶点、环、尖刺）无条件断言；
 *   - 与 SpatiaLite 有关的（自相交、面重叠）先看体检结果里的执行状态，
 *     查不了就断言"明确说了没查"，而不是假装没问题。
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

/** 临时目录：默认系统临时目录，可用 CARTOUCHE_TEST_TMP 指到别处（别往系统盘堆） */
const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || tmpdir();

/** 造一个只有几何的 GeoJSON 图层 */
async function makeGeojson(dir, name, features) {
  const p = join(dir, `${name}.geojson`);
  await writeFile(p, JSON.stringify({ type: 'FeatureCollection', features }), 'utf8');
  return p;
}

/** 造一个面要素 */
function poly(name, rings) {
  return {
    type: 'Feature',
    properties: { name },
    geometry: { type: 'Polygon', coordinates: rings },
  };
}

/** 正方形（逆时针） */
function square(name, x0, y0, s) {
  return poly(name, [[[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]]]);
}

async function withDir(fn) {
  const dir = await mkdtemp(join(TMP_BASE, 'cartouche-geom-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ruleIds = (report) => report.findings.map((f) => f.ruleId);
const coverageOf = (report, check) => report.coverage?.find((c) => c.check === check);

/* ── 自相交 ─────────────────────────────────────────────── */

test('自相交的面必须报出来（V-GEOM-003）', async () => {
  await withDir(async (dir) => {
    // 蝴蝶结：边界自己跟自己相交
    const p = await makeGeojson(dir, 'bowtie', [
      poly('蝴蝶结', [[[0, 0], [10, 10], [0, 10], [10, 0], [0, 0]]]),
      square('正常面', 20, 20, 5),
    ]);
    const report = await runHealthCheck(loc, p);
    const validity = coverageOf(report, 'geometry-validity');
    if (validity?.status !== 'checked') {
      // 本机 GDAL 没编进 SpatiaLite：那就必须明确说"没查"，不能装作查过了
      assert.equal(validity.status, 'skipped');
      assert.ok(validity.reason, '没查必须写清原因');
      assert.ok(!ruleIds(report).includes('V-GEOM-003'));
      return;
    }
    const f = report.findings.find((x) => x.ruleId === 'V-GEOM-003');
    assert.ok(f, `应报出 V-GEOM-003，实际：${JSON.stringify(ruleIds(report))}`);
    assert.equal(f.affectedCount, 1);
    assert.equal(f.severity, 'error');
  });
});

/* ── 面重叠 ─────────────────────────────────────────────── */

test('互相压在一起的两个面必须报出来（V-GEOM-004）', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(dir, 'overlap', [
      square('甲', 0, 0, 10),
      square('乙', 5, 5, 10),
    ]);
    const report = await runHealthCheck(loc, p);
    const overlap = coverageOf(report, 'overlap');
    if (overlap?.status !== 'checked') {
      assert.equal(overlap.status, 'skipped');
      assert.ok(overlap.reason, '没查必须写清原因');
      return;
    }
    const f = report.findings.find((x) => x.ruleId === 'V-GEOM-004');
    assert.ok(f, `应报出 V-GEOM-004，实际：${JSON.stringify(ruleIds(report))}`);
    assert.equal(f.affectedCount, 1);
  });
});

test('只是共享一条边的两个面不算重叠（不得误报）', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(dir, 'adjacent', [
      square('甲', 0, 0, 10),
      square('乙', 10, 0, 10),
    ]);
    const report = await runHealthCheck(loc, p);
    assert.ok(
      !report.findings.find((x) => x.ruleId === 'V-GEOM-004'),
      '共享边界的相邻面不是重叠',
    );
  });
});

/* ── 零长度线 / 重复顶点 ────────────────────────────────── */

test('零长度线必须报出来（V-GEOM-006）', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(dir, 'zeroline', [
      { type: 'Feature', properties: { name: '零长度' }, geometry: { type: 'LineString', coordinates: [[5, 5], [5, 5]] } },
      { type: 'Feature', properties: { name: '正常' }, geometry: { type: 'LineString', coordinates: [[0, 0], [10, 10]] } },
    ]);
    const report = await runHealthCheck(loc, p);
    const f = report.findings.find((x) => x.ruleId === 'V-GEOM-006');
    assert.ok(f, `应报出 V-GEOM-006，实际：${JSON.stringify(ruleIds(report))}`);
    assert.equal(f.affectedCount, 1);
  });
});

test('重复顶点必须报出来（V-GEOM-007）', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(dir, 'dup', [
      poly('重复顶点', [[[0, 0], [0, 0], [10, 10], [10, 10], [0, 0]]]),
      square('正常面', 20, 20, 5),
    ]);
    const report = await runHealthCheck(loc, p);
    const f = report.findings.find((x) => x.ruleId === 'V-GEOM-007');
    assert.ok(f, `应报出 V-GEOM-007，实际：${JSON.stringify(ruleIds(report))}`);
    assert.equal(f.affectedCount, 1);
  });
});

/* ── 环 ─────────────────────────────────────────────────── */

test('未闭合的环必须报出来（V-GEOM-005）', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(dir, 'unclosed', [
      poly('未闭合', [[[0, 0], [10, 0], [10, 10], [0, 10]]]),
    ]);
    const report = await runHealthCheck(loc, p);
    const f = report.findings.find((x) => x.ruleId === 'V-GEOM-005');
    assert.ok(f, `应报出 V-GEOM-005，实际：${JSON.stringify(ruleIds(report))}`);
    assert.match(f.title, /未闭合/);
  });
});

test('同一图层里环绕向不一致必须报出来（V-GEOM-005）', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(dir, 'mixed', [
      // 逆时针
      poly('逆', [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]),
      // 顺时针
      poly('顺', [[[20, 0], [20, 10], [30, 10], [30, 0], [20, 0]]]),
    ]);
    const report = await runHealthCheck(loc, p);
    const f = report.findings.find((x) => x.ruleId === 'V-GEOM-005' && /绕向/.test(x.title));
    assert.ok(f, `应报出环方向不一致，实际：${JSON.stringify(ruleIds(report))}`);
  });
});

/* ── 尖刺 ───────────────────────────────────────────────── */

test('长边上的小尖刺必须报出来（V-GEOM-008）', async () => {
  await withDir(async (dir) => {
    // 一个 100×100 的方块，右边中间戳出去一根针：
    // 针尖 (101,50) 的两条边长各约 1 米（比环上典型边长短得多），夹角约 5.7°
    const ring = [
      [0, 0], [100, 0], [100, 49.95], [101, 50], [100, 50.05], [100, 100], [0, 100], [0, 0],
    ];
    const p = await makeGeojson(dir, 'spike', [poly('带尖刺', [ring])]);
    const report = await runHealthCheck(loc, p);
    const f = report.findings.find((x) => x.ruleId === 'V-GEOM-008');
    assert.ok(f, `应报出 V-GEOM-008，实际：${JSON.stringify(ruleIds(report))}`);
  });
});

test('整个环就是一根针的狭长要素不算尖刺（不得误报）', async () => {
  await withDir(async (dir) => {
    // 4 个顶点的细长小岛：这是真实地理，不是数字化错误
    const p = await makeGeojson(dir, 'sliver', [
      poly('狭长小岛', [[[0, 0], [2000, 1], [2001, 2], [1999, 0.5], [0, 0]]]),
    ]);
    const report = await runHealthCheck(loc, p);
    assert.ok(
      !report.findings.find((x) => x.ruleId === 'V-GEOM-008'),
      '整个环就是一根针的狭长要素不是尖刺',
    );
  });
});

/* ── 干净数据不误报 ─────────────────────────────────────── */

test('干净的多边形图层：几何类检查一条都不该报', async () => {
  await withDir(async (dir) => {
    const features = [];
    for (let i = 0; i < 5; i++) {
      features.push(square(`面${i}`, i * 20, 0, 10));
    }
    const p = await makeGeojson(dir, 'clean', features);
    const report = await runHealthCheck(loc, p);
    const geo = report.findings.filter((f) => f.ruleId.startsWith('V-GEOM'));
    assert.deepEqual(
      geo.map((f) => f.ruleId),
      [],
      `干净数据不该有几何类结论：${JSON.stringify(geo.map((f) => `${f.ruleId}:${f.detail}`))}`,
    );
  });
});

test('要素太多时拓扑检查标成"未检查"，而不是卡住或只查一部分', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(dir, 'many', [square('面', 0, 0, 10)]);
    // 直接调拓扑模块：要素总数超上限时应当立刻说"没查"
    const { runTopologyChecks, TOPOLOGY_MAX_FEATURES } = await import(eng('health/topology.ts'));
    const out = await runTopologyChecks({
      loc,
      path: p,
      layerName: 'many',
      featureIds: [0],
      limit: 5000,
      totalFeatureCount: TOPOLOGY_MAX_FEATURES + 1,
      checkOverlap: true,
      alreadyFlagged: new Set(),
    });
    assert.equal(out.validity.status, 'skipped');
    assert.equal(out.overlap.status, 'skipped');
    assert.match(out.validity.reason ?? '', /超过拓扑检查上限/);
    assert.deepEqual(out.findings, [], '没查就不该有结论');
  });
});

/* ── 覆盖情况必须如实 ───────────────────────────────────── */

test('每一项检查都要报出自己执行了没有', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(dir, 'cov', [square('面', 0, 0, 10)]);
    const report = await runHealthCheck(loc, p);
    assert.ok(report.coverage, '体检结果必须带覆盖情况');
    const checks = report.coverage.map((c) => c.check);
    for (const c of ['null-geometry', 'zero-area', 'sharp-angle', 'crs-range-sanity', 'outlier-extent']) {
      assert.ok(checks.includes(c), `覆盖情况里缺 ${c}`);
    }
    // 没查的项必须带原因，不能只有状态
    for (const c of report.coverage) {
      if (c.status === 'skipped' || c.status === 'unsupported') {
        assert.ok(c.reason, `${c.check} 没查成却没写原因`);
      }
    }
  });
});

test('没有参照层时，跨图层比较必须标成"未检查"而不是"没问题"', async () => {
  await withDir(async (dir) => {
    const p = await makeGeojson(dir, 'noref', [square('面', 0, 0, 10)]);
    const report = await runHealthCheck(loc, p);
    for (const c of ['crs-mismatch', 'extent-compare', 'systematic-offset']) {
      const cov = coverageOf(report, c);
      assert.ok(cov, `覆盖情况里缺 ${c}`);
      assert.equal(cov.status, 'skipped', `${c} 没有参照层就不该算查过`);
      assert.match(cov.reason ?? '', /参照层/);
    }
  });
});
