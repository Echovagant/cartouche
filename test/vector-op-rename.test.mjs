/**
 * vector.renameFields 的验收。
 *
 * 这组用例盯的是**改名最容易出的三类错**：
 *  1. **Shapefile 的列名超 10 字节会被截断**（"更新编号" 变成 "更新编?"），
 *     而 GDAL 只留一条 stderr 的 Warning、退出码还是 0 ——
 *     所以引擎必须报**文件里实际存在的列名**，不能让用户以为改成了想要的名字；
 *  2. **与已有列重名会被静默覆盖**（用户的数据被顶掉）；
 *  3. **改名时把值改动了**（改名不该碰值）。
 *
 * 数据用 fixtures 的副本：测试要写回，不能动仓库里的样本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { executePlan, previewOp, listImplementedOps } = await import(eng('ops/index.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { probeLayer, readFeatures } = await import(eng('vector/index.ts'));

const loc = resolveGdal();
if (!loc) throw new Error('本机没有 GDAL，这组用例跑不了');

/** 临时目录：默认落在仓库里的 .tmp-test（D 盘、且已 gitignore）。 */
const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || join(root, '.tmp-test');

const SAMPLE_FILES = ['sample.shp', 'sample.dbf', 'sample.shx', 'sample.prj', 'sample.cpg'];

function workspaceWith(prefix, files = SAMPLE_FILES) {
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TMP_BASE, prefix));
  for (const f of files) cpSync(join(root, 'fixtures', f), join(dir, f));
  return dir;
}

/* ── 1. 登记 ─────────────────────────────────────────────────── */

test('vector.renameFields 进了已实现清单', () => {
  const ops = listImplementedOps();
  assert.ok(ops.includes('vector.renameFields'), 'vector.renameFields 应当已实现');
});

/* ── 2. 改名 + 值不动 ────────────────────────────────────────── */

test('vector.renameFields：列名真改了，值一个都没动', async () => {
  const dir = workspaceWith('cartouche-vrn-');
  try {
    const store = new LocalFolderStore(dir);
    const before = await readFeatures(loc, { path: join(dir, 'sample.shp') });
    const beforeProps = before.features[0].properties;

    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.renameFields',
        params: { target: 'dataset://sample.shp', mapping: { 名称: 'NAME', 编码: 'CODE' } },
      },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');

    const info = await probeLayer(loc, join(dir, 'sample.shp'));
    const names = info.fields.map((f) => f.name);
    assert.ok(names.includes('NAME'), `应当有 NAME 这一列，实有：${names.join('、')}`);
    assert.ok(names.includes('CODE'), `应当有 CODE 这一列，实有：${names.join('、')}`);
    assert.ok(!names.includes('名称'), '旧列名不该还在');

    // 值必须原样
    const after = await readFeatures(loc, { path: join(dir, 'sample.shp') });
    assert.deepEqual(
      after.features[0].properties,
      { NAME: beforeProps['名称'], CODE: beforeProps['编码'] },
      '改名不该动值',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 3. 截断如实报 ───────────────────────────────────────────── */

test('vector.renameFields：列名超 10 字节被截断时，报的是文件里实际存在的名字', async () => {
  const dir = workspaceWith('cartouche-vrn2-');
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.renameFields',
        params: { target: 'dataset://sample.shp', mapping: { 名称: '更新编号' } },
      },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');
    const value = res.results[0].value;
    assert.ok(value, '应当返回值结果');

    const renamed = value.data.renamed[0];
    assert.equal(renamed.from, '名称');
    assert.equal(renamed.requestedTo, '更新编号');
    // ⚠️ 报出来的必须是**实际**的列名，不能是用户要求的名字
    assert.notEqual(
      renamed.to,
      '更新编号',
      'Shapefile 的列名超 10 字节会被截断，报出来的必须是截断后的名字',
    );
    assert.equal(renamed.truncated, true);

    // 文件里真的有这一列，而且名字与报出来的一致
    const info = await probeLayer(loc, join(dir, 'sample.shp'));
    // ⚠️ 列名被按字节截断时，最后半个字解出来是替换字符（U+FFFD）；
    //    引擎按 GDAL 自己的写法把它显示成 '?'，这里同样归一后再比。
    const names = info.fields.map((f) => f.name.replace(/\uFFFD/g, '?'));
    assert.ok(
      names.includes(renamed.to),
      `文件里应当有「${renamed.to}」这一列，实有：${names.join('、')}`,
    );
    assert.match(value.summary, /截断|实际/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 4. 重名报错 ─────────────────────────────────────────────── */

test('vector.renameFields：与已有列重名时明确报错，不静默覆盖', async () => {
  const dir = workspaceWith('cartouche-vrn3-');
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.renameFields',
        params: { target: 'dataset://sample.shp', mapping: { 名称: '编码' } },
      },
    );
    assert.equal(res.ok, false, '重名时应当失败');
    assert.match(res.results[0].error ?? '', /同名/);

    // 原数据没被动
    const info = await probeLayer(loc, join(dir, 'sample.shp'));
    const names = info.fields.map((f) => f.name);
    assert.ok(names.includes('名称'), `原列名应当还在，实有：${names.join('、')}`);
    assert.ok(names.includes('编码'), `原列名应当还在，实有：${names.join('、')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.renameFields：两个字段改成同一个名字时报错', async () => {
  const dir = workspaceWith('cartouche-vrn4-');
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.renameFields',
        params: { target: 'dataset://sample.shp', mapping: { 名称: 'X', 编码: 'X' } },
      },
    );
    assert.equal(res.ok, false, '改成同一个名字时应当失败');
    assert.match(res.results[0].error ?? '', /同名/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 5. 非法列名被挡 ─────────────────────────────────────────── */

test('vector.renameFields：非法的列名（空串 / 路径分隔符 / 换行）被挡下', async () => {
  const dir = workspaceWith('cartouche-vrn5-');
  try {
    const store = new LocalFolderStore(dir);
    for (const bad of ['   ', 'a/b', 'a\\b', 'a\nb']) {
      const res = await executePlan(
        { loc, store },
        {
          op: 'vector.renameFields',
          params: { target: 'dataset://sample.shp', mapping: { 名称: bad } },
        },
      );
      assert.equal(res.ok, false, `非法列名 ${JSON.stringify(bad)} 应当被挡下`);
      assert.match(res.results[0].error ?? '', /列名/);
    }
    // 原数据没被动
    const info = await probeLayer(loc, join(dir, 'sample.shp'));
    assert.ok(info.fields.some((f) => f.name === '名称'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 6. 旧列不存在 ───────────────────────────────────────────── */

test('vector.renameFields：旧列名不存在时明确报错，并列出实际的列', async () => {
  const dir = workspaceWith('cartouche-vrn6-');
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.renameFields',
        params: { target: 'dataset://sample.shp', mapping: { 没有这一列: 'X' } },
      },
    );
    assert.equal(res.ok, false, '旧列不存在时应当失败');
    assert.match(res.results[0].error ?? '', /没有/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 7. 对照表的两种写法 ─────────────────────────────────────── */

test('vector.renameFields：mapping 与 renames 只能给一个，两个都给要报错', async () => {
  const dir = workspaceWith('cartouche-vrn7-');
  try {
    const store = new LocalFolderStore(dir);
    const both = await executePlan(
      { loc, store },
      {
        op: 'vector.renameFields',
        params: {
          target: 'dataset://sample.shp',
          mapping: { 名称: 'A' },
          renames: { 编码: 'B' },
        },
      },
    );
    assert.equal(both.ok, false, '两个都给时应当报错');
    assert.match(both.results[0].error ?? '', /只能给一个/);

    // 只给一个（另一个写法）也认
    const one = await executePlan(
      { loc, store },
      {
        op: 'vector.renameFields',
        params: { target: 'dataset://sample.shp', renames: { 名称: 'A' } },
      },
    );
    assert.equal(one.ok, true, one.results[0]?.error ?? '只给一个应当能跑');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 8. 预演 / 不存在 / 越界 ─────────────────────────────────── */

test('vector.renameFields：预演不落盘', async () => {
  const dir = workspaceWith('cartouche-vrn8-');
  try {
    const store = new LocalFolderStore(dir);
    const before = statSync(join(dir, 'sample.dbf'));
    const res = await previewOp(
      { loc, store },
      {
        op: 'vector.renameFields',
        params: { target: 'dataset://sample.shp', mapping: { 名称: 'NAME' } },
      },
    );
    assert.equal(res.ok, true, res.error ?? '预演应当成功');
    assert.match(res.value.summary, /预演/);

    const after = statSync(join(dir, 'sample.dbf'));
    assert.equal(after.mtimeMs, before.mtimeMs, '预演不许改文件');
    assert.ok(!readdirSync(dir).some((n) => n.includes('.bak.')), '预演不该留下备份');
    const info = await probeLayer(loc, join(dir, 'sample.shp'));
    assert.ok(info.fields.some((f) => f.name === '名称'), '预演不该改列名');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.renameFields：目标不存在时明确报错', async () => {
  const dir = workspaceWith('cartouche-vrn9-');
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.renameFields',
        params: { target: 'dataset://nope.shp', mapping: { 名称: 'NAME' } },
      },
    );
    assert.equal(res.ok, false, '目标不存在时应当失败');
    assert.match(res.results[0].error ?? '', /不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.renameFields：越界的路径被路径闸门挡下', async () => {
  const dir = workspaceWith('cartouche-vrn10-');
  try {
    const store = new LocalFolderStore(dir);
    for (const bad of ['C:/Windows/System32/drivers/etc/hosts', '../outside.shp']) {
      const res = await executePlan(
        { loc, store },
        {
          op: 'vector.renameFields',
          params: { target: bad, mapping: { 名称: 'NAME' } },
        },
      );
      assert.equal(res.ok, false, `越界路径 ${bad} 应当被挡下`);
      assert.match(res.results[0].error ?? '', /相对路径|\.\./);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
