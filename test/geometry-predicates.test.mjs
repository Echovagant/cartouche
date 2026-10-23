import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { bboxOf, pointInPolygon, geometryIntersects, contains } = await import(eng('geometry/index.ts'));

/** 0~10 的正方形（闭合环） */
const SQUARE = {
  type: 'Polygon',
  coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
};

/** 中间挖了一个 3~7 的洞 */
const SQUARE_WITH_HOLE = {
  type: 'Polygon',
  coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],
  ],
};

/** 与 SQUARE 部分重叠 */
const OVERLAP = {
  type: 'Polygon',
  coordinates: [[[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]]],
};

/** 完整包住 SQUARE */
const ENVELOPE = {
  type: 'Polygon',
  coordinates: [[[-5, -5], [15, -5], [15, 15], [-5, 15], [-5, -5]]],
};

/** 完整落在 SQUARE 里 */
const INNER = {
  type: 'Polygon',
  coordinates: [[[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]],
};

const point = (x, y) => ({ type: 'Point', coordinates: [x, y] });

/* ───────────────── 点在多边形内 / 外 / 边上 / 洞里 ───────────────── */

test('点在多边形内：算在内', () => {
  assert.equal(pointInPolygon([5, 5], SQUARE), true);
  assert.equal(pointInPolygon([0.001, 9.999], SQUARE), true);
});

test('点在多边形外：算在外', () => {
  assert.equal(pointInPolygon([15, 5], SQUARE), false);
  assert.equal(pointInPolygon([-1, -1], SQUARE), false);
});

test('点在多边形边上：闭集口径，算在内', () => {
  // 这条是整个模块最关键的约定：边界上的点算「在多边形内」
  assert.equal(pointInPolygon([0, 5], SQUARE), true, '左边上的点');
  assert.equal(pointInPolygon([5, 0], SQUARE), true, '下边上的点');
  assert.equal(pointInPolygon([10, 10], SQUARE), true, '顶点');
  assert.equal(pointInPolygon([7, 10], SQUARE), true, '上边上的点');
});

test('点在洞里：算在外', () => {
  assert.equal(pointInPolygon([5, 5], SQUARE_WITH_HOLE), false, '洞的正中间');
  assert.equal(pointInPolygon([3.5, 3.5], SQUARE_WITH_HOLE), false, '洞的内部');
});

test('点在洞的边界上：算在内（洞的边界是面的边界）', () => {
  assert.equal(pointInPolygon([3, 5], SQUARE_WITH_HOLE), true, '洞的左边');
  assert.equal(pointInPolygon([5, 7], SQUARE_WITH_HOLE), true, '洞的上边');
});

test('边界口径自洽：压在边界上的点既算「在内」也算「相交」', () => {
  // 这条锁住的是一致性：不能出现「相交了但不在里面」的组合
  assert.equal(pointInPolygon([0, 5], SQUARE), true);
  assert.equal(geometryIntersects(point(0, 5), SQUARE), true);
});

test('相邻面共享边界时，压在公共边上的点同时落在两个面内', () => {
  // 保守选择：多匹配会暴露给用户，少匹配会静默丢数据
  const left = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
  const right = { type: 'Polygon', coordinates: [[[10, 0], [20, 0], [20, 10], [10, 10], [10, 0]]] };
  assert.equal(pointInPolygon([10, 5], left), true);
  assert.equal(pointInPolygon([10, 5], right), true);
});

/* ───────────────── 线与多边形 ───────────────── */

test('线穿过多边形：相交', () => {
  const line = { type: 'LineString', coordinates: [[-5, 5], [15, 5]] };
  assert.equal(geometryIntersects(line, SQUARE), true);
});

test('线完全在多边形内：相交，且被包含', () => {
  const line = { type: 'LineString', coordinates: [[2, 2], [8, 8]] };
  assert.equal(geometryIntersects(line, SQUARE), true);
  assert.equal(contains(SQUARE, line), true);
});

test('线在多边形外：不相交', () => {
  const line = { type: 'LineString', coordinates: [[20, 20], [30, 30]] };
  assert.equal(geometryIntersects(line, SQUARE), false);
  assert.equal(contains(SQUARE, line), false);
});

test('线只是擦着多边形的角：也算相交', () => {
  const line = { type: 'LineString', coordinates: [[-5, -5], [0, 0]] };
  assert.equal(geometryIntersects(line, SQUARE), true);
});

test('开放线不会被首尾连成环（端点相接也算相交）', () => {
  // 这条是回归：曾把「环的闭合段」误用到开放线上，
  // 结果一条根本没碰到面的线被判成相交
  const far = { type: 'LineString', coordinates: [[20, 20], [30, 30]] };
  assert.equal(geometryIntersects(far, SQUARE), false);
  const touching = { type: 'LineString', coordinates: [[-5, 5], [0, 5]] };
  assert.equal(geometryIntersects(touching, SQUARE), true);
});

/* ───────────────── 包含 vs 相交 ───────────────── */

test('包含与相交的区别：部分重叠的两个面', () => {
  assert.equal(geometryIntersects(SQUARE, OVERLAP), true, '部分重叠算相交');
  assert.equal(contains(SQUARE, OVERLAP), false, '部分重叠不算包含');
  assert.equal(contains(OVERLAP, SQUARE), false);
});

test('包含：内层完全在外层里', () => {
  assert.equal(contains(SQUARE, INNER), true);
  assert.equal(contains(INNER, SQUARE), false);
});

test('包含：外层完全包住内层', () => {
  assert.equal(contains(ENVELOPE, SQUARE), true);
  assert.equal(contains(SQUARE, ENVELOPE), false);
});

test('包含：点落在线上算在线包含它', () => {
  const line = { type: 'LineString', coordinates: [[0, 0], [10, 0]] };
  assert.equal(contains(line, point(5, 0)), true);
  assert.equal(contains(line, point(5, 1)), false);
});

test('包含：点与多边形', () => {
  assert.equal(contains(SQUARE, point(5, 5)), true);
  assert.equal(contains(SQUARE, point(15, 5)), false);
});

test('包含：点在洞里不算被多边形包含', () => {
  assert.equal(contains(SQUARE_WITH_HOLE, point(5, 5)), false);
});

/* ───────────────── 多部件 ───────────────── */

test('多部件面：部件落在另一个面里也算包含', () => {
  const multi = {
    type: 'MultiPolygon',
    coordinates: [
      [[[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]],
      [[[20, 20], [25, 20], [25, 25], [20, 25], [20, 20]]],
    ],
  };
  assert.equal(contains(SQUARE, multi), false, '整体并没有全在 SQUARE 里');
  assert.equal(geometryIntersects(SQUARE, multi), true, '但确实有交集');
});

test('多部件面：全部落在里面才算包含', () => {
  const multi = {
    type: 'MultiPolygon',
    coordinates: [
      [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]],
      [[[8, 8], [9, 8], [9, 9], [8, 9], [8, 8]]],
    ],
  };
  assert.equal(contains(SQUARE, multi), true);
});

test('多点：所有点都在里面才算包含', () => {
  const inside = { type: 'MultiPoint', coordinates: [[1, 1], [9, 9]] };
  const mixed = { type: 'MultiPoint', coordinates: [[1, 1], [19, 19]] };
  assert.equal(contains(SQUARE, inside), true);
  assert.equal(contains(SQUARE, mixed), false);
});

test('多线：每条线都在里面才算包含', () => {
  const multi = {
    type: 'MultiLineString',
    coordinates: [
      [[1, 1], [2, 2]],
      [[8, 8], [9, 9]],
    ],
  };
  assert.equal(contains(SQUARE, multi), true);
});

test('多部件包围盒：取所有部件的并集', () => {
  const multi = {
    type: 'MultiPolygon',
    coordinates: [
      [[[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]]],
      [[[20, 20], [25, 20], [25, 25], [20, 25], [20, 20]]],
    ],
  };
  assert.deepEqual(bboxOf(multi), { minX: 2, minY: 2, maxX: 25, maxY: 25 });
});

/* ───────────────── 关系方向：逐条语义 ───────────────── */

test('关系方向：within 与 contains 是反向的，intersects 不看方向', () => {
  // within：目标 ⊆ 源；contains：源 ⊆ 目标；intersects：两者皆可
  assert.equal(contains(SQUARE, INNER), true, '目标在源里 → within 成立');
  assert.equal(contains(INNER, SQUARE), false, '反方向不成立 → contains 不成立');
  assert.equal(geometryIntersects(SQUARE, INNER), true);
  assert.equal(geometryIntersects(INNER, SQUARE), true, '相交是对称的');
});

test('关系方向：包含不可逆', () => {
  assert.notEqual(contains(SQUARE, INNER), contains(INNER, SQUARE));
  assert.notEqual(contains(ENVELOPE, SQUARE), contains(SQUARE, ENVELOPE));
});

/* ───────────────── 退化输入：必须报错，不许静默当成「不相交」 ───────────────── */

test('退化输入：空几何抛错，不静默当成不相交', () => {
  assert.throws(() => pointInPolygon([5, 5], null), /空|nil|geometry/i);
  assert.throws(() => geometryIntersects(null, SQUARE), /空|nil|geometry/i);
  assert.throws(() => geometryIntersects(SQUARE, null), /空|nil|geometry/i);
  assert.throws(() => contains(null, SQUARE), /空|nil|geometry/i);
});

test('退化输入：坐标维数不对抛错', () => {
  assert.throws(() => bboxOf({ type: 'Point', coordinates: [1] }), /维数/);
  assert.throws(() => bboxOf({ type: 'Point', coordinates: [] }), /维数/);
});

test('退化输入：NaN / Infinity 抛错', () => {
  assert.throws(() => bboxOf({ type: 'Point', coordinates: [Number.NaN, 0] }), /NaN|Infinity/);
  assert.throws(() => bboxOf({ type: 'Point', coordinates: [0, Number.POSITIVE_INFINITY] }), /NaN|Infinity/);
});

test('退化输入：坐标不是数字抛错', () => {
  assert.throws(() => bboxOf({ type: 'Point', coordinates: ['1', '2'] }), /不是数字/);
});

test('退化输入：环的点数不足、多边形缺外环抛错', () => {
  assert.throws(() => bboxOf({ type: 'Polygon', coordinates: [] }), /外环/);
  assert.throws(() => bboxOf({ type: 'Polygon', coordinates: [[[0, 0], [1, 0]]] }), /点数不足/);
});

test('退化输入：线只有一个点抛错', () => {
  assert.throws(() => bboxOf({ type: 'LineString', coordinates: [[0, 0]] }), /点数不足/);
});

test('退化输入：不支持的几何类型抛错', () => {
  assert.throws(() => bboxOf({ type: 'GeometryCollection', coordinates: [] }), /不受支持/);
  assert.throws(() => bboxOf({ type: 'Rectangle', coordinates: [] }), /不受支持/);
});

test('退化输入：缺少 type / coordinates 抛错', () => {
  assert.throws(() => bboxOf({ coordinates: [0, 0] }), /type/);
  assert.throws(() => bboxOf({ type: 'Point' }), /coordinates/);
});

test('退化输入：pointInPolygon 传了非面几何抛错', () => {
  assert.throws(() => pointInPolygon([1, 1], point(1, 1)), /面几何/);
  assert.throws(() => pointInPolygon([1, 1], { type: 'LineString', coordinates: [[0, 0], [1, 1]] }), /面几何/);
});

/* ───────────────── 包围盒 ───────────────── */

test('包围盒：空几何返回 null，有几何时给出四个界', () => {
  assert.equal(bboxOf(null), null);
  assert.equal(bboxOf(undefined), null);
  assert.deepEqual(bboxOf(SQUARE), { minX: 0, minY: 0, maxX: 10, maxY: 10 });
  assert.deepEqual(bboxOf(point(3, 4)), { minX: 3, minY: 4, maxX: 3, maxY: 4 });
});

test('包围盒：未闭合的环照样能算（环按隐式闭合处理）', () => {
  const unclosed = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]]] };
  assert.deepEqual(bboxOf(unclosed), { minX: 0, minY: 0, maxX: 10, maxY: 10 });
});
