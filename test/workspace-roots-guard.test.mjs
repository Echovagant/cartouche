/**
 * 登记工作区根的两道闸。
 *
 * ## 背景：为什么要给「登记根」加限制
 *
 * 产品承诺是「只碰你登记过的目录」。但登记这个动作本身原来**不需要用户在场**：
 * `POST /api/workspace/roots` 会把**任意已存在目录**登记成根，并**持久化**到
 * `%LOCALAPPDATA%\cartouche\roots.json`；登记之后，那棵目录树整棵树可被读/写/删。
 *
 * 原来的 CORS 只比较 Origin 的 **hostname**（不含端口），所以任何 `http://127.0.0.1:*`
 * 的本机页面都放行；而跨站页面发 `application/json` 会被预检拦住，
 * 却可以改用 `text/plain` 发**简单请求**——**不触发预检**，请求照样送达。
 * 于是「本机上随便一个网页就能替用户登记一个根」是成立的。
 *
 * 两道闸：
 *  1. **登记必须声明 content-type: application/json**。
 *     浏览器只有在这一种情况下才会强制走 CORS 预检，于是跨站页面被预检挡住；
 *     而引擎自己的前端发的就是 application/json（`web/app/canvas/useProjects.ts:125`），
 *     **原有功能一点不受影响**。
 *  2. **新增 DELETE：用户能把登记撤销掉**。
 *     原来登记了**就删不掉**（只能手改 roots.json），承诺是单向的。
 *     补上撤销，「只碰你登记过的目录」才是个闭环。
 *
 * 本文件只测这两件事；不测「能不能登记」——那是既有能力，由引擎自己的前端保证。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listenSafe } from './helpers/listen-safe.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 环境变量必须在导入 app.ts **之前**设好：
 * app.ts 在模块加载时就确定了工作区根，roots.ts 也在加载时读配置目录。 */
const wsRoot = await mkdtemp(join(tmpdir(), 'cartouche-roots-guard-ws-'));
const cfgRoot = await mkdtemp(join(tmpdir(), 'cartouche-roots-guard-cfg-'));
process.env.ENGINE_WORKSPACE_ROOT = wsRoot;
process.env.CARTOUCHE_CONFIG_DIR = cfgRoot;

const { createEngineServer } = await import(
  pathToFileURL(join(repoRoot, 'server', 'src', 'app.ts')).href
);

let server = null;
let base = '';
/** 一个真实存在的目录，用来当「要登记的根」 */
let targetDir = '';

before(async () => {
  targetDir = join(cfgRoot, '要登记的目录');
  await mkdir(targetDir, { recursive: true });
  server = createEngineServer();
  const port = await listenSafe(server);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await rm(wsRoot, { recursive: true, force: true });
  await rm(cfgRoot, { recursive: true, force: true });
});

/** 按给定 content-type 发登记请求 */
async function register(contentType, body) {
  const res = await fetch(`${base}/api/workspace/roots`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** 读当前登记的根列表 */
async function listRoots() {
  const res = await fetch(`${base}/api/workspace/roots`);
  return res.json();
}

test('登记根：content-type 不是 application/json 会被拒（跨站简单请求的路子）', async () => {
  const { status } = await register('text/plain', JSON.stringify({ path: targetDir }));
  assert.notEqual(status, 200, 'text/plain 的简单请求不该被放行——它不触发 CORS 预检');
  assert.ok(status === 415 || status === 400, `期望 415 或 400，实际 ${status}`);
});

test('登记根：不给 content-type 也会被拒', async () => {
  const res = await fetch(`${base}/api/workspace/roots`, {
    method: 'POST',
    body: JSON.stringify({ path: targetDir }),
  });
  assert.notEqual(res.status, 200, '没声明 content-type 的请求不该被放行');
});

test('登记根：application/json 照常成功（原有功能不受影响）', async () => {
  const { status, json } = await register('application/json', JSON.stringify({ path: targetDir }));
  assert.equal(status, 200);
  assert.ok(json && typeof json.path === 'string', '应回登记后的根信息');
  assert.equal(json.builtin, false);
});

test('登记根：被拒的请求不会把根登记进去（不能只挡响应不挡副作用）', async () => {
  const before = await listRoots();
  await register('text/plain', JSON.stringify({ path: targetDir }));
  const after = await listRoots();
  assert.equal(
    after.roots.length,
    before.roots.length,
    '被拒的请求不该改变已登记的根',
  );
});

test('撤销登记：DELETE 能把根从列表里去掉', async () => {
  const before = await listRoots();
  const target = before.roots.find((r) => !r.builtin);
  assert.ok(target, '前面应该已经登记了一个非内置根');

  // 撤销凭**根的 id**（前端拿不到绝对路径，所以只能凭 id）
  const res = await fetch(`${base}/api/workspace/roots`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: target.id }),
  });
  assert.equal(res.status, 200);

  const after = await listRoots();
  assert.ok(
    !after.roots.some((r) => r.id === target.id),
    '撤销后列表里不该还有这个根',
  );
});

test('撤销登记：撤销也要从落盘的文件里去掉（否则重启后又回来了）', async () => {
  // 自己登记一个根，不依赖上一个测试的残留 —— 测试之间不该有顺序依赖
  const ownDir = join(cfgRoot, '要落盘检查的目录');
  await mkdir(ownDir, { recursive: true });
  const reg = await register('application/json', JSON.stringify({ path: ownDir }));
  assert.equal(reg.status, 200, '前置：登记应当成功');

  const rootsFile = join(cfgRoot, 'roots.json');
  const beforeRaw = JSON.parse(await readFile(rootsFile, 'utf8'));
  assert.ok(
    beforeRaw.some((r) => r.path === ownDir),
    '前置：登记后落盘文件里应该有这个根',
  );

  // 凭 id 撤销（前端不知道绝对路径）
  const list = await listRoots();
  const own = list.roots.find((r) => r.label === '要落盘检查的目录');
  assert.ok(own, '前置：列表里应该能找到刚登记的根');

  const del = await fetch(`${base}/api/workspace/roots`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: own.id }),
  });
  assert.equal(del.status, 200);

  const raw = JSON.parse(await readFile(rootsFile, 'utf8'));
  assert.ok(
    !raw.some((r) => r.path === ownDir),
    '落盘文件里不该还有这个根——否则重启后又出现了',
  );
});

test('撤销登记：内置默认根不可撤销（删了相对路径就没地方解析了）', async () => {
  const before = await listRoots();
  const builtin = before.roots.find((r) => r.builtin);
  assert.ok(builtin, '应该有一个内置默认根');

  const res = await fetch(`${base}/api/workspace/roots`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: builtin.id }),
  });
  assert.notEqual(res.status, 200, '内置默认根不该能被删');

  const after = await listRoots();
  assert.ok(after.roots.some((r) => r.builtin), '内置默认根必须还在');
});

test('撤销登记：撤销一个没登记过的要说清楚，不能静默成功', async () => {
  const res = await fetch(`${base}/api/workspace/roots`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'r-does-not-exist' }),
  });
  assert.notEqual(res.status, 200, '撤销不存在的根不该报成功');
});
