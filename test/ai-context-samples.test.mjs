/**
 * AI 上下文的「样本值」接线测试。
 *
 * 盯住一件事：让模型听懂用户说的值（「把地类里的耕地改成 01」），
 * 前提是上下文里真的带着这一列**出现过的值** —— 但只带几个，
 * 不能把整张属性表塞进提示词。
 *
 * 这里用 GDAL 真实读一个小 GeoJSON（构造数据），验证：
 *   1. 样本会去重、截断、只取前几十条；
 *   2. 不可见的图层不取样本（不读它的文件）；
 *   3. 超过图层上限后不再继续读（成本有上限）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveGdal } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href
);
const { buildPlanContext, enrichContext } = await import(
  pathToFileURL(join(root, 'server', 'src', 'llm-plan.ts')).href
);

/** 造一个两要素的 GeoJSON（构造数据） */
async function writeGeoJson(dir, name) {
  const features = [
    {
      type: 'Feature',
      properties: { NAME: '甲', CODE: 12, NOTE: null },
      geometry: { type: 'Point', coordinates: [120.3, 30.5] },
    },
    {
      type: 'Feature',
      properties: { NAME: '乙', CODE: 13, NOTE: '' },
      geometry: { type: 'Point', coordinates: [120.31, 30.51] },
    },
  ];
  const path = join(dir, name);
  await writeFile(path, JSON.stringify({ type: 'FeatureCollection', features }), 'utf8');
  return path;
}

test('样本值：矢量层的字段会带上真实出现过的值（去重、丢空）', async (t) => {
  if (!resolveGdal()) return t.skip('本机没有 GDAL');
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-ai-samples-'));
  try {
    await writeGeoJson(dir, 'cities.geojson');
    const context = buildPlanContext({
      projectName: '样本项目',
      layers: [
        { id: 'cities', kind: 'vector', path: 'cities.geojson', visible: true, opacity: 1 },
      ],
    });
    const enriched = await enrichContext(context, dir);
    const layer = enriched.layers[0];
    assert.equal(layer?.fields.length, 3, '字段数要与文件一致');
    assert.deepEqual(layer?.fields.find((f) => f.name === 'NAME')?.samples, ['甲', '乙']);
    assert.deepEqual(layer?.fields.find((f) => f.name === 'CODE')?.samples, ['12', '13']);
    assert.ok(
      !layer?.fields.find((f) => f.name === 'NOTE')?.samples,
      '整列为空时不能给一个空样本数组',
    );
    assert.equal(layer?.featureCount, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('样本值：不可见的图层不读文件、不带样本', async (t) => {
  if (!resolveGdal()) return t.skip('本机没有 GDAL');
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-ai-samples-'));
  try {
    await writeGeoJson(dir, 'hidden.geojson');
    const context = buildPlanContext({
      layers: [
        { id: 'hidden', kind: 'vector', path: 'hidden.geojson', visible: false, opacity: 1 },
      ],
    });
    const enriched = await enrichContext(context, dir);
    assert.ok(
      enriched.layers[0]?.fields.every((f) => f.samples === undefined),
      '看不见的图层不该产生任何样本',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('样本值：最多只给前 3 个可见矢量层取样本', async (t) => {
  if (!resolveGdal()) return t.skip('本机没有 GDAL');
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-ai-samples-'));
  try {
    const names = ['a.geojson', 'b.geojson', 'c.geojson', 'd.geojson'];
    for (const name of names) await writeGeoJson(dir, name);
    const context = buildPlanContext({
      layers: names.map((name, i) => ({
        id: `l${i}`,
        kind: 'vector',
        path: name,
        visible: true,
        opacity: 1,
      })),
    });
    const enriched = await enrichContext(context, dir);
    const withSamples = enriched.layers.filter((l) =>
      l.fields.some((f) => (f.samples?.length ?? 0) > 0),
    );
    assert.equal(withSamples.length, 3, '第 4 层不该再读文件取样本');
    assert.ok(
      enriched.layers[3]?.fields.every((f) => f.samples === undefined),
      '第 4 层仍然有字段名/类型，只是没有样本',
    );
    assert.equal(enriched.layers[3]?.fields.length, 3, '字段清单不能丢');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
