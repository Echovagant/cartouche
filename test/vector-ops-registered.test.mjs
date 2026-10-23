/**
 * 三个矢量 op 登记进执行器之后的接线验收。
 *
 * 这条文件盯的是**接线**，不是算法本身（算法在 expression / vector / spatial 各自的测试里）：
 *   1. 三个 op 进了已实现清单；
 *   2. 能被操作计划直接调用（executePlan），返回的是值结果；
 *   3. **预演不落盘** —— 确认卡上点一下就把文件改了，整个确认流程就废了；
 *   4. 真跑确实写回，且写完的数据还能打开。
 *
 * 数据用 fixtures 的副本：测试不许改仓库里的样本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { executePlan, previewOp, listImplementedOps } = await import(eng('ops/index.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { probeLayer } = await import(eng('vector/index.ts'));

const loc = resolveGdal();
if (!loc) throw new Error('本机没有 GDAL，这组用例跑不了');

const TMP_BASE = join(root, '.tmp-test');

/** 把样本图层复制一份到临时目录：测试要写回，不能动仓库里的样本 */
function workspaceWith(prefix, files) {
  rmSync(TMP_BASE, { recursive: true, force: true });
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TMP_BASE, prefix));
  for (const f of files) {
    cpSync(join(root, 'fixtures', f), join(dir, f));
  }
  return dir;
}

function cleanup() {
  rmSync(TMP_BASE, { recursive: true, force: true });
}
process.on('exit', cleanup);

/* ── 1. 进了清单 ─────────────────────────────────────────── */

test('接线：属性查询、计算字段、空间连接三个 op 进了已实现清单', () => {
  const ops = listImplementedOps();
  assert.ok(ops.includes('vector.query'), 'vector.query 应当已实现');
  assert.ok(ops.includes('vector.addField'), 'vector.addField 应当已实现');
  assert.ok(ops.includes('vector.spatialJoin'), 'vector.spatialJoin 应当已实现');
});

/* ── 2. 属性查询 ─────────────────────────────────────────── */

test('接线：vector.query 能被操作计划调用，返回值结果', async () => {
  const dir = workspaceWith('cartouche-vq-', ['sample.shp', 'sample.dbf', 'sample.shx', 'sample.prj', 'sample.cpg']);
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      { op: 'vector.query', params: { target: 'dataset://sample.shp' } },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');
    const rec = res.results[0];
    assert.equal(rec.op, 'vector.query');
    assert.ok(rec.value, '应当返回值结果');
    assert.equal(rec.value.kind, 'value');
    assert.ok(Number(rec.value.data.featureCount) >= 1, '样本图层至少有 1 条要素');
    assert.match(rec.value.summary, /查到/);
  } finally {
    cleanup();
  }
});

test('接线：vector.query 的条件是人话也能用', async () => {
  const dir = workspaceWith('cartouche-vq2-', ['sample.shp', 'sample.dbf', 'sample.shx', 'sample.prj', 'sample.cpg']);
  try {
    const store = new LocalFolderStore(dir);
    const info = await probeLayer(loc, join(dir, 'sample.shp'));
    const field = info.fields[0];
    assert.ok(field, '样本图层至少有一列');
    // 人话条件后面必须跟一个**字面量**：翻译器不猜「不等于」后面那个词
    // 是值还是列名 —— 猜错一次，用户就会拿着错的结果去改图。
    const numeric = /integer|real|float|double/i.test(field.type ?? '');
    const where = numeric
      ? `${field.name} 大于 -999999999`
      : `${field.name} 等于 '一个不存在的值'`;
    const res = await executePlan(
      { loc, store },
      { op: 'vector.query', params: { target: 'dataset://sample.shp', where } },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '人话条件应当能跑');
  } finally {
    cleanup();
  }
});

/* ── 3. 计算字段：预演不落盘 ─────────────────────────────── */

test('接线：vector.addField 的预演**不写盘**（确认卡点一下就改文件是不行的）', async () => {
  const dir = workspaceWith('cartouche-vaf-', ['sample.shp', 'sample.dbf', 'sample.shx', 'sample.prj', 'sample.cpg']);
  try {
    const store = new LocalFolderStore(dir);
    const info = await probeLayer(loc, join(dir, 'sample.shp'));
    const field = info.fields[0]?.name;
    assert.ok(field, '样本图层至少有一列');

    const before = statSync(join(dir, 'sample.dbf')).mtimeMs;
    const beforeSize = statSync(join(dir, 'sample.dbf')).size;

    // ⚠️ 预演走 previewOp：executePlan 是**真执行**，那是执行那条路。
    const res = await previewOp(
      { loc, store },
      { op: 'vector.addField', params: { target: 'dataset://sample.shp', name: 'PREVIEW_ONLY', expression: `${field}` } },
    );
    assert.equal(res.ok, true, res.error ?? '预演应当成功');
    assert.match(res.value.summary, /预演/);

    const after = statSync(join(dir, 'sample.dbf')).mtimeMs;
    const afterSize = statSync(join(dir, 'sample.dbf')).size;
    assert.equal(after, before, '预演不许改文件的修改时间');
    assert.equal(afterSize, beforeSize, '预演不许改文件的大小');
    // 也不能多出备份目录：预演一个字都不该落盘
    const leftovers = readdirSync(dir).filter((n) => n.includes('.bak.'));
    assert.deepEqual(leftovers, [], '预演不该留下备份');
  } finally {
    cleanup();
  }
});

/* ── 4. 计算字段：真跑写回 ───────────────────────────────── */

test('接线：vector.addField 真跑会把新列写回原文件，且写完还能打开', async () => {
  const dir = workspaceWith('cartouche-vaf2-', ['sample.shp', 'sample.dbf', 'sample.shx', 'sample.prj', 'sample.cpg']);
  try {
    const store = new LocalFolderStore(dir);
    const info = await probeLayer(loc, join(dir, 'sample.shp'));
    const field = info.fields[0]?.name;
    assert.ok(field, '样本图层至少有一列');

    const res = await executePlan(
      { loc, store },
      { op: 'vector.addField', params: { target: 'dataset://sample.shp', name: 'NEW_COL', expression: `${field}` } },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');

    const after = await probeLayer(loc, join(dir, 'sample.shp'));
    assert.ok(
      after.fields.some((f) => f.name.toLowerCase() === 'new_col'),
      `写回之后应当有 NEW_COL 这一列，实际有：${after.fields.map((f) => f.name).join('、')}`,
    );
    // 备份要留下（回滚靠它）
    assert.ok(
      readdirSync(dir).some((n) => n.includes('.bak.')),
      '写回应当留下备份',
    );
  } finally {
    cleanup();
  }
});

/* ── 5. 空间连接 ─────────────────────────────────────────── */

test('接线：vector.spatialJoin 能被操作计划调用并把汇总值写回目标图层', async () => {
  const dir = workspaceWith('cartouche-sj-', [
    'sample.shp', 'sample.dbf', 'sample.shx', 'sample.prj', 'sample.cpg',
    'gbk_sample.shp', 'gbk_sample.dbf', 'gbk_sample.shx', 'gbk_sample.prj', 'gbk_sample.cpg',
  ]);
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.spatialJoin',
        params: {
          target: 'dataset://sample.shp',
          source: 'dataset://gbk_sample.shp',
          relation: 'intersects',
          aggregate: 'count',
          fieldPrefix: 'sj_',
        },
      },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');
    const value = res.results[0].value;
    assert.ok(value, '应当返回值结果');
    assert.equal(value.kind, 'value');
    assert.ok('matched' in value.data, '结果里应当有 matched');
    assert.ok('unmatched' in value.data, '结果里应当有 unmatched');
    assert.match(value.summary, /连接/);

    // 汇总列确实写进了目标图层
    const after = await probeLayer(loc, join(dir, 'sample.shp'));
    assert.ok(
      after.fields.some((f) => f.name.toLowerCase().startsWith('sj_')),
      `目标图层应当多出汇总列，实际有：${after.fields.map((f) => f.name).join('、')}`,
    );
  } finally {
    cleanup();
  }
});

test('接线：空间连接的汇总列与目标已有列重名时明确报错，不静默覆盖', async () => {
  const dir = workspaceWith('cartouche-sj2-', [
    'sample.shp', 'sample.dbf', 'sample.shx', 'sample.prj', 'sample.cpg',
    'gbk_sample.shp', 'gbk_sample.dbf', 'gbk_sample.shx', 'gbk_sample.prj', 'gbk_sample.cpg',
  ]);
  try {
    const store = new LocalFolderStore(dir);
    const info = await probeLayer(loc, join(dir, 'sample.shp'));
    const existing = info.fields[0]?.name;
    assert.ok(existing, '样本图层至少有一列');

    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.spatialJoin',
        params: {
          target: 'dataset://sample.shp',
          source: 'dataset://gbk_sample.shp',
          relation: 'intersects',
          aggregate: 'first',
          fields: [existing],
        },
      },
    );
    assert.equal(res.ok, false, '重名时应当失败');
    assert.match(res.results[0].error ?? '', /重名/);
  } finally {
    cleanup();
  }
});
