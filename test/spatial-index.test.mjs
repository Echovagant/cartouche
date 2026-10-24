import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { spatialJoin } = await import(eng('spatial/index.ts'));
const { buildFeatureGrid, buildSegmentGrid } = await import(eng('spatial/grid-index.ts'));
const {
  bboxOfNormalized,
  bboxPreFilter,
  containsNormalized,
  intersectsNormalized,
  normalizeGeometry,
} = await import(eng('geometry/index.ts'));

/* ───────────────── 暴力实现（改索引之前的原始算法） ───────────────── */

/**
 * 逐对扫描版的空间连接。
 *
 * 为什么测试里要留一份暴力实现：索引是加速器，**判定口径不能变**。
 * 只有拿同一份数据分别跑「索引版」与「暴力版」，逐行比对，
 * 才能证明「加索引没有改结论」。这两份代码必须各写一遍 ——
 * 拿索引版自己的输出当基准，等于自己证明自己。
 */
function bruteForceJoin(targets, sources, relation) {
  const sourceGeoms = [];
  const sourceBoxes = [];
  for (const s of sources) {
    const g = normalizeGeometry(s.geometry, '源要素');
    sourceGeoms.push(g);
    sourceBoxes.push(bboxOfNormalized(g));
  }
  const rows = [];
  const unmatched = [];
  for (let i = 0; i < targets.length; i++) {
    const target = normalizeGeometry(targets[i].geometry, '目标要素');
    const targetBox = bboxOfNormalized(target);
    const matched = [];
    for (let j = 0; j < sourceGeoms.length; j++) {
      const sourceBox = sourceBoxes[j];
      const source = sourceGeoms[j];
      if (!sourceBox || !source) continue;
      if (!bboxPreFilter(relation, targetBox, sourceBox)) continue;
      const hit =
        relation === 'within'
          ? containsNormalized(source, target)
          : relation === 'contains'
            ? containsNormalized(target, source)
            : intersectsNormalized(target, source);
      if (hit) matched.push(j);
    }
    rows.push({ targetIndex: i, sourceIndexes: matched });
    if (matched.length === 0) unmatched.push(i);
  }
  return { rows, unmatched };
}

/** 索引版与暴力版逐行比对。 */
function assertSameAsBruteForce(targets, sources, relation, label) {
  const indexed = spatialJoin(targets, sources, { relation, aggregate: 'count' });
  const brute = bruteForceJoin(targets, sources, relation);
  assert.equal(indexed.rows.length, brute.rows.length, `${label}：行数不一致`);
  for (let i = 0; i < brute.rows.length; i++) {
    assert.deepEqual(
      indexed.rows[i].sourceIndexes,
      brute.rows[i].sourceIndexes,
      `${label}：第 ${i} 行的匹配集合不一致`,
    );
  }
  assert.deepEqual(indexed.unmatched, brute.unmatched, `${label}：未匹配列表不一致`);
  return indexed;
}

/* ───────────────── 测试数据生成 ───────────────── */

/** 可复现的伪随机数（同一个种子 → 同一批数据）。 */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 一批随机点要素。 */
function randomPoints(count, seed, spread = 100) {
  const rand = makeRandom(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      properties: { id: i, v: Math.round(rand() * 1000) },
      geometry: { type: 'Point', coordinates: [rand() * spread, rand() * spread] },
    });
  }
  return out;
}

/** 一批随机折线要素（每条 n 个点）。 */
function randomLines(count, seed, points = 5, spread = 100) {
  const rand = makeRandom(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const coords = [];
    for (let p = 0; p < points; p++) {
      coords.push([rand() * spread, rand() * spread]);
    }
    out.push({ properties: { id: i }, geometry: { type: 'LineString', coordinates: coords } });
  }
  return out;
}

/** 一批随机矩形面要素。 */
function randomPolygons(count, seed, size = 10, spread = 100) {
  const rand = makeRandom(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const x = rand() * spread;
    const y = rand() * spread;
    out.push({
      properties: { id: i },
      geometry: {
        type: 'Polygon',
        coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]],
      },
    });
  }
  return out;
}

/* ───────────────── 索引 vs 暴力：逐行一致 ───────────────── */

test('一致性：随机点 vs 随机点（intersects）索引结果与暴力逐行相同', () => {
  const targets = randomPoints(400, 20261024);
  const sources = randomPoints(400, 99887766);
  const res = assertSameAsBruteForce(targets, sources, 'intersects', '点-点');
  assert.equal(res.rows.length, 400);
});

test('一致性：随机线 vs 随机线（intersects）索引结果与暴力逐行相同', () => {
  const targets = randomLines(200, 12345);
  const sources = randomLines(200, 54321);
  assertSameAsBruteForce(targets, sources, 'intersects', '线-线');
});

test('一致性：随机面 vs 随机面（intersects）索引结果与暴力逐行相同', () => {
  const targets = randomPolygons(150, 777);
  const sources = randomPolygons(150, 888);
  assertSameAsBruteForce(targets, sources, 'intersects', '面-面');
});

test('一致性：点 vs 面（intersects / within / contains）索引结果与暴力逐行相同', () => {
  const points = randomPoints(300, 4242);
  const polygons = randomPolygons(120, 2424);
  for (const relation of ['intersects', 'within', 'contains']) {
    assertSameAsBruteForce(points, polygons, relation, `点-面 ${relation}`);
  }
});

test('一致性：线 vs 面（intersects / within / contains）索引结果与暴力逐行相同', () => {
  const lines = randomLines(150, 31337);
  const polygons = randomPolygons(120, 1337);
  for (const relation of ['intersects', 'within', 'contains']) {
    assertSameAsBruteForce(lines, polygons, relation, `线-面 ${relation}`);
  }
});

test('一致性：混合图层（点+线+面混在一起）索引结果与暴力逐行相同', () => {
  const mixed = [
    ...randomPoints(150, 11),
    ...randomLines(80, 22),
    ...randomPolygons(60, 33),
  ];
  const other = [
    ...randomPoints(150, 44),
    ...randomLines(80, 55),
    ...randomPolygons(60, 66),
  ];
  for (const relation of ['intersects', 'within', 'contains']) {
    assertSameAsBruteForce(mixed, other, relation, `混合 ${relation}`);
  }
});

test('一致性：目标与源完全相同（自连接）时索引结果与暴力逐行相同', () => {
  const lines = randomLines(200, 987654);
  const res = assertSameAsBruteForce(lines, lines, 'intersects', '自连接');
  // 每条线都与自身相交
  for (const row of res.rows) {
    assert.ok(row.sourceIndexes.includes(row.targetIndex), '自连接时每条线至少匹配到自己');
  }
});

test('一致性：要素之间贴着边、压着角时索引结果与暴力逐行相同', () => {
  // 专门构造「包围盒刚好错开一点」的情形：这类最容易在网格分格时漏掉。
  const sources = [];
  for (let i = 0; i < 60; i++) {
    const x = i * 3;
    sources.push({
      properties: { id: i },
      geometry: {
        type: 'Polygon',
        coordinates: [[[x, 0], [x + 2, 0], [x + 2, 2], [x, 2], [x, 0]]],
      },
    });
  }
  const targets = [];
  for (let i = 0; i < 60; i++) {
    const x = i * 3 + 2; // 正好压在源面的右边界上
    targets.push({
      properties: { id: i },
      geometry: { type: 'Point', coordinates: [x, 1] },
    });
  }
  for (const relation of ['intersects', 'within', 'contains']) {
    assertSameAsBruteForce(targets, sources, relation, `压边 ${relation}`);
  }
});

test('一致性：退化输入（零面积、重复点、单点线）索引结果与暴力逐行相同', () => {
  const sources = [
    { properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
    { properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
    { properties: {}, geometry: { type: 'LineString', coordinates: [[5, 5], [5, 5]] } },
    { properties: {}, geometry: { type: 'Polygon', coordinates: [[[10, 10], [10, 10], [10, 10], [10, 10]]] } },
  ];
  const targets = [
    { properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
    { properties: {}, geometry: { type: 'Point', coordinates: [10, 10] } },
    { properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [10, 10]] } },
  ];
  for (const relation of ['intersects', 'within', 'contains']) {
    assertSameAsBruteForce(targets, sources, relation, `退化 ${relation}`);
  }
});

/* ───────────────── 索引自身的行为 ───────────────── */

test('要素级网格：要素少时返回全量（不建索引也不会漏）', () => {
  const boxes = [
    { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    { minX: 5, minY: 5, maxX: 6, maxY: 6 },
  ];
  const grid = buildFeatureGrid(boxes);
  assert.equal(grid.size, 2);
  assert.deepEqual([...grid.query({ minX: 0, minY: 0, maxX: 1, maxY: 1 })].sort(), [0, 1]);
});

test('要素级网格：查询一定包含与盒子重叠的源要素，且不会给出远处的要素', () => {
  const boxes = [];
  for (let i = 0; i < 200; i++) {
    boxes.push({ minX: i, minY: i, maxX: i + 0.5, maxY: i + 0.5 });
  }
  const grid = buildFeatureGrid(boxes);
  const hits = [...grid.query({ minX: 10, minY: 10, maxX: 10.5, maxY: 10.5 })];
  // 网格给的是「同一个格子里的邻居」，比真正重叠的范围宽 —— 精确判定由
  // 连接层用包围盒再筛一遍。所以这里只断言：重叠的必须在、远处的不能在。
  assert.ok(hits.includes(10), '与查询盒子重叠的源要素必须在候选里');
  for (const j of hits) {
    assert.ok(j <= 30, `不该给出离得很远的源要素 ${j}`);
  }
});

test('要素级网格：空范围返回空列表', () => {
  const boxes = [];
  for (let i = 0; i < 200; i++) {
    boxes.push({ minX: i, minY: i, maxX: i + 0.5, maxY: i + 0.5 });
  }
  const grid = buildFeatureGrid(boxes);
  assert.deepEqual([...grid.query({ minX: -100, minY: -100, maxX: -99, maxY: -99 })], []);
});

test('要素级网格：包围盒重叠的源要素一个都不能漏（穷举比对）', () => {
  const rand = makeRandom(4242);
  const boxes = [];
  for (let i = 0; i < 500; i++) {
    const x = rand() * 50;
    const y = rand() * 50;
    boxes.push({ minX: x, minY: y, maxX: x + rand() * 5, maxY: y + rand() * 5 });
  }
  const grid = buildFeatureGrid(boxes);
  for (let q = 0; q < 300; q++) {
    const x = rand() * 50;
    const y = rand() * 50;
    const query = { minX: x, minY: y, maxX: x + rand() * 6, maxY: y + rand() * 6 };
    const got = new Set(grid.query(query));
    for (let j = 0; j < boxes.length; j++) {
      const b = boxes[j];
      const overlap =
        b.minX <= query.maxX && query.minX <= b.maxX && b.minY <= query.maxY && query.minY <= b.maxY;
      if (overlap) {
        assert.ok(got.has(j), `查询 ${q} 漏掉了与它重叠的源要素 ${j}`);
      }
    }
  }
});

test('线段级网格：线类源要素才会进索引', () => {
  const geoms = [
    normalizeGeometry({ type: 'Point', coordinates: [0, 0] }, 'x'),
    normalizeGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, 'x'),
  ];
  const grid = buildSegmentGrid(geoms);
  // 线段太少 → 不建线段级索引（连接层退回整几何判定）
  assert.equal(grid.enabled, false);
  assert.equal(grid.query(geoms[0]), null);
});

test('线段级网格：线段够多时启用，且相交结论与几何层一致', () => {
  const sources = [];
  for (let i = 0; i < 150; i++) {
    sources.push(
      normalizeGeometry(
        { type: 'LineString', coordinates: [[i, 0], [i, 10], [i + 1, 10]] },
        'x',
      ),
    );
  }
  const grid = buildSegmentGrid(sources);
  assert.equal(grid.enabled, true);

  const target = normalizeGeometry({ type: 'LineString', coordinates: [[0, 5], [200, 5]] }, 'x');
  const hits = grid.query(target);
  assert.ok(hits);
  // 竖线 x=i 与水平线 y=5 在 (i,5) 相交 → 全部命中
  for (let i = 0; i < 150; i++) {
    assert.ok(hits.has(i), `第 ${i} 条线应当与目标线相交`);
  }
});

test('线段级网格：不相交的线不进命中集合', () => {
  const sources = [];
  for (let i = 0; i < 150; i++) {
    sources.push(
      normalizeGeometry({ type: 'LineString', coordinates: [[i, 0], [i, 5], [i, 10]] }, 'x'),
    );
  }
  const grid = buildSegmentGrid(sources);
  const target = normalizeGeometry({ type: 'LineString', coordinates: [[0, 100], [200, 100]] }, 'x');
  const hits = grid.query(target);
  assert.ok(hits);
  assert.equal(hits.size, 0, 'y=100 的线与 y∈[0,10] 的线不相交');
});

/* ───────────────── 结果形状没有变 ───────────────── */

test('结果形状：索引版与暴力版的行数、顺序、未匹配列表完全一致', () => {
  const targets = randomPoints(120, 5150);
  const sources = randomPolygons(80, 6160);
  const indexed = spatialJoin(targets, sources, { relation: 'within', aggregate: 'first' });
  const brute = bruteForceJoin(targets, sources, 'within');
  assert.equal(indexed.rows.length, targets.length);
  for (let i = 0; i < targets.length; i++) {
    assert.equal(indexed.rows[i].targetIndex, i);
    assert.deepEqual(indexed.rows[i].sourceIndexes, brute.rows[i].sourceIndexes);
  }
  assert.deepEqual(indexed.unmatched, brute.unmatched);
});

test('结果形状：匹配到的源下标按源顺序排列（first 汇总取第一个匹配）', () => {
  const sources = [
    { properties: { name: 'A' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] } },
    { properties: { name: 'B' }, geometry: { type: 'Polygon', coordinates: [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]] } },
  ];
  // 两个面都罩住这个点 → 匹配下标必须是 [0, 1]（升序）
  const targets = [
    { properties: {}, geometry: { type: 'Polygon', coordinates: [[[-5, -5], [35, -5], [35, 35], [-5, 35], [-5, -5]]] } },
  ];
  const res = spatialJoin(targets, sources, { relation: 'contains', aggregate: 'first' });
  assert.deepEqual(res.rows[0].sourceIndexes, [0, 1]);
  assert.deepEqual(res.rows[0].aggregates, { name: 'A' });
});
