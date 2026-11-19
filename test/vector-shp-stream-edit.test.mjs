/**
 * 超大 Shapefile 的流式编辑验收（DBF 层）。
 *
 * 用同一份小 Shapefile 的两份副本对拍：
 *  - 普通路径（executePlan，512 MB 以下走 GDAL 整层写回）；
 *  - 流式路径（直接调 shpStream*）。
 *
 * 比较的是 GDAL 读回来的属性值，而不是字节 —— 普通路径会重排列宽/类型，
 * 流式路径保留原字节，两者在"用户看到的数据"这一层必须一致。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync,
  cpSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { probeLayer, readFeatures } = await import(eng('vector/read.ts'));
const { executePlan, previewOp } = await import(eng('ops/index.ts'));
const {
  shpStreamSetAttributes,
  shpStreamAddField,
  shpStreamDelete,
} = await import(eng('vector/stream-shp-edit.ts'));
const { parseExpression } = await import(eng('expression/index.ts'));
const { columnKindOf } = await import(eng('feature/common.ts'));

const loc = resolveGdal();
if (!loc) throw new Error('本机没有 GDAL，这组用例跑不了');

const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || join(root, '.tmp-test');
const SHP_SIDECARS = ['.shp', '.shx', '.dbf', '.prj', '.cpg'];
let dir = '';

function features() {
  return [
    { type: 'Feature', properties: { 名称: '甲', 编码: 1, 数值: 1.5 }, geometry: { type: 'Point', coordinates: [0, 0] } },
    { type: 'Feature', properties: { 名称: '乙', 编码: 2, 数值: 2.5 }, geometry: { type: 'Point', coordinates: [1, 1] } },
    { type: 'Feature', properties: { 名称: '丙', 编码: 2, 数值: 3.5 }, geometry: { type: 'Point', coordinates: [2, 2] } },
    { type: 'Feature', properties: { 名称: '丁', 编码: 3, 数值: null }, geometry: { type: 'Point', coordinates: [3, 3] } },
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

function propsOf(featuresRead) {
  return featuresRead.features.map((f) => ({ ...f.properties }));
}

async function normal(store, op, params) {
  const res = await executePlan({ loc, store }, { op, params });
  assert.equal(res.ok, true, res.results[0]?.error ?? `${op} 普通路径应当成功`);
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
  return shpStreamSetAttributes(loc, store, {
    targetRel,
    absPath: abs,
    info,
    whereSource: whereSrc,
    whereNode: parseExpression(whereSrc),
    targets,
    dryRun: false,
  });
}

async function streamAdd(store, targetRel, fieldName, expression, whereSrc) {
  const abs = store.resolve(targetRel);
  const info = await probeLayer(loc, abs);
  return shpStreamAddField(loc, store, {
    targetRel,
    absPath: abs,
    info,
    fieldName,
    exprNode: parseExpression(expression),
    whereNode: whereSrc ? parseExpression(whereSrc) : null,
    dryRun: false,
  });
}

async function streamDelete(store, targetRel, whereSrc, keep) {
  const abs = store.resolve(targetRel);
  const info = await probeLayer(loc, abs);
  return shpStreamDelete(loc, store, {
    targetRel,
    absPath: abs,
    info,
    whereSource: whereSrc,
    whereNode: parseExpression(whereSrc),
    keep,
    dryRun: false,
  });
}

before(async () => {
  mkdirSync(TMP_BASE, { recursive: true });
  dir = mkdtempSync(join(TMP_BASE, 'cartouche-shp-stream-'));
  await makeShp('base');
  await makeShp('gbk', 'GBK');
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/* ── 改属性 ──────────────────────────────────────────────────── */

test('流式改属性：字面值 / 表达式 / 整数取整都与普通路径一致', async () => {
  copyShp('base', 'set-normal');
  copyShp('base', 'set-stream');
  const store = new LocalFolderStore(dir);

  await normal(store, 'feature.setAttributes', {
    target: 'dataset://set-normal.shp',
    where: '编码 = 2',
    set: { 名称: '新名', 数值: 9 },
  });
  const streamed = await streamSet(store, 'set-stream.shp', '编码 = 2', {
    名称: '新名',
    数值: 9,
  });
  assert.match(streamed.summary, /已改 2 条要素/);

  const want = propsOf(await readFeatures(loc, { path: join(dir, 'set-normal.shp') }));
  const got = propsOf(await readFeatures(loc, { path: join(dir, 'set-stream.shp') }));
  assert.deepEqual(got, want);

  // 表达式 + 整数列取整
  copyShp('base', 'set-expr-normal');
  copyShp('base', 'set-expr-stream');
  await normal(store, 'feature.setAttributes', {
    target: 'dataset://set-expr-normal.shp',
    where: '编码 >= 2',
    set: { 编码: { expression: '数值 + 0.1' } },
  });
  const rounded = await streamSet(store, 'set-expr-stream.shp', '编码 >= 2', {
    编码: { expression: '数值 + 0.1' },
  });
  assert.match(rounded.summary, /四舍五入/);
  assert.deepEqual(
    propsOf(await readFeatures(loc, { path: join(dir, 'set-expr-stream.shp') })),
    propsOf(await readFeatures(loc, { path: join(dir, 'set-expr-normal.shp') })),
  );
});

test('流式改属性：文字超过列宽时按字符边界截断（保留原列宽）', async () => {
  copyShp('base', 'set-cut-stream');
  const store = new LocalFolderStore(dir);
  const long = 'X'.repeat(120);
  // 普通路径（GDAL 整层写回）会按值把列宽排到 120；流式路径保留原列宽 80 并截断。
  const res = await streamSet(store, 'set-cut-stream.shp', '编码 = 1', { 名称: long });
  assert.match(res.summary, /截断/);
  const got = propsOf(await readFeatures(loc, { path: join(dir, 'set-cut-stream.shp') }));
  assert.equal(String(got[0]['名称']).length, 80);
  assert.equal(got[1]['名称'], '乙', '没命中的行不能被改');
});

test('流式改属性：数字超过列宽时明确报错，原文件不动', async () => {
  copyShp('base', 'set-overflow');
  const store = new LocalFolderStore(dir);
  await assert.rejects(
    () => streamSet(store, 'set-overflow.shp', '编码 = 1', { 编码: 12345678901 }),
    /放不下/,
  );
  const got = propsOf(await readFeatures(loc, { path: join(dir, 'set-overflow.shp') }));
  assert.equal(got[0]['编码'], 1, '被拒绝时原文件不能变');
});

/* ── 加字段 ──────────────────────────────────────────────────── */

test('流式加字段：文字表达式与普通路径一致', async () => {
  copyShp('base', 'add-normal');
  copyShp('base', 'add-stream');
  const store = new LocalFolderStore(dir);

  await normal(store, 'vector.addField', {
    target: 'dataset://add-normal.shp',
    name: 'TAG',
    expression: "CONCAT(名称, '-', 编码)",
    where: '编码 >= 2',
  });
  const res = await streamAdd(
    store,
    'add-stream.shp',
    'TAG',
    "CONCAT(名称, '-', 编码)",
    '编码 >= 2',
  );
  assert.match(res.summary, /已加字段/);

  const want = propsOf(await readFeatures(loc, { path: join(dir, 'add-normal.shp') }));
  const got = propsOf(await readFeatures(loc, { path: join(dir, 'add-stream.shp') }));
  assert.deepEqual(got, want);
});

test('流式加字段：数值表达式与普通路径一致', async () => {
  copyShp('base', 'add-num-normal');
  copyShp('base', 'add-num-stream');
  const store = new LocalFolderStore(dir);

  await normal(store, 'vector.addField', {
    target: 'dataset://add-num-normal.shp',
    name: '先',
    expression: '数值 * 2',
  });
  const res = await streamAdd(store, 'add-num-stream.shp', '先', '数值 * 2', null);
  assert.match(res.summary, /已加字段/);

  const want = propsOf(await readFeatures(loc, { path: join(dir, 'add-num-normal.shp') }));
  const got = propsOf(await readFeatures(loc, { path: join(dir, 'add-num-stream.shp') }));
  assert.deepEqual(got, want);
});

/* ── 删要素 ──────────────────────────────────────────────────── */

test('流式删要素：keep=none / first / last 与普通路径一致', async () => {
  const store = new LocalFolderStore(dir);
  for (const keep of ['none', 'first', 'last']) {
    const normalName = `del-${keep}-normal`;
    const streamName = `del-${keep}-stream`;
    copyShp('base', normalName);
    copyShp('base', streamName);
    const params = {
      target: `dataset://${normalName}.shp`,
      where: '编码 = 2',
      ...(keep === 'none' ? {} : { keep }),
    };
    await normal(store, 'feature.delete', params);
    const res = await streamDelete(store, `${streamName}.shp`, '编码 = 2', keep);
    if (keep !== 'none') assert.match(res.summary, /保留第/);

    const want = propsOf(await readFeatures(loc, { path: join(dir, `${normalName}.shp`) }));
    const got = propsOf(await readFeatures(loc, { path: join(dir, `${streamName}.shp`) }));
    assert.deepEqual(got, want, `keep=${keep}`);
  }
});

test('流式删要素：keep=largest 与删空图层明确拒绝', async () => {
  const store = new LocalFolderStore(dir);
  copyShp('base', 'del-reject');
  await assert.rejects(
    () => streamDelete(store, 'del-reject.shp', '编码 >= 1', 'largest'),
    /暂不支持 keep=largest/,
  );
  await assert.rejects(
    () => streamDelete(store, 'del-reject.shp', '编码 >= 1', 'none'),
    /等于清空图层/,
  );
});

/* ── GBK 编码 ────────────────────────────────────────────────── */

test('GBK Shapefile：改属性与加字段都按原编码写回', async () => {
  copyShp('gbk', 'gbk-normal');
  copyShp('gbk', 'gbk-stream');
  const store = new LocalFolderStore(dir);

  await normal(store, 'feature.setAttributes', {
    target: 'dataset://gbk-normal.shp',
    where: '编码 = 1',
    set: { 名称: '新名字' },
  });
  const res = await streamSet(store, 'gbk-stream.shp', '编码 = 1', { 名称: '新名字' });
  assert.match(res.summary, /已改 1 条要素/);
  assert.deepEqual(
    propsOf(await readFeatures(loc, { path: join(dir, 'gbk-stream.shp') })),
    propsOf(await readFeatures(loc, { path: join(dir, 'gbk-normal.shp') })),
  );

  copyShp('gbk', 'gbk-add-normal');
  copyShp('gbk', 'gbk-add-stream');
  await normal(store, 'vector.addField', {
    target: 'dataset://gbk-add-normal.shp',
    name: 'TAG',
    expression: "CONCAT(名称, '-', '尾')",
  });
  const added = await streamAdd(store, 'gbk-add-stream.shp', 'TAG', "CONCAT(名称, '-', '尾')", null);
  assert.match(added.summary, /已加字段/);
  assert.deepEqual(
    propsOf(await readFeatures(loc, { path: join(dir, 'gbk-add-stream.shp') })),
    propsOf(await readFeatures(loc, { path: join(dir, 'gbk-add-normal.shp') })),
  );
});

/* ── 体积分支 ────────────────────────────────────────────────── */

test('超过 512 MB 的 Shapefile：预演走 DBF 流式，执行也能写', async () => {
  copyShp('base', 'big');
  const dbf = join(dir, 'big.dbf');
  const fd = openSync(dbf, 'r+');
  try {
    ftruncateSync(fd, 600 * 1024 * 1024);
  } finally {
    closeSync(fd);
  }
  const store = new LocalFolderStore(dir);

  for (const [op, params, pattern] of [
    ['feature.setAttributes', { target: 'dataset://big.shp', where: '编码 = 2', set: { 名称: '大文件' } }, /DBF 流式/],
    ['vector.addField', { target: 'dataset://big.shp', name: 'TAG', expression: '编码 + 1' }, /DBF 流式/],
    ['feature.delete', { target: 'dataset://big.shp', where: '编码 = 2' }, /删除标记/],
  ]) {
    const preview = await previewOp({ loc, store }, { op, params });
    assert.equal(preview.ok, true, preview.error ?? `${op} 预演应当成功`);
    assert.match(preview.value?.summary ?? '', pattern);
  }

  const exec = await executePlan(
    { loc, store },
    {
      op: 'feature.setAttributes',
      params: { target: 'dataset://big.shp', where: '编码 = 2', set: { 名称: '大文件' } },
    },
  );
  assert.equal(exec.ok, true, exec.results[0]?.error ?? '大文件执行应当成功');
  const read = await readFeatures(loc, { path: join(dir, 'big.shp') });
  assert.deepEqual(read.features.map((f) => f.properties['名称']), ['甲', '大文件', '大文件', '丁']);
});
