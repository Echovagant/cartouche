/**
 * 超大 GeoPackage 改属性的跨列引用（顺序语义）验收。
 *
 * 普通路径（JS 逐条顺序求值）里，同一个 set 中后面的表达式能看到前面刚改的值。
 * 流式路径用「标记列冻结命中行 + 按声明顺序逐列 UPDATE」实现同一语义：
 *  - b = a + 1、a = a * 2 → b 用的是 a 的旧值；
 *  - 条件（WHERE）只按改动前的值算一次 —— 目标列出现在条件里也不能让命中集漂移；
 *  - 标记列用完必须删掉（图层结构不能脏）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { probeLayer, readFeatures } = await import(eng('vector/read.ts'));
const { gpkgStreamSetAttributes } = await import(eng('vector/stream-gpkg-edit.ts'));
const { parseExpression } = await import(eng('expression/index.ts'));
const { columnKindOf } = await import(eng('feature/common.ts'));

const loc = resolveGdal();
if (!loc) throw new Error('本机没有 GDAL，这组用例跑不了');

const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || join(root, '.tmp-test');
let dir = '';

const BASE_FEATURES = [
  { type: 'Feature', properties: { 甲: 2, 乙: 0, 组: 'A' }, geometry: { type: 'Point', coordinates: [0, 0] } },
  { type: 'Feature', properties: { 甲: 50, 乙: 0, 组: 'B' }, geometry: { type: 'Point', coordinates: [1, 1] } },
];

async function makeBase() {
  const geojson = join(dir, 'base.geojson');
  writeFileSync(geojson, JSON.stringify({ type: 'FeatureCollection', features: BASE_FEATURES }), 'utf8');
  const target = join(dir, 'base.gpkg');
  const res = await tools(loc).ogr2ogr(['-f', 'GPKG', '-a_srs', 'EPSG:3857', target, geojson]);
  assert.ok(res.ok, `造 GPKG 失败：${res.stderr}`);
}

function copyGpkg(asName) {
  cpSync(join(dir, 'base.gpkg'), join(dir, `${asName}.gpkg`));
  return `${asName}.gpkg`;
}

async function streamSet(store, targetRel, whereSrc, setSpec) {
  const abs = store.resolve(targetRel);
  const info = await probeLayer(loc, abs);
  const targets = Object.entries(setSpec).map(([key, raw]) => {
    const field = info.fields.find((f) => f.name.toLowerCase() === key.toLowerCase());
    assert.ok(field, `应当有「${key}」这一列`);
    const value =
      raw && typeof raw === 'object' && 'expression' in raw
        ? { kind: 'expression', node: parseExpression(raw.expression), source: raw.expression }
        : { kind: 'literal', value: raw };
    return {
      name: field.name,
      requested: key,
      kind: columnKindOf(field.type),
      value,
    };
  });
  return gpkgStreamSetAttributes(loc, store, {
    targetRel,
    absPath: abs,
    info,
    whereSource: whereSrc,
    whereNode: parseExpression(whereSrc),
    targets,
    dryRun: false,
  });
}

before(async () => {
  mkdirSync(TMP_BASE, { recursive: true });
  dir = mkdtempSync(join(TMP_BASE, 'cartouche-gpkg-cross-'));
  await makeBase();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('跨列引用：后面的表达式用旧值（b = a + 1 与 a = a * 2 同批）', async () => {
  const store = new LocalFolderStore(dir);
  const targetRel = copyGpkg('seq');
  await streamSet(store, targetRel, '甲 > 0', {
    乙: { expression: '甲 + 1' },
    甲: { expression: '甲 * 2' },
  });
  const after = await readFeatures(loc, { path: store.resolve(targetRel) });
  // 甲=2 的行：乙 = 2+1 = 3（旧值），甲 = 4（新值）。若 SQL 一次性 SET，
  // 乙会看到改过的甲（4+1=5）—— 这是两种语义的分水岭。
  const row = after.features.find((f) => f.properties['甲'] === 4);
  assert.ok(row, '应当有甲被翻倍的行');
  assert.equal(row.properties['乙'], 3, '乙必须按甲的旧值算（顺序语义）');
  // 甲=50 的行：乙 = 51，甲 = 100
  const row2 = after.features.find((f) => f.properties['甲'] === 100);
  assert.ok(row2, '另一行也应被翻倍');
  assert.equal(row2.properties['乙'], 51);
});

test('条件引用目标列：命中行集合冻结，值按顺序语义更新', async () => {
  const store = new LocalFolderStore(dir);
  const targetRel = copyGpkg('where');
  // 条件 甲 < 10 只命中第一行（按改动前的值算一次，命中集不再漂移）；
  // 命中行内部仍按顺序语义：乙 = 甲 × 2 看到的是刚改过的甲（100）→ 200。
  await streamSet(store, targetRel, '甲 < 10', {
    甲: 100,
    乙: { expression: '甲 * 2' },
  });
  const after = await readFeatures(loc, { path: store.resolve(targetRel) });
  const hit = after.features.find((f) => f.properties['组'] === 'A');
  assert.equal(hit.properties['甲'], 100, '命中行的甲被改掉');
  assert.equal(hit.properties['乙'], 200, '乙按顺序语义算：100 × 2 = 200');
  const missed = after.features.find((f) => f.properties['组'] === 'B');
  assert.equal(missed.properties['甲'], 50, '未命中的行不能被碰到');
  assert.equal(missed.properties['乙'], 0, '未命中的行乙必须原样');
});

test('标记列用完即删：写完的图层结构与原来一致', async () => {
  const store = new LocalFolderStore(dir);
  const targetRel = copyGpkg('schema');
  await streamSet(store, targetRel, '甲 > 0', {
    乙: { expression: '甲 + 1' },
    甲: { expression: '甲 * 2' },
  });
  const info = await probeLayer(loc, store.resolve(targetRel));
  const names = info.fields.map((f) => f.name);
  assert.ok(!names.some((n) => n.startsWith('__cartouche_')), '标记列不能留在图层里');
  assert.deepEqual(names.filter((n) => ['甲', '乙', '组'].includes(n)), ['甲', '乙', '组'], '原有列一个不少');
});
