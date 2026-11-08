/**
 * `/api/fs/*` 这一组接口的 root 口径必须一致。
 *
 * ## 背景
 *
 * `read` / `write` / `remove` / `rename` 都用 `url.searchParams.get('root')` 来定位根，
 * 但 `assert-writable` 原来写死了 `resolveTarget(null, …)` —— 也就是**永远相对默认
 * 工作区根解析**。项目根登记在别处时，它会去检查错位置的文件：
 * 「这个文件没被占用」可能说的是另一个目录里的同名文件，
 * 「被占用了」也可能报在一个用户根本没在操作的路径上。
 *
 * 这是「读认、写不认」那条同型缺陷的另一个变体：**同一组接口两套口径**。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listenSafe } from './helpers/listen-safe.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 环境变量必须在导入 app.ts **之前**设好 */
const wsRoot = await mkdtemp(join(tmpdir(), 'cartouche-fsroot-ws-'));
const cfgRoot = await mkdtemp(join(tmpdir(), 'cartouche-fsroot-cfg-'));
process.env.ENGINE_WORKSPACE_ROOT = wsRoot;
process.env.CARTOUCHE_CONFIG_DIR = cfgRoot;

const { createEngineServer } = await import(
  pathToFileURL(join(repoRoot, 'server', 'src', 'app.ts')).href
);

let server = null;
let base = '';
/** 默认工作区之外的一个已登记根 */
let otherRoot = '';
/** 默认工作区里的一个同名文件 */
let decoy = '';
/** 已登记根里的同名文件 */
let real = '';

before(async () => {
  server = createEngineServer();
  const port = await listenSafe(server);
  base = `http://127.0.0.1:${port}`;

  otherRoot = join(cfgRoot, '另一个根');
  await mkdir(otherRoot, { recursive: true });
  await mkdir(wsRoot, { recursive: true });

  // 两个地方各放一个同名文件
  decoy = join(wsRoot, '同名.txt');
  real = join(otherRoot, '同名.txt');
  await writeFile(decoy, '默认根里的那个');
  await writeFile(real, '另一个根里的那个');

  // 把 otherRoot 登记成根
  const reg = await fetch(`${base}/api/workspace/roots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: otherRoot }),
  });
  assert.equal(reg.status, 200, '前置：登记另一个根应当成功');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await rm(wsRoot, { recursive: true, force: true });
  await rm(cfgRoot, { recursive: true, force: true });
});

test('assert-writable：带 root 时检查的是那个根里的文件，不是默认根里的同名文件', async () => {
  // 在**另一个根**里的文件上放一个占用标记（ArcGIS 风格的 .~xxx.lock）
  await writeFile(join(otherRoot, '.~同名.lock'), '');

  const res = await fetch(
    `${base}/api/fs/assert-writable?root=${encodeURIComponent(otherRoot)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: '同名.txt',
    },
  );

  // 另一个根里的同名文件确实被占用 → 必须报出来
  assert.equal(res.status, 409, '另一个根里的文件被占用了，应该报 409');
  const json = await res.json();
  assert.equal(json.error, 'occupied');
});

test('assert-writable：默认根里的同名文件没被占用时，不该被另一个根的状态牵连', async () => {
  // 默认根里的同名文件**没有**占用标记，但另一个根里的有。
  // 带着 root 去查默认根之外的路径时，行为要各归各 —— 这里查默认根（不传 root）。
  const res = await fetch(`${base}/api/fs/assert-writable`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: '同名.txt',
  });
  assert.equal(res.status, 200, '默认根里的同名文件没被占用，不该报 409');
});
