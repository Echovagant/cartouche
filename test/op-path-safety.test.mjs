/**
 * 路径安全：拼接（raster.mosaic）的输入输出不能逃出工作区。
 *
 * 2026-10-23 实测的洞：
 *   - 八个已实现的 op 里，target / source / clip 走的是 `toRelPathChecked`
 *     （拒绝对路径与 `..`），**只有 mosaic 走的是 `toRelPath`**；
 *   - `LocalFolderStore.resolve()` 里 `if (isAbsolute(path)) return normalize(path)`
 *     —— 绝对路径直接放行，不查根。
 * 结果：`"C:/Windows/System32/drivers/etc/hosts"` 能被拼接当输入读走。
 *
 * 本文件不构造任何栅格，也不碰真实数据：只造临时目录与路径字符串。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { PathEscapeError } = await import(eng('workspace/errors.ts'));
const { executePlan } = await import(eng('ops/index.ts'));

const loc = resolveGdal();

/**
 * 越界的绝对路径。
 *
 * 必须**按平台取**：POSIX 的 `path.isAbsolute('C:/Windows/...')` 是 false，
 * 在 ubuntu 上它会被当成一个普通相对文件名拼到根下面，闸门根本不触发，
 * 断言必然落空（2026-10-23 CI 实测：Windows 上过，ubuntu 上挂）。
 * 两边各取一个真实存在、且必定落在临时根之外的系统文件。
 */
const HOSTS =
  process.platform === 'win32' ? 'C:/Windows/System32/drivers/etc/hosts' : '/etc/hosts';

/* ── 1. 工作区适配器：绝对路径也要判根 ──────────────────── */

test('工作区：绝对路径逃出根 → 拒绝，并说清「不在已登记的工作区根之下」', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-abs-escape-'));
  try {
    const store = new LocalFolderStore(dir);
    assert.throws(
      () => store.resolve(HOSTS),
      (err) => {
        assert.ok(err instanceof PathEscapeError, '必须是 PathEscapeError');
        assert.match(err.message, /不在已登记的工作区根之下/, '报错要说清是不在根之下');
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('工作区：.. 逃出根 → 拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-dotdot-escape-'));
  try {
    const store = new LocalFolderStore(dir);
    assert.throws(
      () => store.resolve('../../evil.txt'),
      (err) => {
        assert.ok(err instanceof PathEscapeError);
        assert.match(err.message, /路径越界/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('工作区：根内的相对路径与根内的绝对路径照常放行（别把闸门修过头）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-inside-ok-'));
  try {
    const store = new LocalFolderStore(dir);
    assert.equal(store.resolve('a/b.tif'), join(dir, 'a', 'b.tif'));
    // 根内的绝对路径仍然合法（写回流程里临时文件就是绝对路径）
    const abs = join(dir, 'c.tif');
    assert.equal(store.resolve(abs), abs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── 2. 拼接：inputs / output 与其它 op 一样过闸门 ────────── */

test('拼接：inputs 里的绝对路径必须被拒（与其它 op 一致）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-mosaic-abs-'));
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      { op: 'raster.mosaic', params: { inputs: [HOSTS, 'other.tif'] } },
    );
    assert.equal(res.ok, false, '绝对路径必须被拒');
    assert.equal(res.results[0].ok, false);
    const err = res.results[0].error ?? '';
    assert.match(err, /相对路径/, '要说清必须是相对路径');
    assert.match(err, /不在已登记的工作区根之下/, '要说清不在工作区根之下');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('拼接：inputs 里的 .. 必须被拒', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-mosaic-dotdot-'));
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      { op: 'raster.mosaic', params: { inputs: ['../../evil.tif', 'other.tif'] } },
    );
    assert.equal(res.ok, false, '.. 必须被拒');
    assert.equal(res.results[0].ok, false);
    const err = res.results[0].error ?? '';
    assert.match(err, /\.\./, '要说清是 .. 的问题');
    assert.match(err, /不在已登记的工作区根之下/, '要说清不在工作区根之下');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('拼接：output 里的绝对路径同样必须被拒', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-mosaic-out-'));
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      {
        op: 'raster.mosaic',
        params: { inputs: ['a.tif', 'b.tif'], output: HOSTS },
      },
    );
    assert.equal(res.ok, false, 'output 的绝对路径必须被拒');
    assert.match(res.results[0].error ?? '', /不在已登记的工作区根之下/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('拼接：dataset:// 前缀的相对路径照常放行（引擎能认的形状不能被堵死）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-mosaic-rel-'));
  try {
    const store = new LocalFolderStore(dir);
    const res = await executePlan(
      { loc, store },
      { op: 'raster.mosaic', params: { inputs: ['dataset://a.tif', 'b.tif'] } },
    );
    // 放行到「文件不存在」这一步即可（路径闸门没拦它）
    const err = res.results[0].error ?? '';
    assert.doesNotMatch(err, /相对路径/, '相对路径不该被路径闸门拦下');
    assert.doesNotMatch(err, /工作区根/, '相对路径不该被路径闸门拦下');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
