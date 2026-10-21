import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { LocalFolderStore, sha256, OccupiedError, existsFromErrorCode } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'workspace', 'index.ts')).href
);

async function tmpStore() {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-ws-'));
  return { dir, store: new LocalFolderStore(dir) };
}

test('resolve：相对路径落在根目录内', async () => {
  const { dir, store } = await tmpStore();
  try {
    const p = store.resolve('a/b.tif');
    assert.ok(p.startsWith(dir));
    assert.ok(p.endsWith('b.tif'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve：拒绝越界路径（../）', async () => {
  const { dir, store } = await tmpStore();
  try {
    assert.throws(() => store.resolve('../evil.txt'), /路径越界/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exists：只有"确实不存在"才返回 false', async () => {
  const { dir, store } = await tmpStore();
  try {
    await store.write('there.tif', new TextEncoder().encode('x'));
    assert.equal(await store.exists('there.tif'), true, '存在的文件应为 true');
    assert.equal(await store.exists('missing.tif'), false, 'ENOENT 应为 false');
    // 父路径不是目录 → ENOTDIR，同样属于"确实不存在"
    assert.equal(await store.exists('missing-dir/file.tif'), false, 'ENOTDIR 应为 false');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('existsFromErrorCode：只有 ENOENT/ENOTDIR 算"不存在"，访问被拒必须算"存在"', () => {
  assert.equal(existsFromErrorCode('ENOENT'), 'missing');
  assert.equal(existsFromErrorCode('ENOTDIR'), 'missing');
  for (const c of ['EACCES', 'EPERM', 'EBUSY']) {
    assert.equal(existsFromErrorCode(c), 'exists', `${c} 必须判定为"存在"，否则会跳过备份`);
  }
  assert.equal(existsFromErrorCode('EIO'), 'unknown', '未知错误不能被当成"不存在"');
  assert.equal(existsFromErrorCode(undefined), 'unknown');
});

test('exists：未预期的错误必须抛出，不能伪装成"不存在"', async () => {
  const { dir, store } = await tmpStore();
  try {
    // 非法路径（带 NUL）会抛出 ERR_INVALID_ARG_VALUE —— 属于"不知道"而非"不存在"
    await assert.rejects(() => store.exists('bad\0name.tif'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('write/read 往返内容一致', async () => {
  const { dir, store } = await tmpStore();
  try {
    const data = new TextEncoder().encode('hello 图签');
    await store.write('x/y.txt', data);
    const back = await store.read('x/y.txt');
    assert.equal(Buffer.from(back).toString('utf8'), 'hello 图签');
    assert.equal(sha256(back), sha256(data));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('read：不存在的文件抛 NotFoundError', async () => {
  const { dir, store } = await tmpStore();
  try {
    await assert.rejects(() => store.read('missing.txt'), /文件不存在/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rename：目标已存在时整体替换（原内容不残留）', async () => {
  const { dir, store } = await tmpStore();
  try {
    await store.write('a.txt', new TextEncoder().encode('OLD-CONTENT-LONGER'));
    await store.write('b.txt', new TextEncoder().encode('NEW'));
    await store.rename('b.txt', 'a.txt');
    const back = await store.read('a.txt');
    assert.equal(Buffer.from(back).toString('utf8'), 'NEW', '替换后应只剩新内容');
    // 原文件不能有残留
    const files = await readdir(dir);
    assert.ok(!files.includes('b.txt'), '源文件应已被重命名掉');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assertWritable：检测到同名锁文件时抛 OccupiedError', async () => {
  const { dir, store } = await tmpStore();
  try {
    await store.write('locked.txt', new TextEncoder().encode('x'));
    // ArcGIS 打开 shapefile 时会在旁边留下 <name>.lock
    await store.write('locked.lock', new TextEncoder().encode(''));
    await assert.rejects(() => store.assertWritable('locked.txt'), OccupiedError);
    // 没有锁文件时同一路径应可写
    await store.write('free.txt', new TextEncoder().encode('x'));
    await store.assertWritable('free.txt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assertWritable：ArcGIS 风格的临时锁（.~xxx.lock）也算占用', async () => {
  const { dir, store } = await tmpStore();
  try {
    await store.write('a.txt', new TextEncoder().encode('x'));
    await store.write('.~arcgis.tmp.lock', new TextEncoder().encode(''));
    await assert.rejects(() => store.assertWritable('a.txt'), OccupiedError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assertWritable：FileGDB 目录内的 .lock 也会被识别', async () => {
  const { dir, store } = await tmpStore();
  try {
    await store.write('data.gdb/a.gdbtable', new TextEncoder().encode('x'));
    await store.write('data.gdb/data.gdb.lock', new TextEncoder().encode(''));
    await assert.rejects(() => store.assertWritable('data.gdb'), OccupiedError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assertWritable：文件不存在时视为可写', async () => {
  const { dir, store } = await tmpStore();
  try {
    await store.assertWritable('not-there.txt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('copy：复制后原文件仍在', async () => {
  const { dir, store } = await tmpStore();
  try {
    await store.write('a.txt', new TextEncoder().encode('data'));
    await store.copy('a.txt', 'b.txt');
    assert.equal(Buffer.from(await store.read('b.txt')).toString(), 'data');
    assert.ok(await store.exists('a.txt'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stat：返回大小与类型', async () => {
  const { dir, store } = await tmpStore();
  try {
    await store.write('a.txt', new TextEncoder().encode('12345'));
    const s = await store.stat('a.txt');
    assert.equal(s.size, 5);
    assert.equal(s.isDirectory, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mkdir：写入不存在的子目录会自动创建', async () => {
  const { dir, store } = await tmpStore();
  try {
    await store.write('deep/nested/dir/f.txt', new TextEncoder().encode('v'));
    const s = await store.stat('deep/nested/dir/f.txt');
    assert.equal(s.size, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
