/**
 * vector.recode 的验收。
 *
 * **这个 op 是编码转换（GBK ↔ UTF-8 ↔ LATIN1），不是"按对照表换值"。**
 *
 * 这组用例盯的是**转码最容易出的三类错**：
 *  1. **源编码猜错**（把 GBK 的文件当 UTF-8 读，转完中文变成另一批汉字）；
 *  2. **转完不回读核对**（DBF 的编码转换是最容易"看起来成功、其实全错"的操作）；
 *  3. **只改了 .cpg 标记、字节没换**（或者反过来）。
 *
 * 数据用 fixtures 的副本：测试要写回，不能动仓库里的样本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
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

const GBK_FILES = [
  'gbk_sample.shp', 'gbk_sample.dbf', 'gbk_sample.shx', 'gbk_sample.prj', 'gbk_sample.cpg',
];
const UTF8_FILES = ['sample.shp', 'sample.dbf', 'sample.shx', 'sample.prj', 'sample.cpg'];

function workspaceWith(prefix, files) {
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TMP_BASE, prefix));
  for (const f of files) cpSync(join(root, 'fixtures', f), join(dir, f));
  return dir;
}

/** .dbf 记录区的起始偏移（DBF 头第 8~9 字节是头长度，小端 uint16）。 */
function recordAreaOffset(dbfPath) {
  const buf = readFileSync(dbfPath);
  return buf.readUInt16LE(8);
}

/* ── 1. 登记 ─────────────────────────────────────────────────── */

test('vector.recode 进了已实现清单', () => {
  const ops = listImplementedOps();
  assert.ok(ops.includes('vector.recode'), 'vector.recode 应当已实现');
});

/* ── 2. GBK → UTF-8 ──────────────────────────────────────────── */

test('vector.recode：GBK 转成 UTF-8 之后中文正常', async () => {
  const dir = workspaceWith('cartouche-vrc-', GBK_FILES);
  try {
    const store = new LocalFolderStore(dir);
    // 转码前：按 UTF-8 读是乱码（.cpg 说的是 GBK）
    const before = await readFeatures(loc, { path: join(dir, 'gbk_sample.shp'), encoding: 'GBK' });
    assert.equal(before.features[0].properties['名称'], '测试图斑', '样本本身应当是「测试图斑」');

    const res = await executePlan(
      { loc, store },
      { op: 'vector.recode', params: { target: 'dataset://gbk_sample.shp', to: 'UTF-8' } },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');
    const value = res.results[0].value;
    assert.equal(value.data.from, 'GBK', '源编码应当是 GBK');
    assert.equal(value.data.to, 'UTF-8');

    // 回读：中文还是「测试图斑」，没有变成乱码
    const after = await readFeatures(loc, { path: join(dir, 'gbk_sample.shp'), encoding: 'UTF-8' });
    assert.equal(
      after.features[0].properties['名称'],
      '测试图斑',
      `转码后中文应当正常，实为 ${JSON.stringify(after.features[0].properties['名称'])}`,
    );
    assert.equal(after.features[0].properties['编码'], 1024, '数值列不该变');

    // 列名也该是正常的中文
    const info = await probeLayer(loc, join(dir, 'gbk_sample.shp'));
    assert.ok(
      info.fields.some((f) => f.name === '名称'),
      `列名应当是「名称」，实有：${info.fields.map((f) => f.name).join('、')}`,
    );

    // 编码标记应当跟着换
    const cpg = readFileSync(join(dir, 'gbk_sample.cpg'), 'utf8').trim().toUpperCase();
    assert.ok(
      cpg.includes('UTF-8') || cpg.includes('UTF8'),
      `.cpg 应当写成 UTF-8，实为 ${cpg}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.recode：UTF-8 转成 GBK 之后中文也正常', async () => {
  const dir = workspaceWith('cartouche-vrc2-', UTF8_FILES);
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      { op: 'vector.recode', params: { target: 'dataset://sample.shp', to: 'GBK' } },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');

    const after = await readFeatures(loc, { path: join(dir, 'sample.shp'), encoding: 'GBK' });
    assert.equal(
      after.features[0].properties['名称'],
      '测试图斑',
      `转成 GBK 之后按 GBK 读应当还是「测试图斑」，实为 ${JSON.stringify(after.features[0].properties['名称'])}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 3. 源编码探测 ──────────────────────────────────────────── */

test('vector.recode：没给 from 时能从 .cpg 标记探测出源编码', async () => {
  const dir = workspaceWith('cartouche-vrc3-', GBK_FILES);
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      { op: 'vector.recode', params: { target: 'dataset://gbk_sample.shp', to: 'UTF-8' } },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');
    assert.equal(res.results[0].value.data.from, 'GBK', '应当探测出 GBK');
    assert.match(res.results[0].value.summary, /cpg/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.recode：没有 .cpg 时按字节也能探测出源编码', async () => {
  const dir = workspaceWith('cartouche-vrc4-', GBK_FILES);
  try {
    const store = new LocalFolderStore(dir);
    rmSync(join(dir, 'gbk_sample.cpg'), { force: true });

    const res = await executePlan(
      { loc, store },
      { op: 'vector.recode', params: { target: 'dataset://gbk_sample.shp', to: 'UTF-8' } },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');
    assert.equal(res.results[0].value.data.from, 'GBK', '应当按字节探测出 GBK');

    const after = await readFeatures(loc, { path: join(dir, 'gbk_sample.shp'), encoding: 'UTF-8' });
    assert.equal(after.features[0].properties['名称'], '测试图斑', '转码后中文应当正常');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.recode：探测不出源编码时明确报错，不猜', async () => {
  const dir = workspaceWith('cartouche-vrc5-', GBK_FILES);
  try {
    const store = new LocalFolderStore(dir);
    // 去掉 .cpg，再把记录区里的一个字节改成非法值 —— 两种编码都解不开
    rmSync(join(dir, 'gbk_sample.cpg'), { force: true });
    const dbf = join(dir, 'gbk_sample.dbf');
    const bytes = readFileSync(dbf);
    const at = recordAreaOffset(dbf) + 5;
    bytes[at] = 0xff;
    writeFileSync(dbf, bytes);

    const res = await executePlan(
      { loc, store },
      { op: 'vector.recode', params: { target: 'dataset://gbk_sample.shp', to: 'UTF-8' } },
    );
    assert.equal(res.ok, false, '探测不出来时应当失败');
    assert.match(res.results[0].error ?? '', /探测|编码/);
    assert.match(res.results[0].error ?? '', /from/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.recode：.cpg 标记与实际字节对不上时明确报错', async () => {
  const dir = workspaceWith('cartouche-vrc6-', UTF8_FILES);
  try {
    const store = new LocalFolderStore(dir);
    // 文件其实是 UTF-8，却把标记写成 GBK —— 这是真实数据里常见的一类错
    writeFileSync(join(dir, 'sample.cpg'), 'GBK', 'utf8');

    const res = await executePlan(
      { loc, store },
      { op: 'vector.recode', params: { target: 'dataset://sample.shp', to: 'GBK' } },
    );
    assert.equal(res.ok, false, '标记与内容对不上时应当失败');
    assert.match(res.results[0].error ?? '', /对不上/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 4. 显式 from ────────────────────────────────────────────── */

test('vector.recode：显式给 from 时按用户指定的编码来', async () => {
  const dir = workspaceWith('cartouche-vrc7-', GBK_FILES);
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.recode',
        params: { target: 'dataset://gbk_sample.shp', from: 'GBK', to: 'UTF-8' },
      },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');
    assert.equal(res.results[0].value.data.from, 'GBK');
    const after = await readFeatures(loc, { path: join(dir, 'gbk_sample.shp'), encoding: 'UTF-8' });
    assert.equal(after.features[0].properties['名称'], '测试图斑');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.recode：from 写 auto 等同于不给 from', async () => {
  const dir = workspaceWith('cartouche-vrc8-', GBK_FILES);
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.recode',
        params: { target: 'dataset://gbk_sample.shp', from: 'auto', to: 'UTF-8' },
      },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');
    assert.equal(res.results[0].value.data.from, 'GBK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 5. 编码标记 ─────────────────────────────────────────────── */

test('vector.recode：writeEncodingMarker=false 时不留 .cpg，并说明后果', async () => {
  const dir = workspaceWith('cartouche-vrc9-', GBK_FILES);
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.recode',
        params: {
          target: 'dataset://gbk_sample.shp',
          to: 'UTF-8',
          writeEncodingMarker: false,
        },
      },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');
    assert.ok(
      !existsSync(join(dir, 'gbk_sample.cpg')),
      '按要求不该留下 .cpg 标记',
    );
    assert.match(res.results[0].value.summary, /标记/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 6. 不是 Shapefile / 不存在 / 越界 ───────────────────────── */

test('vector.recode：目标不是 Shapefile 时明确报错', async () => {
  const dir = workspaceWith('cartouche-vrc10-', [...UTF8_FILES, 'sample.geojson']);
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      { op: 'vector.recode', params: { target: 'dataset://sample.geojson', to: 'GBK' } },
    );
    assert.equal(res.ok, false, 'GeoJSON 没有编码可转');
    assert.match(res.results[0].error ?? '', /Shapefile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.recode：目标不存在时明确报错', async () => {
  const dir = workspaceWith('cartouche-vrc11-', GBK_FILES);
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      { op: 'vector.recode', params: { target: 'dataset://nope.shp', to: 'UTF-8' } },
    );
    assert.equal(res.ok, false, '目标不存在时应当失败');
    assert.match(res.results[0].error ?? '', /不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.recode：越界的路径被路径闸门挡下', async () => {
  const dir = workspaceWith('cartouche-vrc12-', GBK_FILES);
  try {
    const store = new LocalFolderStore(dir);
    for (const bad of ['C:/Windows/System32/drivers/etc/hosts', '../outside.shp']) {
      const res = await executePlan(
        { loc, store },
        { op: 'vector.recode', params: { target: bad, to: 'UTF-8' } },
      );
      assert.equal(res.ok, false, `越界路径 ${bad} 应当被挡下`);
      assert.match(res.results[0].error ?? '', /相对路径|\.\./);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 7. 预演不落盘 ───────────────────────────────────────────── */

test('vector.recode：预演不落盘', async () => {
  const dir = workspaceWith('cartouche-vrc13-', GBK_FILES);
  try {
    const store = new LocalFolderStore(dir);
    const before = statSync(join(dir, 'gbk_sample.dbf'));
    const beforeCpg = readFileSync(join(dir, 'gbk_sample.cpg'), 'utf8');

    const res = await previewOp(
      { loc, store },
      { op: 'vector.recode', params: { target: 'dataset://gbk_sample.shp', to: 'UTF-8' } },
    );
    assert.equal(res.ok, true, res.error ?? '预演应当成功');
    assert.match(res.value.summary, /预演/);

    const after = statSync(join(dir, 'gbk_sample.dbf'));
    assert.equal(after.mtimeMs, before.mtimeMs, '预演不许改文件');
    assert.equal(
      readFileSync(join(dir, 'gbk_sample.cpg'), 'utf8'),
      beforeCpg,
      '预演不许改编码标记',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
