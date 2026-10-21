import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { LocalFolderStore } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'workspace', 'index.ts')).href
);
const { writeBack, backupPathFor, replaceFileAtomically } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'gdal', 'writeback.ts')).href
);

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-wb-'));
  const store = new LocalFolderStore(dir);
  await store.write('data.tif', new TextEncoder().encode('ORIGINAL'));
  return { dir, store };
}

test('写回：原文件被新内容整体替换', async () => {
  const { dir, store } = await setup();
  try {
    const res = await writeBack(store, {
      target: 'data.tif',
      data: new TextEncoder().encode('MODIFIED'),
    });
    const after = Buffer.from(await store.read('data.tif')).toString();
    assert.equal(after, 'MODIFIED');
    assert.equal(res.verified, true);
    assert.equal(res.bytesWritten, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：自动生成备份，且备份内容是原文件', async () => {
  const { dir, store } = await setup();
  try {
    const res = await writeBack(store, {
      target: 'data.tif',
      data: new TextEncoder().encode('MODIFIED'),
    });
    assert.ok(res.backupPath, '应返回备份路径');
    const backup = Buffer.from(await store.read(res.backupPath)).toString();
    assert.equal(backup, 'ORIGINAL', '备份必须是写回前的原内容');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：backup=false 时不产生备份', async () => {
  const { dir, store } = await setup();
  try {
    const res = await writeBack(store, {
      target: 'data.tif',
      data: new TextEncoder().encode('MODIFIED'),
      backup: false,
    });
    assert.equal(res.backupPath, null);
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.includes('.bak.')).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：即使 exists() 误报"不存在"，也必须生成备份（防无备份覆盖原文件）', async () => {
  const { dir, store } = await setup();
  try {
    // 模拟 Windows 上文件被杀软/索引器短暂独占：access 失败 → 早期实现的 exists()
    // 会把它误判成"文件不存在"，于是跳过备份直接覆盖原文件。
    const lying = Object.create(store);
    lying.exists = async () => false;
    const res = await writeBack(lying, {
      target: 'data.tif',
      data: new TextEncoder().encode('MODIFIED'),
    });
    assert.ok(res.backupPath, 'exists() 误报不存在时也必须生成备份');
    const backup = Buffer.from(await store.read(res.backupPath)).toString();
    assert.equal(backup, 'ORIGINAL', '备份必须是写回前的原内容');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('原子替换：即使 exists() 误报"不存在"，也必须生成备份', async () => {
  const { dir, store } = await setup();
  try {
    await store.write('.tmp.tif', new TextEncoder().encode('NEW'));
    const lying = Object.create(store);
    lying.exists = async () => false;
    const res = await replaceFileAtomically(lying, { target: 'data.tif', tempPath: '.tmp.tif' });
    assert.ok(res.backupPath, 'exists() 误报不存在时也必须生成备份');
    const backup = Buffer.from(await store.read(res.backupPath)).toString();
    assert.equal(backup, 'ORIGINAL', '备份必须是替换前的原内容');
    assert.equal(Buffer.from(await store.read('data.tif')).toString(), 'NEW');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：同一秒内对同一目标连续写回，备份不会互相覆盖', async () => {
  const { dir, store } = await setup();
  try {
    // 用同一个 label 强制两次备份同名，模拟"同一秒内连续写回"
    const r1 = await writeBack(store, {
      target: 'data.tif',
      data: new TextEncoder().encode('VERSION2'),
      label: 'same',
    });
    const r2 = await writeBack(store, {
      target: 'data.tif',
      data: new TextEncoder().encode('VERSION3'),
      label: 'same',
    });
    assert.notEqual(r1.backupPath, r2.backupPath, '两次备份不能是同一个文件名');
    assert.equal(
      Buffer.from(await store.read(r1.backupPath)).toString(),
      'ORIGINAL',
      '第一份备份必须仍是最初的内容（不能被第二次覆盖）',
    );
    assert.equal(
      Buffer.from(await store.read(r2.backupPath)).toString(),
      'VERSION2',
      '第二份备份是上一版内容',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：目标确实不存在时不产生备份，写入仍然成功', async () => {
  const { dir, store } = await setup();
  try {
    const res = await writeBack(store, {
      target: 'brand-new.tif',
      data: new TextEncoder().encode('BRAND NEW'),
    });
    assert.equal(res.backupPath, null, '目标本来就不存在，不应有备份');
    assert.equal(Buffer.from(await store.read('brand-new.tif')).toString(), 'BRAND NEW');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：不留下临时文件', async () => {  const { dir, store } = await setup();
  try {
    await writeBack(store, { target: 'data.tif', data: new TextEncoder().encode('MODIFIED') });
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0, '不应残留 .tmp 文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：伴随文件一并写入', async () => {
  const { dir, store } = await setup();
  try {
    await writeBack(store, {
      target: 'data.tif',
      data: new TextEncoder().encode('MODIFIED'),
      sidecars: [
        { path: 'data.tfw', data: new TextEncoder().encode('0.001\n') },
        { path: 'data.prj', data: new TextEncoder().encode('GEOGCS[]\n') },
      ],
    });
    assert.equal(Buffer.from(await store.read('data.tfw')).toString(), '0.001\n');
    assert.ok(await store.exists('data.prj'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：文件被占用时抛 OccupiedError 且原文件不变', async () => {
  const { dir, store } = await setup();
  try {
    // 模拟 ArcGIS 持有文件：覆盖式 rename 失败（EPERM/EBUSY）
    const locked = Object.create(store);
    locked.rename = async () => {
      const err = new Error('EPERM: operation not permitted');
      err.code = 'EPERM';
      throw err;
    };
    await assert.rejects(
      () => writeBack(locked, { target: 'data.tif', data: new TextEncoder().encode('MODIFIED') }),
      /文件被占用/,
    );
    const after = Buffer.from(await store.read('data.tif')).toString();
    assert.equal(after, 'ORIGINAL', '被占用时原文件必须保持不变');
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0, '失败后应清理临时文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：存在锁文件时提前拒绝，且不产生备份', async () => {
  const { dir, store } = await setup();
  try {
    await store.write('data.lock', new TextEncoder().encode(''));
    await assert.rejects(
      () => writeBack(store, { target: 'data.tif', data: new TextEncoder().encode('MODIFIED') }),
      /文件被占用/,
    );
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.includes('.bak.')).length, 0, '被占用时不应产生备份');
    assert.equal(Buffer.from(await store.read('data.tif')).toString(), 'ORIGINAL');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：校验失败时中止替换，原文件保持不变', async () => {
  const { dir, store } = await setup();
  try {
    // 注入一个会篡改写入内容的 store，模拟"写进去的东西不对"
    const evil = Object.create(store);
    evil.write = async (path, data) => {
      if (String(path).endsWith('.tmp')) {
        await store.write(path, new TextEncoder().encode('CORRUPTED'));
        return;
      }
      return store.write(path, data);
    };
    await assert.rejects(
      () => writeBack(evil, { target: 'data.tif', data: new TextEncoder().encode('MODIFIED') }),
      /校验失败/,
    );
    const after = Buffer.from(await store.read('data.tif')).toString();
    assert.equal(after, 'ORIGINAL', '校验失败时原文件必须保持不变');
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0, '失败后应清理临时文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('backupPathFor：备份名带时间戳且与目标同目录', () => {
  const p = backupPathFor('a/b/data.tif');
  assert.ok(p.startsWith('a/b/data.tif.bak.'), p);
  assert.ok(!p.includes('\\'), '应使用正斜杠保持跨平台一致');
});
