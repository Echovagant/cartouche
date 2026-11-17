/**
 * 符号化与标注的纯逻辑验收。
 *
 * 这些函数决定图上每一块颜色和每一个标注的位置：
 * 改错一个断点或一个类型键，界面不会报错，只会悄悄涂错。
 * 所以这里不测 React，只把「颜色/类别/断点/锚点」钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(
  pathToFileURL(join(root, 'web', 'app', 'canvas', 'symbology.ts')).href
);
const {
  buildPalette,
  categoryKey,
  categoryLabel,
  computeBreaks,
  distinctCategories,
  labelAnchor,
  labelText,
  legendItemsForLayer,
  makeGraduatedSymbology,
  makeUniqueSymbology,
  symbologyColorExpression,
} = mod;

const feature = (properties, coordinates) => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Point', coordinates },
});

const data = {
  type: 'FeatureCollection',
  features: [
    feature({ kind: 'A', n: 1, name: '甲' }, [1, 2]),
    feature({ kind: 'B', n: 2, name: '乙' }, [3, 4]),
    feature({ kind: 'A', n: 3, name: '' }, [5, 6]),
  ],
};

test('类别键带类型前缀：数字 1 与文字 "1" 不混', () => {
  assert.notEqual(categoryKey(1), categoryKey('1'));
  assert.equal(categoryKey(null), 'null:');
  assert.equal(categoryLabel('string:河流'), '河流');
  assert.equal(categoryLabel('null:'), '（空值）');
});

test('色带取色固定：同一色带 + 同一类别数永远同一组颜色', () => {
  const a = buildPalette('forest', 3);
  const b = buildPalette('forest', 3);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  assert.equal(buildPalette('forest', 1).length, 1);
  assert.equal(buildPalette('forest', 7).length, 7);
});

test('唯一值统计按次数降序，空值也有类别', () => {
  const counts = distinctCategories(
    { type: 'FeatureCollection', features: [...data.features, feature({ kind: null }, [0, 0])] },
    'kind',
  );
  assert.equal(counts[0].label, 'A');
  assert.equal(counts[0].count, 2);
  assert.ok(counts.some((c) => c.label === '（空值）'));
});

test('等间隔断点：升序、数量对、覆盖最小到最大', () => {
  const breaks = computeBreaks([0, 10], 5, 'equal');
  assert.equal(breaks.length, 4);
  assert.ok(breaks[0] > 0 && breaks[breaks.length - 1] < 10);
  for (let i = 1; i < breaks.length; i += 1) assert.ok(breaks[i] > breaks[i - 1]);
});

test('分位数断点：重复值被合并，仍然严格递增', () => {
  const breaks = computeBreaks([1, 1, 1, 1, 2, 3, 4, 5], 5, 'quantile');
  for (let i = 1; i < breaks.length; i += 1) assert.ok(breaks[i] > breaks[i - 1]);
});

test('全部值相同 / 没有数值 → 不给假断点', () => {
  assert.deepEqual(computeBreaks([7, 7, 7], 5, 'equal'), []);
  assert.deepEqual(computeBreaks([], 5, 'equal'), []);
});

test('唯一值配色：每个类别都有颜色，兜底色存在', () => {
  const sym = makeUniqueSymbology(data, 'kind', 'forest', 12);
  assert.equal(sym.kind, 'unique');
  assert.ok(sym.colors['string:A']);
  assert.ok(sym.colors['string:B']);
  assert.ok(sym.fallback.startsWith('#'));
});

test('分级配色：颜色数 = 断点数 + 1', () => {
  const sym = makeGraduatedSymbology(
    {
      type: 'FeatureCollection',
      features: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n, i) => feature({ n }, [i, i])),
    },
    'n',
    'equal',
    5,
  );
  assert.equal(sym.colors.length, sym.breaks.length + 1);
});

test('MapLibre 颜色表达式：唯一值用 match，分级用 step', () => {
  const unique = makeUniqueSymbology(data, 'kind');
  const expr = symbologyColorExpression(unique);
  assert.ok(Array.isArray(expr));
  assert.equal(expr[0], 'match');
  assert.ok(expr.includes('string:A'));

  const graduated = {
    kind: 'graduated',
    field: 'n',
    method: 'equal',
    breaks: [3],
    colors: ['#111111', '#222222'],
  };
  const step = symbologyColorExpression(graduated);
  assert.equal(step[0], 'step');
  assert.ok(step.includes(3), '断点 3 应当出现在 step 表达式里');
});

test('图例：唯一值一类一条，分级一个区间一条', () => {
  const unique = makeUniqueSymbology(data, 'kind');
  const items = legendItemsForLayer('土地利用.shp', unique);
  assert.ok(items.length >= 2);
  assert.ok(items.some((i) => i.name.includes('A')));

  const graduated = {
    kind: 'graduated',
    field: 'n',
    method: 'equal',
    breaks: [3],
    colors: ['#111111', '#222222'],
  };
  const grad = legendItemsForLayer('地形.tif', graduated);
  assert.equal(grad.length, 2);
  assert.match(grad[0].name, /地形/);
});

test('标注锚点：点取坐标、线取中点、面取外环平均', () => {
  assert.deepEqual(labelAnchor({ type: 'Point', coordinates: [120, 30] }), [120, 30]);
  assert.deepEqual(
    labelAnchor({ type: 'LineString', coordinates: [[0, 0], [2, 2], [4, 4]] }),
    [2, 2],
  );
  const poly = labelAnchor({
    type: 'Polygon',
    coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
  });
  assert.deepEqual(poly, [0.8, 0.8]);
  assert.equal(labelAnchor(null), null);
});

test('标注文本：空值/空串不标', () => {
  assert.equal(labelText({ name: '甲' }, 'name'), '甲');
  assert.equal(labelText({ name: '  ' }, 'name'), null);
  assert.equal(labelText({}, 'name'), null);
  assert.equal(labelText(undefined, 'name'), null);
});
