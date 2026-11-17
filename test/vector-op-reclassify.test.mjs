/**
 * vector.reclassify 的验收。
 *
 * 盯的是「按对照表换值」最容易出的四类错：
 *  1. **类型混淆**：数字 1 与文字 "1" 被当成同一个值；
 *  2. **就地改类型**：A/B/C → 1/2/3 时偷偷把文字列变成数字列；
 *  3. **未匹配策略不清**：保留 / 置空 / 拒绝必须说到做到；
 *  4. **写坏别的列**：只有目标列能变，其余列一个都不许动。
 *
 * 数据是测试里现造的 GeoJSON，不依赖仓库里的二进制样本。
 * 预演必须零写盘（内容与 mtime 都不许变）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { executePlan, previewOp, listImplementedOps } = await import(eng('ops/index.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { readFeatures } = await import(eng('vector/index.ts'));

const loc = resolveGdal();
if (!loc) throw new Error('本机没有 GDAL，这组用例跑不了');

const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || join(root, '.tmp-test');

function feature(code, n, x) {
  return {
    type: 'Feature',
    properties: { code, n },
    geometry: { type: 'Point', coordinates: [x, x] },
  };
}

/** 造一份带 A/B/C/A 四行、两个字段（code 文字、n 数字）的 GeoJSON。 */
function workspace() {
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TMP_BASE, 'cartouche-vrcf-'));
  const fc = {
    type: 'FeatureCollection',
    features: [feature('A', 1, 0), feature('B', 2, 1), feature('C', 3, 2), feature('A', 4, 3)],
  };
  writeFileSync(join(dir, 'codes.geojson'), JSON.stringify(fc), 'utf8');
  return dir;
}

async function readCodes(dir) {
  const read = await readFeatures(loc, { path: join(dir, 'codes.geojson') });
  return read.features.map((f) => ({ ...f.properties }));
}

/* ── 1. 登记 ─────────────────────────────────────────────────── */

test('vector.reclassify 进了已实现清单', () => {
  assert.ok(listImplementedOps().includes('vector.reclassify'));
});

/* ── 2. 新列：A/B/C → 1/2/3 ─────────────────────────────────── */

test('vector.reclassify：A/B/C 写进新数字列，别的列不动', async () => {
  const dir = workspace();
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.reclassify',
        params: {
          target: 'dataset://codes.geojson',
          field: 'code',
          mapping: [
            { from: 'A', to: 1 },
            { from: 'B', to: 2 },
            { from: 'C', to: 3 },
          ],
          outputField: 'code_num',
        },
      },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');
    const value = res.results[0].value;
    assert.equal(value.data.outputType, 'number', 'auto 应当推断成数字列');
    assert.equal(value.data.matched, 4);

    const after = await readCodes(dir);
    assert.deepEqual(
      after.map((p) => p['code_num']),
      [1, 2, 3, 1],
      '新列应当按对照表写成 1/2/3/1',
    );
    assert.deepEqual(
      after.map((p) => p['code']),
      ['A', 'B', 'C', 'A'],
      '原来的 code 列不该被改',
    );
    assert.deepEqual(after.map((p) => p['n']), [1, 2, 3, 4], '无关列 n 不该变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 3. 就地改：文字列里换值 ─────────────────────────────────── */

test('vector.reclassify：就地改文字列，未匹配的按 keep 保留', async () => {
  const dir = workspace();
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.reclassify',
        params: {
          target: 'dataset://codes.geojson',
          field: 'code',
          mapping: [
            { from: 'A', to: '甲' },
            { from: 'B', to: '乙' },
          ],
        },
      },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');
    assert.equal(res.results[0].value.data.unmatchedCount, 1, 'C 应当算未匹配');

    const after = await readCodes(dir);
    assert.deepEqual(after.map((p) => p['code']), ['甲', '乙', 'C', '甲']);
    assert.deepEqual(after.map((p) => p['n']), [1, 2, 3, 4]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 4. 类型严格：数字 1 与文字 "1" 不是一回事 ───────────────── */

test('vector.reclassify：数字原值不会命中文字键', async () => {
  const dir = workspace();
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.reclassify',
        params: {
          target: 'dataset://codes.geojson',
          field: 'n',
          mapping: [{ from: '1', to: 99 }],
        },
      },
    );
    assert.equal(res.ok, false, '字段 n 是数字列，文字 "1" 不该命中');
    assert.match(res.results[0].error ?? '', /一条都没命中/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 5. 就地改类型不匹配：明确拒绝，建议开新列 ───────────────── */

test('vector.reclassify：数字列就地写文字时拒绝，并提示 outputField', async () => {
  const dir = workspace();
  const before = readFileSync(join(dir, 'codes.geojson'), 'utf8');
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.reclassify',
        params: {
          target: 'dataset://codes.geojson',
          field: 'n',
          mapping: [{ from: 1, to: 'one' }],
        },
      },
    );
    assert.equal(res.ok, false, '数字列不该收文字');
    assert.match(res.results[0].error ?? '', /数字列|outputField/);
    assert.equal(readFileSync(join(dir, 'codes.geojson'), 'utf8'), before, '失败时文件不许变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 6. 未匹配策略 ───────────────────────────────────────────── */

test('vector.reclassify：unmatched=error 整单拒绝且文件不变', async () => {
  const dir = workspace();
  const before = readFileSync(join(dir, 'codes.geojson'), 'utf8');
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.reclassify',
        params: {
          target: 'dataset://codes.geojson',
          field: 'code',
          mapping: [{ from: 'A', to: '甲' }],
          unmatched: 'error',
        },
      },
    );
    assert.equal(res.ok, false);
    assert.match(res.results[0].error ?? '', /不在对照表里/);
    assert.match(res.results[0].error ?? '', /文字「B」|文字「C」/);
    assert.equal(readFileSync(join(dir, 'codes.geojson'), 'utf8'), before, '整单拒绝时不许写盘');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.reclassify：unmatched=null 把未匹配的值置空', async () => {
  const dir = workspace();
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.reclassify',
        params: {
          target: 'dataset://codes.geojson',
          field: 'code',
          mapping: [{ from: 'A', to: '甲' }],
          unmatched: 'null',
        },
      },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');
    const after = await readCodes(dir);
    assert.deepEqual(
      after.map((p) => p['code']),
      ['甲', null, null, '甲'],
      'B/C 应当被置空',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 7. 对照表本身的问题 ─────────────────────────────────────── */

test('vector.reclassify：对照表原值重复时明确拒绝', async () => {
  const dir = workspace();
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.reclassify',
        params: {
          target: 'dataset://codes.geojson',
          field: 'code',
          mapping: [
            { from: 'A', to: '甲' },
            { from: 'A', to: '乙' },
          ],
        },
      },
    );
    assert.equal(res.ok, false);
    assert.match(res.results[0].error ?? '', /出现了两次/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 8. 预演不落盘 ───────────────────────────────────────────── */

test('vector.reclassify：预演零写盘（内容与 mtime 都不变）', async () => {
  const dir = workspace();
  try {
    const store = new LocalFolderStore(dir);
    const target = join(dir, 'codes.geojson');
    const before = readFileSync(target, 'utf8');
    const beforeMtime = statSync(target).mtimeMs;

    const res = await previewOp(
      { loc, store },
      {
        op: 'vector.reclassify',
        params: {
          target: 'dataset://codes.geojson',
          field: 'code',
          mapping: [
            { from: 'A', to: 1 },
            { from: 'B', to: 2 },
            { from: 'C', to: 3 },
          ],
          outputField: 'code_num',
        },
      },
    );
    assert.equal(res.ok, true, res.error ?? '预演应当成功');
    assert.match(res.value.summary, /预演/);
    assert.equal(readFileSync(target, 'utf8'), before, '预演不许改文件内容');
    assert.equal(statSync(target).mtimeMs, beforeMtime, '预演不许动文件 mtime');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
