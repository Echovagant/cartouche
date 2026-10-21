import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { RootRegistry } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'workspace', 'roots.ts')).href
);

test('RootRegistry：默认根内置，list 返回它', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-roots-'));
  const reg = new RootRegistry(dir);
  const list = reg.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].builtin, true);
  assert.equal(list[0].path, dir);
});

test('RootRegistry：add 登记新根并给出 id 与 label', async () => {
  const a = await mkdtemp(join(tmpdir(), 'cartouche-roots-a-'));
  const b = await mkdtemp(join(tmpdir(), 'cartouche-roots-b-'));
  const reg = new RootRegistry(a);
  const added = reg.add(b);
  assert.equal(added.builtin, false);
  assert.equal(added.path, b);
  assert.equal(added.label, b.split(sep).pop());
  assert.equal(reg.list().length, 2);
});

test('RootRegistry：resolve 相对路径 → 落到默认根', async () => {
  const a = await mkdtemp(join(tmpdir(), 'cartouche-roots-a-'));
  const reg = new RootRegistry(a);
  const r = reg.resolve('子目录/图.tff');
  assert.equal(r.absolute, join(a, '子目录', '图.tff'));
  assert.equal(r.relative, join('子目录', '图.tff'));
});

test('RootRegistry：resolve 绝对路径 → 落到最长前缀匹配的那个根', async () => {
  const a = await mkdtemp(join(tmpdir(), 'cartouche-roots-a-'));
  const b = await mkdtemp(join(tmpdir(), 'cartouche-roots-b-'));
  // 在 b 下再造一个同名子目录，验证「最长匹配」而不是「先注册先赢」
  const trap = join(b, 'trap');
  await mkdir(trap, { recursive: true });
  const reg = new RootRegistry(a);
  reg.add(b);
  const r = reg.resolve(join(trap, 'x.tff'));
  assert.equal(r.absolute, join(trap, 'x.tff'));
  assert.equal(r.relative, join('trap', 'x.tff'));
});

test('RootRegistry：绝对路径不在任何已登记根下 → 抛 PathEscapeError', async () => {
  const a = await mkdtemp(join(tmpdir(), 'cartouche-roots-a-'));
  const outside = await mkdtemp(join(tmpdir(), 'cartouche-outside-'));
  const reg = new RootRegistry(a);
  assert.throws(() => reg.resolve(join(outside, 'x.tff')), /越界|不在已登记/);
});

test('RootRegistry：路径里带 .. 逃出根 → 拒绝', async () => {
  const a = await mkdtemp(join(tmpdir(), 'cartouche-roots-a-'));
  const reg = new RootRegistry(a);
  assert.throws(() => reg.resolve(join(a, '..', 'x.tff')), /越界|不在已登记/);
});

test('RootRegistry：Windows 下大小写不同的同一个目录要认得出来', { skip: process.platform !== 'win32' }, async () => {
  const a = await mkdtemp(join(tmpdir(), 'cartouche-roots-a-'));
  const reg = new RootRegistry(a);
  const r = reg.resolve(join(a.toUpperCase(), 'x.tff'));
  assert.equal(r.rootId, 'r0');
  assert.equal(r.relative, 'x.tff');
});

test('RootRegistry：remove 之后该根下的路径不再可解析', async () => {
  const a = await mkdtemp(join(tmpdir(), 'cartouche-roots-a-'));
  const b = await mkdtemp(join(tmpdir(), 'cartouche-roots-b-'));
  const reg = new RootRegistry(a);
  const added = reg.add(b);
  reg.resolve(join(b, 'x.tff'));
  reg.remove(added.id);
  assert.throws(() => reg.resolve(join(b, 'x.tff')), /越界|不在已登记/);
});

test('RootRegistry：storeFor 返回该根下的 LocalFolderStore', async () => {
  const a = await mkdtemp(join(tmpdir(), 'cartouche-roots-a-'));
  const reg = new RootRegistry(a);
  const store = reg.storeFor(reg.list()[0].id);
  await store.write('x.txt', new TextEncoder().encode('hi'));
  assert.equal(Buffer.from(await store.read('x.txt')).toString('utf8'), 'hi');
});
