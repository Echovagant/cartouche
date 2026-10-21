import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  cimToMapLibreLayers,
  describeRenderer,
  cimColorToCss,
  cimRgbToRgba,
  cimHsvToRgba,
  pickLayerType,
  toLayerId,
} = await import(pathToFileURL(join(root, 'src', 'engine', 'style', 'index.ts')).href);

/* ────────── 颜色 ────────── */

test('CIMRGBColor → rgba：alpha 是 0~100 的不透明度', () => {
  assert.equal(cimRgbToRgba({ type: 'CIMRGBColor', values: [255, 0, 0, 100] }), 'rgba(255, 0, 0, 1)');
  assert.equal(cimRgbToRgba({ type: 'CIMRGBColor', values: [0, 128, 255, 50] }), 'rgba(0, 128, 255, 0.5)');
  // 缺 alpha 视为不透明
  assert.equal(cimRgbToRgba({ type: 'CIMRGBColor', values: [10, 20, 30] }), 'rgba(10, 20, 30, 1)');
});

test('CIMRGBColor：非法输入返回 undefined 而不是瞎猜', () => {
  assert.equal(cimRgbToRgba(undefined), undefined);
  assert.equal(cimRgbToRgba({ type: 'CIMRGBColor', values: [1, 2] }), undefined);
  assert.equal(cimRgbToRgba({ type: 'CIMRGBColor', values: ['a', 'b', 'c'] }), undefined);
});

test('CIMHSVColor → rgba：色相环换算正确', () => {
  // H=0(红) S=100 V=100
  assert.equal(cimHsvToRgba({ type: 'CIMHSVColor', values: [0, 100, 100, 100] }), 'rgba(255, 0, 0, 1)');
  // H=120(绿)
  assert.equal(cimHsvToRgba({ type: 'CIMHSVColor', values: [120, 100, 100, 100] }), 'rgba(0, 255, 0, 1)');
  // H=240(蓝)
  assert.equal(cimHsvToRgba({ type: 'CIMHSVColor', values: [240, 100, 100, 100] }), 'rgba(0, 0, 255, 1)');
});

test('cimColorToCss：按 type 分派，无 type 时按取值范围猜', () => {
  assert.equal(cimColorToCss({ type: 'CIMRGBColor', values: [1, 2, 3, 100] }), 'rgba(1, 2, 3, 1)');
  assert.equal(cimColorToCss({ values: [4, 5, 6, 100] }), 'rgba(4, 5, 6, 1)');
  assert.equal(cimColorToCss({ type: 'CIMSomethingElse', values: [1, 2, 3] }), undefined);
});

/* ────────── 几何与符号类型 ────────── */

test('pickLayerType：几何类型优先，其次从符号类型反推', () => {
  assert.equal(pickLayerType('esriGeometryPoint'), 'circle');
  assert.equal(pickLayerType('esriGeometryPolyline'), 'line');
  assert.equal(pickLayerType('esriGeometryPolygon'), 'fill');
  assert.equal(pickLayerType(undefined, 'CIMSimpleMarkerSymbol'), 'circle');
  assert.equal(pickLayerType(undefined, 'CIMSimpleLineSymbol'), 'line');
  assert.equal(pickLayerType(undefined, 'CIMSimpleFillSymbol'), 'fill');
  assert.equal(pickLayerType(undefined, undefined), 'fill');
});

test('toLayerId：保留中文，非法字符转下划线，空名兜底', () => {
  assert.equal(toLayerId('县界', 0), '县界');
  assert.equal(toLayerId('Roads / Streets', 0), 'Roads_Streets');
  assert.equal(toLayerId('  ', 3), 'layer_3');
});

/* ────────── 简单渲染器 ────────── */

const simpleCim = {
  type: 'CIMDocument',
  version: '2.9.0',
  layers: [
    {
      type: 'CIMPathLayer',
      name: 'Roads',
      geometryType: 'esriGeometryLine',
      renderer: {
        type: 'CIMSimpleRenderer',
        symbol: {
          type: 'CIMSimpleLineSymbol',
          color: { type: 'CIMRGBColor', values: [255, 0, 0, 100] },
          width: 2,
          style: 'Dash',
        },
      },
    },
  ],
};

test('简单渲染器：线图层 → line 图层，样式一一对应', () => {
  const res = cimToMapLibreLayers(simpleCim, { source: 'src' });
  assert.equal(res.layers.length, 1);
  assert.equal(res.unsupported.length, 0);
  const l = res.layers[0];
  assert.equal(l.type, 'line');
  assert.equal(l.source, 'src');
  assert.equal(l.id, 'Roads');
  assert.equal(l.paint['line-color'], 'rgba(255, 0, 0, 1)');
  assert.equal(l.paint['line-width'], 2);
  assert.deepEqual(l.paint['line-dasharray'], [4, 2]);
});

test('简单渲染器：点 → circle，面 → fill', () => {
  const pointCim = {
    layers: [
      {
        name: 'P',
        geometryType: 'esriGeometryPoint',
        renderer: {
          type: 'CIMSimpleRenderer',
          symbol: {
            type: 'CIMSimpleMarkerSymbol',
            color: { type: 'CIMRGBColor', values: [0, 0, 255, 100] },
            size: 7,
            outlineColor: { type: 'CIMRGBColor', values: [0, 0, 0, 100] },
            outlineWidth: 1,
          },
        },
      },
    ],
  };
  const p = cimToMapLibreLayers(pointCim, { source: 's' }).layers[0];
  assert.equal(p.type, 'circle');
  assert.equal(p.paint['circle-color'], 'rgba(0, 0, 255, 1)');
  assert.equal(p.paint['circle-radius'], 7);
  assert.equal(p.paint['circle-stroke-color'], 'rgba(0, 0, 0, 1)');

  const polyCim = {
    layers: [
      {
        name: 'A',
        geometryType: 'esriGeometryPolygon',
        renderer: {
          type: 'CIMSimpleRenderer',
          symbol: {
            type: 'CIMSimpleFillSymbol',
            color: { type: 'CIMRGBColor', values: [10, 200, 10, 40] },
            outlineColor: { type: 'CIMRGBColor', values: [0, 0, 0, 100] },
            outlineWidth: 1,
          },
        },
      },
    ],
  };
  const a = cimToMapLibreLayers(polyCim, { source: 's' }).layers[0];
  assert.equal(a.type, 'fill');
  assert.equal(a.paint['fill-color'], 'rgba(10, 200, 10, 0.4)');
  assert.equal(a.paint['fill-outline-color'], 'rgba(0, 0, 0, 1)');
});

/* ────────── 唯一值渲染器 ────────── */

const uniqueCim = {
  layers: [
    {
      name: '土地',
      geometryType: 'esriGeometryPolygon',
      renderer: {
        type: 'CIMUniqueValueRenderer',
        fields: ['用地类型'],
        defaultSymbol: {
          type: 'CIMSimpleFillSymbol',
          color: { type: 'CIMRGBColor', values: [200, 200, 200, 100] },
        },
        groups: [
          {
            type: 'CIMUniqueValueGroup',
            classes: [
              {
                type: 'CIMUniqueValueClass',
                label: '耕地',
                values: [{ type: 'CIMUniqueValue', fieldValues: ['耕地'] }],
                symbol: {
                  type: 'CIMSimpleFillSymbol',
                  color: { type: 'CIMRGBColor', values: [255, 235, 130, 100] },
                },
              },
              {
                type: 'CIMUniqueValueClass',
                label: '建筑',
                values: [{ type: 'CIMUniqueValue', fieldValues: ['建筑', '工业'] }],
                symbol: {
                  type: 'CIMSimpleFillSymbol',
                  color: { type: 'CIMRGBColor', values: [200, 60, 60, 100] },
                },
              },
            ],
          },
        ],
      },
    },
  ],
};

test('唯一值渲染器 → ["match", …] 表达式，保留中文字段名', () => {
  const res = cimToMapLibreLayers(uniqueCim, { source: 'src' });
  assert.equal(res.layers.length, 1);
  assert.equal(res.unsupported.length, 0);
  const expr = res.layers[0].paint['fill-color'];
  assert.ok(Array.isArray(expr), 'fill-color 应是表达式数组');
  assert.equal(expr[0], 'match');
  assert.deepEqual(expr[1], ['to-string', ['get', '用地类型']]);
  // 三个分支 + 默认色
  assert.deepEqual(expr.slice(2), [
    '耕地', 'rgba(255, 235, 130, 1)',
    '建筑', 'rgba(200, 60, 60, 1)',
    '工业', 'rgba(200, 60, 60, 1)',
    'rgba(200, 200, 200, 1)',
  ]);
});

/* ────────── 分类断点渲染器 ────────── */

const breaksCim = {
  layers: [
    {
      name: '人口',
      geometryType: 'esriGeometryPolygon',
      renderer: {
        type: 'CIMClassBreaksRenderer',
        field: 'POP',
        breaks: [
          {
            type: 'CIMClassBreak',
            label: '高',
            upperBound: 5000,
            symbol: { type: 'CIMSimpleFillSymbol', color: { type: 'CIMRGBColor', values: [200, 0, 0, 100] } },
          },
          {
            type: 'CIMClassBreak',
            label: '中',
            upperBound: 1000,
            symbol: { type: 'CIMSimpleFillSymbol', color: { type: 'CIMRGBColor', values: [255, 200, 0, 100] } },
          },
          {
            type: 'CIMClassBreak',
            label: '低',
            upperBound: 100,
            symbol: { type: 'CIMSimpleFillSymbol', color: { type: 'CIMRGBColor', values: [0, 200, 0, 100] } },
          },
        ],
      },
    },
  ],
};

test('分类断点渲染器 → ["step", …]，断点按 upperBound 升序排列', () => {
  const res = cimToMapLibreLayers(breaksCim, { source: 'src' });
  const expr = res.layers[0].paint['fill-color'];
  assert.ok(Array.isArray(expr));
  assert.equal(expr[0], 'step');
  assert.deepEqual(expr[1], ['get', 'POP']);
  // 输入给的顺序是 高/中/低，转换后必须按 upperBound 升序
  assert.deepEqual(expr.slice(2), [
    'rgba(0, 200, 0, 1)',  // ≤100 低
    100, 'rgba(255, 200, 0, 1)', // ≤1000 中
    1000, 'rgba(200, 0, 0, 1)', // ≤5000 高
  ]);
});

/* ────────── 符号引用与异常路径 ────────── */

test('CIMSymbolReference：能按 symbolID 回查到符号表里的符号', () => {
  const cim = {
    symbols: [
      {
        type: 'CIMSimpleFillSymbol',
        symbolID: 'sym-1',
        color: { type: 'CIMRGBColor', values: [1, 2, 3, 100] },
      },
    ],
    layers: [
      {
        name: 'L',
        geometryType: 'esriGeometryPolygon',
        renderer: {
          type: 'CIMSimpleRenderer',
          symbol: { type: 'CIMSymbolReference', symbolID: 'sym-1' },
        },
      },
    ],
  };
  const res = cimToMapLibreLayers(cim, { source: 's' });
  assert.equal(res.layers[0].paint['fill-color'], 'rgba(1, 2, 3, 1)');
});

test('不支持的渲染器类型：归入 unsupported 并给 warning，不抛异常', () => {
  const cim = {
    layers: [
      {
        name: 'X',
        geometryType: 'esriGeometryPolygon',
        renderer: { type: 'CIMHillshadeRenderer' },
      },
    ],
  };
  const res = cimToMapLibreLayers(cim, { source: 's' });
  assert.equal(res.layers.length, 0);
  assert.deepEqual(res.unsupported, ['CIMHillshadeRenderer']);
  assert.ok(res.warnings.some((w) => w.includes('CIMHillshadeRenderer')));
});

test('坏输入不崩：非对象 / 空文档 / 无图层', () => {
  assert.equal(cimToMapLibreLayers(null, { source: 's' }).layers.length, 0);
  assert.equal(cimToMapLibreLayers('x', { source: 's' }).layers.length, 0);
  const empty = cimToMapLibreLayers({}, { source: 's' });
  assert.equal(empty.layers.length, 0);
  assert.ok(empty.warnings.length > 0);
});

test('唯一值渲染器缺字段时退回默认符号并给 warning', () => {
  const cim = {
    layers: [
      {
        name: 'L',
        geometryType: 'esriGeometryPolygon',
        renderer: {
          type: 'CIMUniqueValueRenderer',
          defaultSymbol: { type: 'CIMSimpleFillSymbol', color: { type: 'CIMRGBColor', values: [9, 9, 9, 100] } },
        },
      },
    ],
  };
  const res = cimToMapLibreLayers(cim, { source: 's' });
  assert.equal(res.layers[0].paint['fill-color'], 'rgba(9, 9, 9, 1)');
  assert.ok(res.warnings.some((w) => w.includes('fields')));
});

test('describeRenderer：能说出图层用了哪几类渲染器', () => {
  const d = describeRenderer(uniqueCim);
  assert.ok(d.includes('CIMUniqueValueRenderer'));
  assert.ok(d.includes('用地类型'));
});

test('sourceLayer 与 idPrefix 会透传到图层上', () => {
  const res = cimToMapLibreLayers(simpleCim, { source: 'src', sourceLayer: 'roads', idPrefix: 'lyrx' });
  assert.equal(res.layers[0]['source-layer'], 'roads');
  assert.equal(res.layers[0].id, 'lyrx-Roads');
});
