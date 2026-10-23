import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { spatialJoin, toOpData } = await import(eng('spatial/index.ts'));

/* ───────────────── 测试数据 ───────────────── */

const SCHOOL_A = {
  type: 'Polygon',
  coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
};
const SCHOOL_B = {
  type: 'Polygon',
  coordinates: [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]],
};

/** 源图层：两个学区面 */
const sources = [
  { properties: { name: 'A区', pop: 100, code: 'A' }, geometry: SCHOOL_A },
  { properties: { name: 'B区', pop: 50, code: 'B' }, geometry: SCHOOL_B },
];

/** 目标图层：点 + 各种面的组合 */
const targets = [
  { properties: { id: 1 }, geometry: { type: 'Point', coordinates: [5, 5] } },        // 在 A 区里
  { properties: { id: 2 }, geometry: { type: 'Point', coordinates: [25, 25] } },      // 在 B 区里
  { properties: { id: 3 }, geometry: { type: 'Point', coordinates: [50, 50] } },      // 谁都不在
  { properties: { id: 4 }, geometry: { type: 'Polygon', coordinates: [[[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]]] } }, // 与 A 区部分重叠
  { properties: { id: 5 }, geometry: { type: 'Polygon', coordinates: [[[-5, -5], [15, -5], [15, 15], [-5, 15], [-5, -5]]] } }, // 罩住 A 区
  { properties: { id: 6 }, geometry: { type: 'Polygon', coordinates: [[[-10, -10], [40, -10], [40, 40], [-10, 40], [-10, -10]]] } }, // 罩住两个区
];

const idx = (res, i) => res.rows[i].sourceIndexes;

/* ───────────────── 三种关系 ───────────────── */

test('关系 within：目标完全落在源里才算命中', () => {
  const res = spatialJoin(targets, sources, { relation: 'within', aggregate: 'first' });
  assert.deepEqual(idx(res, 0), [0], 'A 区里的点落在 A 区内');
  assert.deepEqual(idx(res, 1), [1], 'B 区里的点落在 B 区内');
  assert.deepEqual(idx(res, 2), [], '野外的点谁都不落');
  assert.deepEqual(idx(res, 3), [], '部分重叠不算「落在里面」');
  assert.deepEqual(idx(res, 4), [], '罩住源的面是反过来的关系');
  assert.deepEqual(idx(res, 5), [], '罩住两个区的面同样不是「落在里面」');
  assert.deepEqual(res.unmatched, [2, 3, 4, 5]);
});

test('关系 intersects：有交集就算命中', () => {
  const res = spatialJoin(targets, sources, { relation: 'intersects', aggregate: 'first' });
  assert.deepEqual(idx(res, 0), [0]);
  assert.deepEqual(idx(res, 1), [1]);
  assert.deepEqual(idx(res, 2), []);
  assert.deepEqual(idx(res, 3), [0], '部分重叠也算相交');
  assert.deepEqual(idx(res, 4), [0], '罩住也算相交');
  assert.deepEqual(idx(res, 5), [0, 1], '罩住两个区');
  assert.deepEqual(res.unmatched, [2]);
});

test('关系 contains：源完全落在目标里才算命中（与 within 反向）', () => {
  const res = spatialJoin(targets, sources, { relation: 'contains', aggregate: 'first' });
  assert.deepEqual(idx(res, 0), [], '点里装不下面');
  assert.deepEqual(idx(res, 3), [], '部分重叠不算包含');
  assert.deepEqual(idx(res, 4), [0], '罩住 A 区的面包含 A 区');
  assert.deepEqual(idx(res, 5), [0, 1], '罩住两个区的面包含两个区');
  assert.deepEqual(res.unmatched, [0, 1, 2, 3]);
});

test('关系方向：within 与 contains 互为反向', () => {
  const within = spatialJoin(targets, sources, { relation: 'within', aggregate: 'first' });
  const contains = spatialJoin(targets, sources, { relation: 'contains', aggregate: 'first' });
  assert.deepEqual(idx(within, 4), []);
  assert.deepEqual(idx(contains, 4), [0]);
});

test('边界口径在连接层同样成立：压在学区边界上的点算落在区内', () => {
  const edge = [{ properties: { id: 9 }, geometry: { type: 'Point', coordinates: [0, 5] } }];
  const res = spatialJoin(edge, sources, { relation: 'within', aggregate: 'first' });
  assert.deepEqual(idx(res, 0), [0], '边界上的点仍算落在 A 区内');
});

test('边界口径的代价：压在两个学区的公共边上的点同时落进两个区', () => {
  // 保守选择：多匹配会暴露给用户，少匹配会静默丢数据
  const adjacent = [
    { properties: { name: '左' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] } },
    { properties: { name: '右' }, geometry: { type: 'Polygon', coordinates: [[[10, 0], [20, 0], [20, 10], [10, 10], [10, 0]]] } },
  ];
  const edge = [{ properties: { id: 9 }, geometry: { type: 'Point', coordinates: [10, 5] } }];
  const res = spatialJoin(edge, adjacent, { relation: 'within', aggregate: 'first' });
  assert.deepEqual(idx(res, 0), [0, 1]);
});

/* ───────────────── 聚合语义 ───────────────── */

test('聚合 first：取第一个匹配源要素的字段值（原样保值）', () => {
  const res = spatialJoin(targets, sources, { relation: 'within', aggregate: 'first' });
  assert.deepEqual(res.rows[0].aggregates, { name: 'A区', pop: 100, code: 'A' });
  assert.deepEqual(res.rows[1].aggregates, { name: 'B区', pop: 50, code: 'B' });
});

test('聚合 first：多个匹配时取源顺序里的第一个', () => {
  const res = spatialJoin(targets, sources, { relation: 'contains', aggregate: 'first' });
  assert.deepEqual(idx(res, 5), [0, 1]);
  assert.deepEqual(res.rows[5].aggregates, { name: 'A区', pop: 100, code: 'A' });
});

test('聚合 count：数的是匹配到的源要素条数', () => {
  const res = spatialJoin(targets, sources, { relation: 'contains', aggregate: 'count' });
  assert.deepEqual(res.rows[0].aggregates, { count: null }, '没匹配上给 null');
  assert.deepEqual(res.rows[4].aggregates, { count: 1 });
  assert.deepEqual(res.rows[5].aggregates, { count: 2 });
});

test('聚合 sum / mean：对数值字段求和与求均值', () => {
  const sum = spatialJoin(targets, sources, { relation: 'contains', aggregate: 'sum' });
  assert.deepEqual(sum.rows[4].aggregates, { pop: 100 });
  assert.deepEqual(sum.rows[5].aggregates, { pop: 150 }, '100 + 50');

  const mean = spatialJoin(targets, sources, { relation: 'contains', aggregate: 'mean' });
  assert.deepEqual(mean.rows[4].aggregates, { pop: 100 });
  assert.deepEqual(mean.rows[5].aggregates, { pop: 75 }, '(100 + 50) / 2');
});

test('聚合 sum：非数值字段被跳过，并列进 skippedFields', () => {
  const res = spatialJoin(targets, sources, { relation: 'within', aggregate: 'sum' });
  assert.deepEqual(res.rows[0].aggregates, { pop: 100 }, '只出数值字段');
  assert.deepEqual(res.skippedFields, ['name', 'code'], '被跳过的字段必须可见');
});

test('聚合 mean：缺测的值不计入分母', () => {
  const src = [
    { properties: { v: 10 }, geometry: SCHOOL_A },
    { properties: { v: null }, geometry: SCHOOL_B },
    { properties: { v: 20 }, geometry: { type: 'Polygon', coordinates: [[[40, 40], [50, 40], [50, 50], [40, 50], [40, 40]]] } },
  ];
  const big = { type: 'Polygon', coordinates: [[[-10, -10], [60, -10], [60, 60], [-10, 60], [-10, -10]]] };
  const res = spatialJoin([{ properties: {}, geometry: big }], src, { relation: 'contains', aggregate: 'mean' });
  // 有效值 10 与 20：缺测的 null 不进分母 → (10+20)/2 = 15，而不是 30/3
  assert.deepEqual(res.rows[0].aggregates, { v: 15 });
});

test('聚合 sum / mean：一个有效数值都没有时给 null（缺测不是 0）', () => {
  const src = [{ properties: { v: null }, geometry: SCHOOL_A }];
  const res = spatialJoin(targets.slice(0, 1), src, { relation: 'within', aggregate: 'sum' });
  assert.deepEqual(res.rows[0].aggregates, { v: null });
});

test('聚合 count：忽略 fields，只产出一个计数字段', () => {
  const res = spatialJoin(targets, sources, {
    relation: 'within',
    aggregate: 'count',
    fields: ['pop'],
  });
  assert.deepEqual(res.rows[0].aggregates, { count: 1 });
});

/* ───────────────── 无匹配 ───────────────── */

test('没有匹配：聚合值给 null，并进 unmatched 列表', () => {
  const res = spatialJoin(targets, sources, { relation: 'within', aggregate: 'sum' });
  assert.deepEqual(res.rows[2].aggregates, { pop: null });
  assert.ok(res.unmatched.includes(2));
});

/* ───────────────── 字段选取 ───────────────── */

test('fields：只汇总指定的源字段', () => {
  const res = spatialJoin(targets, sources, { relation: 'within', aggregate: 'sum', fields: ['pop'] });
  assert.deepEqual(res.rows[0].aggregates, { pop: 100 });
  assert.deepEqual(res.skippedFields, []);
});

test('fields：指定了非数值字段 → 跳过并列出', () => {
  const res = spatialJoin(targets, sources, {
    relation: 'within',
    aggregate: 'sum',
    fields: ['pop', 'name'],
  });
  assert.deepEqual(res.rows[0].aggregates, { pop: 100 });
  assert.deepEqual(res.skippedFields, ['name']);
});

test('fields：指定了源数据里不存在的字段 → 跳过并列出', () => {
  const res = spatialJoin(targets, sources, {
    relation: 'within',
    aggregate: 'sum',
    fields: ['pop', '不存在'],
  });
  assert.deepEqual(res.rows[0].aggregates, { pop: 100 });
  assert.deepEqual(res.skippedFields, ['不存在']);
});

test('源要素没有数值字段：sum 不产出任何汇总字段，并把字段列进 skippedFields', () => {
  const src = [{ properties: { name: '只有文本' }, geometry: SCHOOL_A }];
  const res = spatialJoin(targets.slice(0, 1), src, { relation: 'within', aggregate: 'sum' });
  assert.deepEqual(res.rows[0].aggregates, {});
  assert.deepEqual(res.skippedFields, ['name']);
});

test('源要素没有数值字段：count 照常给条数', () => {
  const src = [{ properties: { name: '只有文本' }, geometry: SCHOOL_A }];
  const res = spatialJoin(targets.slice(0, 1), src, { relation: 'within', aggregate: 'count' });
  assert.deepEqual(res.rows[0].aggregates, { count: 1 });
});

test('fieldPrefix：给汇总字段加前缀', () => {
  const res = spatialJoin(targets, sources, {
    relation: 'within',
    aggregate: 'sum',
    fieldPrefix: 'sj_',
  });
  assert.deepEqual(res.rows[0].aggregates, { sj_pop: 100 });
});

test('fieldPrefix：count 字段也带前缀', () => {
  const res = spatialJoin(targets, sources, {
    relation: 'within',
    aggregate: 'count',
    fieldPrefix: 'sj_',
  });
  assert.deepEqual(res.rows[0].aggregates, { sj_count: 1 });
});

test('fieldPrefix：first 汇总的字段名同样带前缀', () => {
  const res = spatialJoin(targets, sources, {
    relation: 'within',
    aggregate: 'first',
    fieldPrefix: 'sj_',
  });
  assert.deepEqual(res.rows[0].aggregates, { sj_name: 'A区', sj_pop: 100, sj_code: 'A' });
});

/* ───────────────── 结果形状 ───────────────── */

test('结果：每个目标要素一行，顺序与输入一致', () => {
  const res = spatialJoin(targets, sources, { relation: 'intersects', aggregate: 'first' });
  assert.equal(res.rows.length, targets.length);
  for (let i = 0; i < targets.length; i++) {
    assert.equal(res.rows[i].targetIndex, i);
  }
});

test('结果：匹配到的源下标按源顺序排列', () => {
  const res = spatialJoin(targets, sources, { relation: 'contains', aggregate: 'count' });
  assert.deepEqual(res.rows[5].sourceIndexes, [0, 1]);
});

/* ───────────────── 退化输入：必须报错 ───────────────── */

test('退化输入：目标几何为空 → 报错并指出是哪个要素', () => {
  assert.throws(
    () => spatialJoin([{ properties: {}, geometry: null }], sources, { relation: 'within', aggregate: 'first' }),
    /目标图层第 0 个要素/,
  );
});

test('退化输入：源几何含 NaN → 报错并指出是哪个要素', () => {
  const bad = [{ properties: {}, geometry: { type: 'Point', coordinates: [Number.NaN, 0] } }];
  assert.throws(
    () => spatialJoin(targets.slice(0, 1), bad, { relation: 'within', aggregate: 'first' }),
    /源图层第 0 个要素/,
  );
});

test('退化输入：坐标维数不对 → 报错', () => {
  const bad = [{ properties: {}, geometry: { type: 'Point', coordinates: [1] } }];
  assert.throws(
    () => spatialJoin(targets.slice(0, 1), bad, { relation: 'within', aggregate: 'first' }),
    /维数/,
  );
});

test('退化输入：不支持的关系 / 汇总方式 → 报错', () => {
  assert.throws(
    () => spatialJoin(targets, sources, { relation: 'overlaps', aggregate: 'first' }),
    /空间关系/,
  );
  assert.throws(
    () => spatialJoin(targets, sources, { relation: 'within', aggregate: 'median' }),
    /汇总方式/,
  );
});

test('空图层：没有源要素时所有目标都算未匹配', () => {
  const res = spatialJoin(targets.slice(0, 2), [], { relation: 'within', aggregate: 'first' });
  assert.deepEqual(res.unmatched, [0, 1]);
  assert.deepEqual(res.rows[0].aggregates, {});
});

/* ───────────────── op 的 data 形状 ───────────────── */

test('op data：matched 是匹配上的目标要素个数，aggregates 与目标同序', () => {
  const res = spatialJoin(targets, sources, { relation: 'within', aggregate: 'sum' });
  const data = toOpData(res);
  assert.equal(data.matched, 2, '目标 0、1 命中，其余没命中');
  assert.deepEqual(data.unmatched, [2, 3, 4, 5]);
  assert.equal(data.aggregates.length, targets.length);
  assert.deepEqual(data.aggregates[0], { pop: 100 });
  assert.deepEqual(data.aggregates[2], { pop: null }, '未匹配的目标给 null');
  assert.deepEqual(data.skippedFields, ['name', 'code']);
});
