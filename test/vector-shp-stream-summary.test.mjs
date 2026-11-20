/**
 * 超大 Shapefile 流式分组汇总的验收。
 *
 * 同一份小 Shapefile：普通路径（runFeatureSummarize）与流式路径（shpStreamSummarize）
 * 的分组结果必须完全一致 —— 列名、行数、每行的值。再验三件事：
 * 删除标记不参与汇总、area/length 明确拒收、GBK 文件分组正常。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { probeLayer } = await import(eng('vector/read.ts'));
const { runFeatureSummarize } = await import(eng('feature/summarize.ts'));
const { shpStreamSummarize } = await import(eng('vector/stream-shp-summary.ts'));
const { shpStreamDelete } = await import(eng('vector/stream-shp-edit.ts'));
const { parseExpression } = await import(eng('expression/index.ts'));

const loc = resolveGdal();
if (!loc) throw new Error('本机没有 GDAL，这组用例跑不了');

const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || join(root, '.tmp-test');
const SHP_SIDECARS = ['.shp', '.shx', '.dbf', '.prj', '.cpg'];
let dir = '';

function features() {
  return [
    { type: 'Feature', properties: { 名称: '甲', 编码: 1, 数值: 1.5 }, geometry: { type: 'Point', coordinates: [0, 0] } },
    { type: 'Feature', properties: { 名称: '乙', 编码: 2, 数值: 2.5 }, geometry: { type: 'Point', coordinates: [1, 1] } },
    { type: 'Feature', properties: { 名称: '甲', 编码: 2, 数值: 3.5 }, geometry: { type: 'Point', coordinates: [2, 2] } },
    { type: 'Feature', properties: { 名称: '丙', 编码: 3, 数值: null }, geometry: { type: 'Point', coordinates: [3, 3] } },
  ];
}

async function makeShp(name, encoding = 'UTF-8') {
  const geojson = join(dir, `${name}.geojson`);
  writeFileSync(geojson, JSON.stringify({ type: 'FeatureCollection', features: features() }), 'utf8');
  const target = join(dir, `${name}.shp`);
  const res = await tools(loc).ogr2ogr([
    '-f', 'ESRI Shapefile', '-lco', `ENCODING=${encoding}`, '-a_srs', 'EPSG:3857',
    target, geojson,
  ]);
  assert.ok(res.ok, `造 Shapefile 失败：${res.stderr}`);
  return target;
}

function copyShp(fromName, toName) {
  for (const ext of SHP_SIDECARS) {
    const src = join(dir, `${fromName}${ext}`);
    if (existsSync(src)) cpSync(src, join(dir, `${toName}${ext}`));
  }
}

const AGGREGATES = ['count', 'sum', 'mean', 'min', 'max', 'distinct'];

async function streamSummary(store, targetRel, groupBy, aggregates = AGGREGATES) {
  const abs = store.resolve(targetRel);
  const info = await probeLayer(loc, abs);
  const groupFields = groupBy.map((name) => info.fields.find((f) => f.name === name));
  assert.ok(groupFields.every(Boolean), '分组列必须存在');
  const groupKeySet = new Set(groupBy.map((n) => n.toLowerCase()));
  return shpStreamSummarize(loc, {
    targetRel,
    absPath: abs,
    info,
    groupFields,
    groupNames: groupBy,
    aggregates,
    numericFields: info.fields.filter(
      (f) => !groupKeySet.has(f.name.toLowerCase()) &&
        (f.type === 'Integer' || f.type === 'Real' || f.type === 'Integer64'),
    ),
    distinctFields: info.fields.filter((f) => !groupKeySet.has(f.name.toLowerCase())),
    wantsArea: aggregates.includes('area'),
    wantsLength: aggregates.includes('length'),
    dryRun: false,
  });
}

function stripVolatile(res) {
  // 比较数据本体（列、行、组数）。caveats 有意不同：流式路径会多一条
  // 「按 DBF 流式汇总，分组按文件顺序」的口径说明 —— 那是披露，不是数据。
  const { rows, columns, groupCount, featureCount } = res.data;
  return { rows, columns, groupCount, featureCount };
}

before(async () => {
  mkdirSync(TMP_BASE, { recursive: true });
  dir = mkdtempSync(join(TMP_BASE, 'cartouche-shp-summary-'));
  await makeShp('base');
  await makeShp('gbk', 'GBK');
  copyShp('base', 'deleted');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('流式汇总与普通路径对拍：列、行、值完全一致', async () => {
  const store = new LocalFolderStore(dir);
  const normal = await runFeatureSummarize(
    { target: 'dataset://base.shp', groupBy: ['名称'], aggregates: AGGREGATES },
    { loc, store },
    false,
  );
  const streamed = await streamSummary(store, 'base.shp', ['名称']);
  assert.deepEqual(stripVolatile(streamed), stripVolatile(normal));
  assert.equal(streamed.data.streamed, true);
});

test('删除标记不参与汇总：流式删除一条后总数与分组同步减少', async () => {
  const store = new LocalFolderStore(dir);
  const abs = store.resolve('deleted.shp');
  const info = await probeLayer(loc, abs);
  await shpStreamDelete(loc, store, {
    targetRel: 'deleted.shp',
    absPath: abs,
    info,
    whereSource: '编码 = 1',
    whereNode: parseExpression('编码 = 1'),
    keep: 'none',
    dryRun: false,
  });
  const res = await streamSummary(store, 'deleted.shp', ['名称']);
  assert.equal(res.data.featureCount, 3, '删除标记的记录不应参与汇总');
  const names = res.data.rows.map((r) => r['名称']).sort();
  assert.deepEqual(names, ['丙', '乙', '甲'].sort(), '被删的那一组不应出现（按文件顺序）');
});

test('流式路径拒收 area / length，并说明原因与出路', async () => {
  const store = new LocalFolderStore(dir);
  await assert.rejects(
    () => streamSummary(store, 'base.shp', ['名称'], ['count', 'area']),
    /area \/ length/,
  );
  await assert.rejects(
    () => streamSummary(store, 'base.shp', ['名称'], ['count', 'length']),
    /area \/ length/,
  );
});

test('dryRun 标记会出现在结果里（汇总本就不写盘）', async () => {
  const store = new LocalFolderStore(dir);
  const abs = store.resolve('base.shp');
  const info = await probeLayer(loc, abs);
  const groupFields = [info.fields.find((f) => f.name === '名称')];
  const res = await shpStreamSummarize(loc, {
    targetRel: 'base.shp',
    absPath: abs,
    info,
    groupFields,
    groupNames: ['名称'],
    aggregates: ['count'],
    numericFields: [],
    distinctFields: info.fields.filter((f) => f.name !== '名称'),
    wantsArea: false,
    wantsLength: false,
    dryRun: true,
  });
  assert.equal(res.data.dryRun, true);
  assert.match(res.summary, /预演/);
});

test('GBK 文件流式汇总与普通路径一致（中文分组值不乱码）', async () => {
  const store = new LocalFolderStore(dir);
  const normal = await runFeatureSummarize(
    { target: 'dataset://gbk.shp', groupBy: ['名称'], aggregates: ['count', 'sum'] },
    { loc, store },
    false,
  );
  const streamed = await streamSummary(store, 'gbk.shp', ['名称'], ['count', 'sum']);
  assert.deepEqual(stripVolatile(streamed), stripVolatile(normal));
});
