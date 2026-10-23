/**
 * vector.reproject 的验收。
 *
 * 这组用例盯的是**重投影最容易出的三类错**：
 *  1. **只贴了坐标系标签，坐标没换**（`-a_srs` 而不是 `-t_srs`）——
 *     所以断言直接比坐标值，不看 CRS 标签；
 *  2. **转换失败却报成功**（ogr2ogr 出错也可能返回退出码 0）——
 *     所以要素数、写完能不能打开都要核对；
 *  3. **本机 PROJ 解析不了的坐标系被静默当成默认 CRS**——
 *     所以填了认不出的 CRS 必须明确报错。
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
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { executePlan, previewOp, listImplementedOps } = await import(eng('ops/index.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { probeLayer, readFeatures } = await import(eng('vector/index.ts'));

const loc = resolveGdal();
if (!loc) throw new Error('本机没有 GDAL，这组用例跑不了');
const gdal = tools(loc);

/** 临时目录：默认落在仓库里的 .tmp-test（D 盘、且已 gitignore）。 */
const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || join(root, '.tmp-test');

const SAMPLE_FILES = ['sample.shp', 'sample.dbf', 'sample.shx', 'sample.prj', 'sample.cpg'];

/** 复制一份样本到临时工作区。 */
function workspaceWith(prefix, files = SAMPLE_FILES) {
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TMP_BASE, prefix));
  for (const f of files) cpSync(join(root, 'fixtures', f), join(dir, f));
  return dir;
}

/** 第一个要素的第一个顶点。 */
function firstVertex(features) {
  const walk = (node) => {
    if (!Array.isArray(node) || node.length === 0) return null;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') return [node[0], node[1]];
    for (const child of node) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  for (const f of features) {
    const hit = walk(f.geometry?.coordinates);
    if (hit) return hit;
  }
  return null;
}

/**
 * 造一张 EPSG:3857 的栅格（当作"要对齐的那张图"）。
 *
 * 像元大小 250m × 333m：残差是以像元为单位的，
 * 像元越小同样的坐标偏差折算出来的像元数越大。
 */
async function makeGridRaster(dir, name) {
  const w = 16;
  const h = 12;
  const bands = 3;
  const raw = new Uint8Array(w * h * bands);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 7) % 200;
  const bin = join(dir, `${name}.bin`);
  const hdr = join(dir, `${name}.hdr`);
  writeFileSync(bin, raw);
  writeFileSync(
    hdr,
    [
      'ENVI',
      `samples = ${w}`,
      `lines   = ${h}`,
      `bands   = ${bands}`,
      'header offset = 0',
      'file type = ENVI Standard',
      'data type = 1',
      'interleave = bip',
      'byte order = 0',
      '',
    ].join('\n'),
    'utf8',
  );
  const tif = join(dir, `${name}.tif`);
  await gdal.translate([
    '-of', 'GTiff',
    '-a_srs', 'EPSG:3857',
    '-a_ullr', '13391000', '3570000', '13395000', '3574000',
    bin,
    tif,
  ]);
  return tif;
}

/* ── 1. 登记 ─────────────────────────────────────────────────── */

test('vector.reproject 进了已实现清单', () => {
  const ops = listImplementedOps();
  assert.ok(ops.includes('vector.reproject'), 'vector.reproject 应当已实现');
});

/* ── 2. 坐标真的换了 ─────────────────────────────────────────── */

test('vector.reproject：坐标真的换了（不是只贴了坐标系标签）', async () => {
  const dir = workspaceWith('cartouche-vrp-');
  try {
    const store = new LocalFolderStore(dir);
    const before = await readFeatures(loc, { path: join(dir, 'sample.shp') });
    const beforeVertex = firstVertex(before.features);
    assert.ok(beforeVertex, '样本图层至少有一个顶点');
    assert.ok(Math.abs(beforeVertex[0]) < 180, '样本原本是经纬度（度）');

    const res = await executePlan(
      { loc, store },
      { op: 'vector.reproject', params: { target: 'dataset://sample.shp', to: 'EPSG:3857' } },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');

    const after = await readFeatures(loc, { path: join(dir, 'sample.shp') });
    const afterVertex = firstVertex(after.features);
    assert.ok(afterVertex, '写回之后还能读出顶点');

    // ⚠️ 核心断言：坐标值本身变了，而且变成了目标坐标系的量级
    assert.notDeepEqual(
      afterVertex,
      beforeVertex,
      '坐标值必须变 —— 只换标签的话，这里会是原样的经纬度',
    );
    assert.ok(
      Math.abs(afterVertex[0]) > 1e6,
      `x 应当是米级（3857），实为 ${afterVertex[0]}（还是经纬度的样子）`,
    );
    assert.ok(
      Math.abs(afterVertex[0] - beforeVertex[0]) > 1,
      'x 与原值差得足够远，不是浮点噪声',
    );

    // 坐标系标签也跟着换了
    const info = await probeLayer(loc, join(dir, 'sample.shp'));
    assert.equal(info.epsg, 3857, `坐标系应当是 EPSG:3857，实为 ${info.epsg}`);
    // 要素数不变
    assert.equal(info.featureCount, before.features.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.reproject：写回之后文件能打开、要素数不变、并且留了备份', async () => {
  const dir = workspaceWith('cartouche-vrp2-');
  try {
    const store = new LocalFolderStore(dir);
    const before = await probeLayer(loc, join(dir, 'sample.shp'));
    const res = await executePlan(
      { loc, store },
      { op: 'vector.reproject', params: { target: 'dataset://sample.shp', to: 'EPSG:3857' } },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');

    const after = await probeLayer(loc, join(dir, 'sample.shp'));
    assert.equal(after.featureCount, before.featureCount, '要素数不能变');
    assert.ok(after.srsWkt, '写回之后必须还认得出坐标系');
    assert.ok(
      readdirSync(dir).some((n) => n.includes('.bak.')),
      '写回应当留下备份（回滚靠它）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 3. auto + alignTo ───────────────────────────────────────── */

test('vector.reproject：to 写 auto 时由 alignTo 推导目标坐标系', async () => {
  const dir = workspaceWith('cartouche-vrp3-');
  try {
    const store = new LocalFolderStore(dir);
    await makeGridRaster(dir, 'grid');

    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.reproject',
        params: { target: 'dataset://sample.shp', to: 'auto', alignTo: 'dataset://grid.tif' },
      },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');

    const info = await probeLayer(loc, join(dir, 'sample.shp'));
    assert.equal(info.epsg, 3857, `应当被推成对齐图层的坐标系，实为 ${info.epsg}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.reproject：to 写 auto 却没有 alignTo 时明确报错', async () => {
  const dir = workspaceWith('cartouche-vrp4-');
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      { op: 'vector.reproject', params: { target: 'dataset://sample.shp', to: 'auto' } },
    );
    assert.equal(res.ok, false, '没有 alignTo 时应当失败');
    assert.match(res.results[0].error ?? '', /alignTo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 4. 残差上限 ─────────────────────────────────────────────── */

test('vector.reproject：转换残差超过 maxResidualPx 时中止，且不动原文件', async () => {
  const dir = workspaceWith('cartouche-vrp5-');
  try {
    const store = new LocalFolderStore(dir);
    await makeGridRaster(dir, 'grid');

    const before = await readFeatures(loc, { path: join(dir, 'sample.shp') });
    const beforeVertex = firstVertex(before.features);
    const beforeStat = statSync(join(dir, 'sample.dbf'));

    // 残差是拿"另一条独立算出来的变换结果"比出来的，量级在 1e-8 米上下。
    // 允许 0 像元 = 要求完全精确，所以一定会超限。
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.reproject',
        params: {
          target: 'dataset://sample.shp',
          to: 'EPSG:3857',
          alignTo: 'dataset://grid.tif',
          maxResidualPx: 0,
        },
      },
    );
    assert.equal(res.ok, false, '残差超限时应当中止');
    assert.match(res.results[0].error ?? '', /残差/);

    // 中止 = 原数据一个字节都没动
    const afterStat = statSync(join(dir, 'sample.dbf'));
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, '中止时不该改过文件');
    const after = await readFeatures(loc, { path: join(dir, 'sample.shp') });
    assert.deepEqual(firstVertex(after.features), beforeVertex, '中止时坐标不该变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.reproject：残差在允许范围内时正常完成，并报出残差数值', async () => {
  const dir = workspaceWith('cartouche-vrp6-');
  try {
    const store = new LocalFolderStore(dir);
    await makeGridRaster(dir, 'grid');
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.reproject',
        params: {
          target: 'dataset://sample.shp',
          to: 'EPSG:3857',
          alignTo: 'dataset://grid.tif',
          maxResidualPx: 10,
        },
      },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');
    const value = res.results[0].value;
    assert.ok(value, '应当返回值结果');
    assert.ok(
      typeof value.data.residualPx === 'number' && value.data.residualPx >= 0,
      `应当报出残差像元数，实为 ${JSON.stringify(value.data.residualPx)}`,
    );
    assert.ok(value.data.residualPx <= 10, '残差应当落在允许范围内');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.reproject：给了 maxResidualPx 却没有栅格网格可定像元大小时明确报错', async () => {
  const dir = workspaceWith('cartouche-vrp7-');
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.reproject',
        params: { target: 'dataset://sample.shp', to: 'EPSG:3857', maxResidualPx: 1 },
      },
    );
    assert.equal(res.ok, false, '没有像元网格时应当报错而不是跳过核对');
    assert.match(res.results[0].error ?? '', /像元/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 5. 解析不了的坐标系 ─────────────────────────────────────── */

test('vector.reproject：本机 PROJ 解析不了的坐标系必须明确报错', async () => {
  const dir = workspaceWith('cartouche-vrp8-');
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.reproject',
        params: { target: 'dataset://sample.shp', to: 'EPSG:CGCS2000_3_Degree' },
      },
    );
    assert.equal(res.ok, false, '认不出的坐标系应当失败');
    assert.match(res.results[0].error ?? '', /解析不了|找不到/);
    // 而且不能留下半个产物
    assert.ok(
      !readdirSync(dir).some((n) => n.includes('.bak.')),
      '失败时不该留下备份（说明没写过）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 6. 另存 ─────────────────────────────────────────────────── */

test('vector.reproject：给了 output 时写到新路径，原文件不动', async () => {
  const dir = workspaceWith('cartouche-vrp9-');
  try {
    const store = new LocalFolderStore(dir);
    const before = await readFeatures(loc, { path: join(dir, 'sample.shp') });
    const beforeVertex = firstVertex(before.features);

    const res = await executePlan(
      { loc, store },
      {
        op: 'vector.reproject',
        params: { target: 'dataset://sample.shp', to: 'EPSG:3857', output: 'dataset://out3857.shp' },
      },
    );
    assert.equal(res.ok, true, res.results[0]?.error ?? '应当成功');
    assert.ok(existsSync(join(dir, 'out3857.shp')), '应当产出新文件');

    const out = await readFeatures(loc, { path: join(dir, 'out3857.shp') });
    const outVertex = firstVertex(out.features);
    assert.ok(Math.abs(outVertex[0]) > 1e6, '新文件里的坐标应当已经转换');

    const original = await readFeatures(loc, { path: join(dir, 'sample.shp') });
    assert.deepEqual(
      firstVertex(original.features),
      beforeVertex,
      '给了 output 就不该动原文件',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 7. 预演 / 不存在 / 越界 ─────────────────────────────────── */

test('vector.reproject：预演不落盘', async () => {
  const dir = workspaceWith('cartouche-vrp10-');
  try {
    const store = new LocalFolderStore(dir);
    const before = await readFeatures(loc, { path: join(dir, 'sample.shp') });
    const beforeVertex = firstVertex(before.features);
    const beforeStat = statSync(join(dir, 'sample.dbf'));

    const res = await previewOp(
      { loc, store },
      { op: 'vector.reproject', params: { target: 'dataset://sample.shp', to: 'EPSG:3857' } },
    );
    assert.equal(res.ok, true, res.error ?? '预演应当成功');
    assert.match(res.value.summary, /预演/);

    const afterStat = statSync(join(dir, 'sample.dbf'));
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, '预演不许改文件');
    const after = await readFeatures(loc, { path: join(dir, 'sample.shp') });
    assert.deepEqual(firstVertex(after.features), beforeVertex, '预演不许改坐标');
    assert.ok(
      !readdirSync(dir).some((n) => n.includes('.bak.')),
      '预演不该留下备份',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.reproject：目标不存在时明确报错', async () => {
  const dir = workspaceWith('cartouche-vrp11-');
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      { op: 'vector.reproject', params: { target: 'dataset://nope.shp', to: 'EPSG:3857' } },
    );
    assert.equal(res.ok, false, '目标不存在时应当失败');
    assert.match(res.results[0].error ?? '', /不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vector.reproject：越界的路径被路径闸门挡下', async () => {
  const dir = workspaceWith('cartouche-vrp12-');
  try {
    const store = new LocalFolderStore(dir);
    for (const bad of ['C:/Windows/System32/drivers/etc/hosts', '../outside.shp']) {
      const res = await executePlan(
        { loc, store },
        { op: 'vector.reproject', params: { target: bad, to: 'EPSG:3857' } },
      );
      assert.equal(res.ok, false, `越界路径 ${bad} 应当被挡下`);
      assert.match(res.results[0].error ?? '', /相对路径|\.\./);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
