import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { bboxOf, centroidOf, distanceBetween } = await import(eng('geometry/index.ts'));

const SQUARE = {
  type: 'Polygon',
  coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
};

/** 右下角挖掉 7~9 的洞（偏离中心，质心才会被拉偏） */
const SQUARE_WITH_HOLE = {
  type: 'Polygon',
  coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[7, 7], [9, 7], [9, 9], [7, 9], [7, 7]],
  ],
};

const point = (x, y) => ({ type: 'Point', coordinates: [x, y] });

const near = (actual, expected, tol = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tol, `期望 ${expected}（±${tol}），实为 ${actual}`);
};

/* ───────────────── 包围盒 ───────────────── */

test('包围盒：点、线、面', () => {
  assert.deepEqual(bboxOf(point(3, 4)), { minX: 3, minY: 4, maxX: 3, maxY: 4 });
  assert.deepEqual(
    bboxOf({ type: 'LineString', coordinates: [[1, 2], [5, 8]] }),
    { minX: 1, minY: 2, maxX: 5, maxY: 8 },
  );
  assert.deepEqual(bboxOf(SQUARE), { minX: 0, minY: 0, maxX: 10, maxY: 10 });
});

test('包围盒：空几何返回 null', () => {
  assert.equal(bboxOf(null), null);
  assert.equal(bboxOf(undefined), null);
});

/* ───────────────── 质心 ───────────────── */

test('质心：点就是它自己，多点是算术平均', () => {
  assert.deepEqual(centroidOf(point(3, 4)), [3, 4]);
  assert.deepEqual(
    centroidOf({ type: 'MultiPoint', coordinates: [[0, 0], [10, 0]] }),
    [5, 0],
  );
});

test('质心：线按段长加权', () => {
  // 两段等长：一段 (0,0)-(10,0)，一段 (10,0)-(10,10)
  const c = centroidOf({ type: 'LineString', coordinates: [[0, 0], [10, 0], [10, 10]] });
  assert.ok(c);
  near(c[0], 7.5);
  near(c[1], 2.5);
});

test('质心：面按面积加权', () => {
  const c = centroidOf(SQUARE);
  assert.ok(c);
  near(c[0], 5);
  near(c[1], 5);
});

test('质心：洞被扣掉，质心被拉向剩余部分', () => {
  // 外环面积 100、质心 (5,5)；洞面积 4、质心 (8,8)
  // → 面积 96，质心 = (100*5 - 4*8)/96 = 4.875
  const c = centroidOf(SQUARE_WITH_HOLE);
  assert.ok(c);
  near(c[0], 4.875);
  near(c[1], 4.875);
});

test('质心：多部件面按各部件面积加权', () => {
  // 两块等大的面：0~10（质心 5,5）与 20~30（质心 25,5）→ 合并后 (15,5)
  const multi = {
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
      [[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]],
    ],
  };
  const c = centroidOf(multi);
  assert.ok(c);
  near(c[0], 15);
  near(c[1], 5);
});

test('质心：退化面（面积为 0）退回顶点平均', () => {
  const c = centroidOf({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [4, 0], [0, 0]]] });
  assert.ok(c);
  near(c[0], (0 + 2 + 4 + 0) / 4);
  near(c[1], 0);
});

test('质心：空几何返回 null，坏几何抛错', () => {
  assert.equal(centroidOf(null), null);
  assert.equal(centroidOf(undefined), null);
  assert.throws(() => centroidOf({ type: 'Point', coordinates: [Number.NaN, 0] }), /NaN|Infinity/);
});

/* ───────────────── 距离 ───────────────── */

test('距离：点-点精确', () => {
  assert.equal(distanceBetween(point(0, 0), point(3, 4)), 5);
});

test('距离：点-线取到线段的最短距离', () => {
  const line = { type: 'LineString', coordinates: [[0, 0], [10, 0]] };
  assert.equal(distanceBetween(point(5, 5), line), 5);
  assert.equal(distanceBetween(point(-3, 0), line), 3, '垂足落在段外时取端点');
});

test('距离：线-线取线段之间的最短距离', () => {
  const a = { type: 'LineString', coordinates: [[0, 0], [10, 0]] };
  const b = { type: 'LineString', coordinates: [[0, 3], [10, 3]] };
  assert.equal(distanceBetween(a, b), 3);
});

test('距离：相交的组合为 0', () => {
  assert.equal(distanceBetween(point(5, 5), SQUARE), 0, '点在面内');
  assert.equal(distanceBetween(point(0, 5), SQUARE), 0, '点在边界上');
  const crossing = { type: 'LineString', coordinates: [[-5, 5], [15, 5]] };
  assert.equal(distanceBetween(crossing, SQUARE), 0, '线穿过面');
});

test('距离：面-面分开的距离是边界之间的最短距离', () => {
  // 正对着放：最近的一对是 (10,y) 与 (20,y)，距离 10
  const beside = {
    type: 'Polygon',
    coordinates: [[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]],
  };
  assert.equal(distanceBetween(SQUARE, beside), 10);
  // 斜着放：最近的一对是角点 (10,10) 与 (20,20)，距离是 √200
  const diagonal = {
    type: 'Polygon',
    coordinates: [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]],
  };
  assert.equal(distanceBetween(SQUARE, diagonal), Math.hypot(10, 10));
});

test('距离：点-面分开时取点到边界的最短距离', () => {
  assert.equal(distanceBetween(point(15, 5), SQUARE), 5);
  assert.equal(distanceBetween(point(13, 14), SQUARE), Math.hypot(3, 4));
});

test('距离：退化输入抛错', () => {
  assert.throws(() => distanceBetween(null, SQUARE), /空|nil|geometry/i);
  assert.throws(() => distanceBetween(point(0, 0), { type: 'Point', coordinates: ['a', 'b'] }), /不是数字/);
});
