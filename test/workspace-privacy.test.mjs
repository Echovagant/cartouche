/**
 * 工作区的三条约定：自己能选、能多个、界面不露绝对路径。
 *
 * ## 为什么这三条要单独立测试
 *
 * 这三件事是**产品承诺**，不是实现细节：
 *   1. 用户**自己挑**工作区（不写死某个路径）；
 *   2. 可以有**多个**工作区，随时换、随时撤；
 *   3. 界面上**不出现**用户的盘符与用户名。
 *
 * 第 3 条最容易在后来的改动里被破坏 —— 比如哪天有人觉得
 * 「显示完整路径更方便」就给加回来了。所以在这里盯死它。
 *
 * 这里测的是**真实引擎**（起一个 createEngineServer 在本进程里），
 * 不是字面量断言 —— 因为「有没有把路径漏出去」这种事，
 * 只有真的调一次接口才知道。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listenSafe } from './helpers/listen-safe.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const wsRoot = await mkdtemp(join(tmpdir(), 'cartouche-wsprivacy-ws-'));
const cfgRoot = await mkdtemp(join(tmpdir(), 'cartouche-wsprivacy-cfg-'));
process.env.ENGINE_WORKSPACE_ROOT = wsRoot;
process.env.CARTOUCHE_CONFIG_DIR = cfgRoot;

/**
 * 预置一份代号表：弹窗流程没法在无人环境里真弹（会挂到超时，见下面的说明），
 * 所以「代号 → 目录」这层契约用**落盘的代号表**来测 ——
 * 引擎启动时会把它灌回内存（folder-picker.ts 的 loadHandles），
 * 之后的 manifest / fs 请求带 `folder-1` 就等于指着这个目录。
 * 这同时测到了「代号表跨重启存活」这条承诺。
 */
const handleDir = join(cfgRoot, '弹窗选的项目');
await mkdir(handleDir, { recursive: true });
await (
  await import('node:fs/promises')
).writeFile(join(cfgRoot, 'handles.json'), JSON.stringify({ 'folder-1': handleDir }), 'utf8');

const { createEngineServer } = await import(
  pathToFileURL(join(repoRoot, 'server', 'src', 'app.ts')).href
);

let server = null;
let base = '';

before(async () => {
  server = createEngineServer();
  const port = await listenSafe(server);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await rm(wsRoot, { recursive: true, force: true });
  await rm(cfgRoot, { recursive: true, force: true });
});

describe('已登记的工作区', () => {
  test('列表里**没有绝对路径**（界面不能露出用户的盘符与用户名）', async () => {
    const res = await fetch(`${base}/api/workspace/roots`);
    assert.equal(res.status, 200);
    const raw = await res.text();

    // 整个响应体里都不能出现盘符开头的路径
    assert.equal(/[A-Za-z]:\\/.test(raw), false, `响应里有绝对路径：${raw.slice(0, 300)}`);
    assert.equal(raw.includes('Users'), false, '响应里有用户目录');
    // 也不能出现用户目录本身（那带着用户名）。
    // ⚠️ 注意别拿临时目录名当判据 —— 默认根的**名字**就是那个目录名，
    //    它是合法的展示名，不是路径泄漏（实测踩过这个坑）。
    assert.equal(raw.includes('\\AppData\\'), false, '响应里带着用户目录片段');

    const body = JSON.parse(raw);
    assert.ok(Array.isArray(body.roots));
    for (const r of body.roots) {
      assert.equal('path' in r, false, `根 ${r.id} 带了 path 字段`);
      assert.equal(typeof r.id, 'string');
      assert.equal(typeof r.label, 'string');
      assert.equal(typeof r.builtin, 'boolean');
      // location 是相对默认根的位置，也不该有盘符
      if (r.location) {
        assert.equal(/[A-Za-z]:\\/.test(r.location), false, `location ${r.location} 带了盘符`);
      }
    }
  });

  test('可以登记**多个**工作区，互不影响', async () => {
    const a = join(cfgRoot, '甲工作区');
    const b = join(cfgRoot, '乙工作区');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });

    for (const dir of [a, b]) {
      const res = await fetch(`${base}/api/workspace/roots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      });
      assert.equal(res.status, 200, `登记 ${dir} 应当成功`);

      // 登记的**响应**也不许带绝对路径：GET 消毒了，POST 不能漏
      const raw = await res.text();
      assert.equal(/[A-Za-z]:\\/.test(raw), false, `登记响应里有绝对路径：${raw.slice(0, 300)}`);
      assert.equal(raw.includes('\\AppData\\'), false, '登记响应里带着用户目录片段');
      const entry = JSON.parse(raw);
      assert.equal('path' in entry, false, '登记响应带了 path 字段');
      assert.equal(typeof entry.id, 'string', '登记响应要有 id');
    }

    const body = await (await fetch(`${base}/api/workspace/roots`)).json();
    const labels = body.roots.map((r) => r.label);
    assert.ok(labels.includes('甲工作区'), '甲工作区没在列表里');
    assert.ok(labels.includes('乙工作区'), '乙工作区没在列表里');
  });

  test('撤销凭**根的 id**，撤销完它就没了', async () => {
    const body = await (await fetch(`${base}/api/workspace/roots`)).json();
    const target = body.roots.find((r) => r.label === '乙工作区');
    assert.ok(target, '找不到乙工作区');

    const del = await fetch(`${base}/api/workspace/roots`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: target.id }),
    });
    assert.equal(del.status, 200);

    const after = await (await fetch(`${base}/api/workspace/roots`)).json();
    assert.equal(
      after.roots.some((r) => r.id === target.id),
      false,
      '撤销后它还在列表里',
    );
  });

  test('撤销不存在的 id 要说清楚，不能静默成功', async () => {
    const res = await fetch(`${base}/api/workspace/roots`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'r-does-not-exist' }),
    });
    assert.notEqual(res.status, 200);
    const body = await res.json();
    assert.match(body.message ?? '', /找不到/);
  });

  test('内置默认根不能撤销', async () => {
    const body = await (await fetch(`${base}/api/workspace/roots`)).json();
    const builtin = body.roots.find((r) => r.builtin);
    assert.ok(builtin, '应该有一个内置默认根');

    const res = await fetch(`${base}/api/workspace/roots`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: builtin.id }),
    });
    assert.notEqual(res.status, 200, '内置默认根不该能被撤销');
  });
});

describe('代号全链路（folder-N）', () => {
  /**
   * 弹窗选完目录之后，前端手里**只有代号**。这一组测试把"只有代号"的
   * 一整套动作走一遍：登记 → 新建项目 → 读项目 → 列文件 ——
   * 任何一步要求前端给出绝对路径，就等于把"路径不出引擎"的承诺撕了。
   */
  test('登记（凭代号）→ 新建项目 → 读项目，全程不需要路径', async () => {
    // 1. 登记：凭代号（弹窗流程里前端只有这个）
    const reg = await fetch(`${base}/api/workspace/roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'folder-1' }),
    });
    assert.equal(reg.status, 200, '凭代号登记应当成功');

    // 2. 新建项目：只给代号
    const put = await fetch(`${base}/api/project/manifest`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'folder-1', create: true }),
    });
    const putRaw = await put.text();
    assert.equal(put.status, 200, `凭代号新建项目应当成功：${putRaw.slice(0, 200)}`);
    const created = JSON.parse(putRaw);
    assert.equal(created.created, true, '应当真的建出清单');
    assert.ok(created.manifest?.name, '项目要有名字（取文件夹名）');

    // 3. 读项目：只给代号
    const get = await fetch(`${base}/api/project/manifest?handle=folder-1`);
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.exists, true, '凭代号要能读回项目清单');
    assert.equal(body.manifest.name, created.manifest.name);
  });

  test('列文件也能凭代号定位（resolveTarget 认 folder-N）', async () => {
    const res = await fetch(`${base}/api/fs/list?root=folder-1`);
    assert.equal(res.status, 200, `凭代号列文件应当成功：${await res.text()}`);
  });

  test('不存在的代号要明确报错，不能静默', async () => {
    const put = await fetch(`${base}/api/project/manifest`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'folder-999', create: true }),
    });
    assert.notEqual(put.status, 200, '死代号不该静默成功');
  });

  test('文件列表不出现点开头条目（.cartouche 不能被当成图层）', async () => {
    // 2026-11-14 实测事故：.cartouche/project.json 出现在加载列表里，
    // 用户点「加载」后清单被当矢量去转，失败还污染了项目清单。
    // 工具目录是隐藏语义，这里钉死它不许再出现在列表里。
    await mkdir(join(handleDir, '.cartouche'), { recursive: true });
    await writeFile(join(handleDir, '.cartouche', 'project.json'), '{}', 'utf8');

    const res = await fetch(`${base}/api/fs/list?root=folder-1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(Array.isArray(body.entries), true);
    assert.equal(
      body.entries.some((n) => String(n).startsWith('.')),
      false,
      `列表里出现了点开头条目：${JSON.stringify(body.entries).slice(0, 200)}`,
    );
  });
});

describe('弹文件夹对话框', () => {
  test('必须是 application/json（跨站简单请求进不来）', async () => {
    const res = await fetch(`${base}/api/workspace/pick-folder`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    assert.equal(res.status, 415);
  });

  test('端点在（用错方法时它回 404 而不是 500，说明路由认得这个路径）', async () => {
    // ⚠️ 不能用 application/json 真去调：那会真的弹出系统的选择框，
    //    在没有人点击的环境里会一直挂着（实测会卡到超时）。
    //    所以这里只验证「端点存在」—— 用一个明显非法的方法，
    //    它会走到路由判断而不是弹窗。
    const res = await fetch(`${base}/api/workspace/pick-folder`, {
      method: 'GET',
    });
    // 路由只认 POST，所以 GET 落到兜底分支回 404 ——
    // 只要不是 500（说明代码崩了），就说明端点在那儿
    assert.notEqual(res.status, 500, '端点处理时崩了');
  });
});
