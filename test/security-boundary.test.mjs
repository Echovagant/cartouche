/**
 * 本机服务的安全边界。
 *
 * 锁的是 2026-11-18 审计出来的四条攻击路径：
 *   1. 同机其他用户/进程直接调接口 —— 没有令牌一律 401；
 *   2. DNS rebinding —— Host 不是回环地址一律 403；
 *   3. 跨站「简单请求」写副作用 —— text/plain 等一律 415；
 *   4. 自定义模型端点明文传输 —— http:// 非回环地址一律 400。
 *
 * 另外锁住工作区里的 junction / 符号链接不能把读写带出根外。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listenSafe } from './helpers/listen-safe.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 环境变量必须在导入 app.ts **之前**设好 */
const wsRoot = await mkdtemp(join(tmpdir(), 'cartouche-sec-ws-'));
const cfgRoot = await mkdtemp(join(tmpdir(), 'cartouche-sec-cfg-'));
const outsideRoot = await mkdtemp(join(tmpdir(), 'cartouche-sec-out-'));
process.env.ENGINE_WORKSPACE_ROOT = wsRoot;
process.env.CARTOUCHE_CONFIG_DIR = cfgRoot;

const { createEngineServer } = await import(
  pathToFileURL(join(repoRoot, 'server', 'src', 'app.ts')).href
);

const TOKEN = 'security-test-token';
let server = null;
let base = '';
let port = 0;

/** 用原生 http 发请求：Node 的 fetch 不允许改 Host 头，DNS rebinding 用例只能走这里 */
function rawRequest(path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const authHeaders = { 'x-cartouche-token': TOKEN };

before(async () => {
  server = createEngineServer({ authToken: TOKEN });
  port = await listenSafe(server);
  base = `http://127.0.0.1:${port}`;
  await writeFile(join(wsRoot, 'hello.txt'), 'hello');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await rm(wsRoot, { recursive: true, force: true });
  await rm(cfgRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

/* ───────── 1. 令牌 ───────── */

test('没有令牌：读接口一律 401', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'unauthorized');
  assert.ok(body.message.includes('令牌'), '要说清缺的是访问令牌');
});

test('令牌错误：401，且不能靠猜前缀通过', async () => {
  const res = await fetch(`${base}/api/health`, {
    headers: { 'x-cartouche-token': `${TOKEN}x` },
  });
  assert.equal(res.status, 401);
});

test('令牌正确：请求头与 GET 查询串两种方式都放行', async () => {
  const byHeader = await fetch(`${base}/api/health`, { headers: authHeaders });
  assert.equal(byHeader.status, 200);

  // 栅格图是 <img> 直接拉的，加不了请求头，只能走查询串
  const byQuery = await fetch(`${base}/api/health?token=${encodeURIComponent(TOKEN)}`);
  assert.equal(byQuery.status, 200);
});

test('OPTIONS 预检不要求令牌（浏览器还没发请求头）', async () => {
  const res = await fetch(`${base}/api/health`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.ok(
    String(res.headers.get('access-control-allow-headers')).includes('x-cartouche-token'),
    '预检必须放行 x-cartouche-token',
  );
});

/* ───────── 2. Host 白名单（DNS rebinding） ───────── */

test('Host 是外域：403，即使带着正确令牌', async () => {
  const res = await rawRequest('/api/health', {
    headers: { host: 'evil.example.com', ...authHeaders },
  });
  assert.equal(res.status, 403);
  assert.ok(res.body.includes('forbidden_host'));
});

test('Host 是本机回环：正常放行', async () => {
  const res = await rawRequest('/api/health', {
    headers: { host: `127.0.0.1:${port}`, ...authHeaders },
  });
  assert.equal(res.status, 200);
});

/* ───────── 3. 跨站「简单请求」不能产生写副作用 ───────── */

test('text/plain 写文件：415，且文件没有落盘', async () => {
  const res = await fetch(`${base}/api/fs/write`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', ...authHeaders },
    body: 'csrf.txt\nshould-not-exist',
  });
  assert.equal(res.status, 415);
  const after = await fetch(`${base}/api/fs/stat?path=csrf.txt`, { headers: authHeaders });
  assert.equal(after.status, 404, '被拒的请求不能留下文件');
});

test('application/octet-stream 写文件：正常放行', async () => {
  const body = Buffer.concat([Buffer.from('ok.txt'), Buffer.from([0]), Buffer.from('ok')]);
  const res = await fetch(`${base}/api/fs/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...authHeaders },
    body,
  });
  assert.equal(res.status, 200);
  const readBack = await fetch(`${base}/api/fs/read?path=ok.txt`, { headers: authHeaders });
  assert.equal(readBack.status, 200);
  assert.equal(await readBack.text(), 'ok');
});

test('text/plain 执行改图操作：415', async () => {
  const res = await fetch(`${base}/api/op/execute`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', ...authHeaders },
    body: JSON.stringify({ plan: { version: '1.0', ops: [] } }),
  });
  assert.equal(res.status, 415);
});

/* ───────── 4. 自定义模型端点不允许明文外发 ───────── */

test('自定义端点填 http:// 外网地址：400，并说明必须用 https', async () => {
  const res = await fetch(`${base}/api/llm/session-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({
      providerId: 'custom',
      apiKey: 'fake-key',
      baseUrl: 'http://example.com/v1',
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'unsafe_endpoint');
  assert.ok(body.message.includes('https'), '要说清必须用 https');
});

test('自定义端点填回环 http：允许（本机模型服务）', async () => {
  const res = await fetch(`${base}/api/llm/session-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({
      providerId: 'custom',
      apiKey: 'fake-key',
      baseUrl: 'http://127.0.0.1:12345/v1',
    }),
  });
  assert.equal(res.status, 200);
});

/* ───────── 5. junction / 符号链接不能逃出工作区 ───────── */

test('工作区里的链接指向根外：读请求被拒', async (t) => {
  await writeFile(join(outsideRoot, 'secret.txt'), 'outside-secret');
  const linkPath = join(wsRoot, 'link-out');
  try {
    await symlink(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    t.skip(`当前环境无法创建链接：${err.code ?? err.message}`);
    return;
  }

  const res = await fetch(`${base}/api/fs/read?path=link-out/secret.txt`, {
    headers: authHeaders,
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'path_escape');
});
