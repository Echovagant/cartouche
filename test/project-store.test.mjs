import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { RootRegistry } = await import(pathToFileURL(join(root, 'src', 'engine', 'workspace', 'roots.ts')).href);
const { ProjectStore, PROJECT_DIR_NAME } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'project', 'store.ts')).href
);
const { newManifest } = await import(pathToFileURL(join(root, 'src', 'engine', 'project', 'manifest.ts')).href);

async function setup() {
  const data = await mkdtemp(join(tmpdir(), 'cartouche-proj-'));
  const project = join(data, '任务A');
  await mkdir(project, { recursive: true });
  const reg = new RootRegistry(data);
  return { data, project, store: new ProjectStore(reg) };
}

test('ProjectStore：项目还没有 .cartouche → readManifest 返回 null', async () => {
  const { project, store } = await setup();
  assert.equal(await store.readManifest(project), null);
});

test('ProjectStore：写完清单再读，内容一致', async () => {
  const { project, store } = await setup();
  const m = newManifest('任务A', '2026-10-21T08:00:00.000Z');
  await store.writeManifest(project, m);
  const back = await store.readManifest(project);
  assert.deepEqual(back, m);
});

test('ProjectStore：清单落在 .cartouche/project.json，源数据目录不被污染', async () => {
  const { project, store } = await setup();
  await store.writeManifest(project, newManifest('任务A'));
  const raw = await readFile(join(project, PROJECT_DIR_NAME, 'project.json'), 'utf8');
  assert.match(raw, /"name": "任务A"/);
});

test('ProjectStore：留痕按行追加，每行一个 JSON', async () => {
  const { project, store } = await setup();
  await store.appendHistory(project, { at: '2026-10-21T09:00:00.000Z', op: 'raster.paint', target: 'a.tff', ok: true });
  await store.appendHistory(project, { at: '2026-10-21T09:01:00.000Z', op: 'raster.erase', target: 'a.tff', ok: false, error: '文件被占用' });
  const rows = await store.readHistory(project);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].op, 'raster.paint');
  assert.equal(rows[1].ok, false);
  assert.equal(rows[1].error, '文件被占用');
});

test('ProjectStore：留痕文件不存在时返回空数组', async () => {
  const { project, store } = await setup();
  assert.deepEqual(await store.readHistory(project), []);
});

test('ProjectStore：产出物写入 outputs/ 并能列出', async () => {
  const { project, store } = await setup();
  const rel = await store.writeOutput(project, '出图.pdf', new TextEncoder().encode('%PDF-1.4'));
  assert.match(rel, /outputs/);
  const list = await store.listOutputs(project);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '出图.pdf');
  assert.equal(list[0].size, 8);
});

test('ProjectStore：产出物文件名带路径 → 拒绝，不写到项目外', async () => {
  const { project, store } = await setup();
  await assert.rejects(
    () => store.writeOutput(project, '../逃逸.pdf', new TextEncoder().encode('x')),
    /文件名/,
  );
  // 确认没有落到项目外面去
  const leaked = await readFile(join(dirname(project), '逃逸.pdf'), 'utf8').catch(() => null);
  assert.equal(leaked, null);
});

test('ProjectStore：项目根本身就是一个已登记根 → 也能正常写清单', async () => {
  const data = await mkdtemp(join(tmpdir(), 'cartouche-proj-'));
  const reg = new RootRegistry(data);
  const store = new ProjectStore(reg);
  await store.writeManifest(data, newManifest('根目录项目'));
  const back = await store.readManifest(data);
  assert.equal(back?.name, '根目录项目');
});

test('ProjectStore：项目根不在已登记根下 → 抛 PathEscapeError', async () => {
  const { data, store } = await setup();
  const outside = await mkdtemp(join(tmpdir(), 'cartouche-out-'));
  await assert.rejects(() => store.readManifest(outside), /越界|不在已登记/);
});
