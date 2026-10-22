import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createChecklist } = await import(pathToFileURL(join(root, 'scripts', 'lib', 'checks.mjs')).href);

const FAIL = '\u25a0'; // ■
const PASS = '\u25cf'; // ●

/**
 * 「样本生成与写回往返校验」必须是**真门禁**：
 * 有检查项没通过时，`npm run fixture` 要以非零码退出，CI 那一步才会红。
 *
 * 2026-10-22 之前它只打印 ●/■ 从不影响退出码，于是这道门禁形同虚设。
 * 这里用两种方式钉住它：
 *   1. 清单本身的判定逻辑（单元测试，任何平台可跑）
 *   2. 真的把脚本跑起来，看退出码（端到端）
 *
 * 端到端用**沙箱**跑：把 scripts/ 复制到临时目录再执行。
 * 脚本的 fixtures 根目录是按脚本自身位置算的，所以沙箱里的产物落在临时目录，
 * 不会污染仓库里的 fixtures/，也不会和别的测试抢同一批样本文件。
 */

const temps = [];
process.on('exit', () => {
  for (const dir of temps) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言结果 */ }
  }
});

/**
 * 造一个沙箱：只有 scripts/ 三个文件，fixtures 落在沙箱里。
 * stubGdal=true 时只桩掉最外层的 GDAL 调用——脚本与检查项本身都是真的。
 */
function sandbox({ stubGdal = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-fixture-'));
  temps.push(dir);
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(root, 'scripts', 'make-fixture.mjs'), join(dir, 'scripts', 'make-fixture.mjs'));
  copyFileSync(join(root, 'scripts', 'lib', 'checks.mjs'), join(dir, 'scripts', 'lib', 'checks.mjs'));
  if (stubGdal) {
    writeFileSync(
      join(dir, 'scripts', 'lib', 'env.mjs'),
      [
        '// 假 GDAL：只桩掉最外层的 GDAL 调用',
        'export function resolveGdalBin() { return "/fake/gdal/bin"; }',
        'export function runTool() { return "stub: this is not real gdal output"; }',
        '',
      ].join('\n'),
    );
  } else {
    copyFileSync(join(root, 'scripts', 'lib', 'env.mjs'), join(dir, 'scripts', 'lib', 'env.mjs'));
  }
  return dir;
}

function runFixture(dir) {
  return spawnSync(process.execPath, [join(dir, 'scripts', 'make-fixture.mjs')], {
    encoding: 'utf8',
    env: { ...process.env },
  });
}

// ── 清单本身的判定逻辑 ───────────────────────────────────────

/**
 * 清单会往 stdout 打印 ●/■。单元测试故意造一个失败项，
 * 若让它打出来，CI 日志里就会混进 ■ 标记——
 * 扫日志的人（和以后想"顺手改绿"的人）容易误判成真失败，这里静音。
 */
function silently(fn) {
  const orig = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = orig;
  }
}

test('checklist：全部通过时 finish() 返回 true，且不动退出码', () => {
  const before = process.exitCode;
  silently(() => {
    const list = createChecklist({ title: '单测' });
    list.add('a', true, 'ok');
    list.add('b', true, 'ok');
    assert.equal(list.total, 2);
    assert.equal(list.failed.length, 0);
    assert.equal(list.finish(), true);
  });
  assert.equal(process.exitCode, before, '全部通过时不该改退出码');
});

test('checklist：有失败项时 finish() 返回 false，并把退出码置为 1', () => {
  const before = process.exitCode;
  silently(() => {
    const list = createChecklist({ title: '单测' });
    list.add('good', true, 'ok');
    list.add('bad', false, '坏了');
    assert.equal(list.failed.length, 1);
    assert.equal(list.failed[0].name, 'bad');
    assert.equal(list.finish(), false);
  });
  assert.equal(process.exitCode, 1, '失败项必须变成非零退出码');
  process.exitCode = before; // 复位，别把失败带出测试进程
});

// ── 端到端：真的把脚本跑起来 ─────────────────────────────────

test('make-fixture：真实 GDAL 下检查项全过，退出码为 0', () => {
  const res = runFixture(sandbox());
  const out = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 0, `本机应有 GDAL 且全部检查通过，实际退出码 ${res.status}\n${out}`);
  assert.ok(!out.includes(FAIL), `不该有失败标记\n${out}`);
  assert.match(out, /项全部通过/, '应有通过汇总');
  assert.match(out, /GDAL \d+\.\d+/, '应打印本次用的 GDAL 版本号——门禁断言的是 GDAL 的已知行为，版本号必须可见');
});

test('make-fixture：检查项不通过时必须以非零码退出（真门禁）', () => {
  const res = runFixture(sandbox({ stubGdal: true }));
  const out = `${res.stdout}\n${res.stderr}`;
  assert.notEqual(res.status, 0, `检查项失败必须非零退出，实际 ${res.status}\n${out}`);
  assert.ok(out.includes(FAIL), `输出里应有失败标记\n${out}`);
  assert.match(out, /项未通过/, '输出里应有失败汇总');
  assert.match(out, /GDAL 按内容识别 \.tff/, '失败汇总里要点名具体哪一项没过');
});

test('make-fixture：失败时不会碰仓库里的 fixtures/（沙箱隔离）', () => {
  const before = readFileSync(join(root, 'fixtures', 'sample.geojson'), 'utf8');
  runFixture(sandbox({ stubGdal: true }));
  const after = readFileSync(join(root, 'fixtures', 'sample.geojson'), 'utf8');
  assert.equal(after, before, '沙箱里的运行不应改动仓库里的样本');
});

// ── CI 工作流本身不能把这个门禁绕过去 ───────────────────────

test('ci.yml：样本生成那一步不能用 continue-on-error / || true 绕过门禁', () => {
  const yml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const cfg = yml.split(/\r?\n/).map((l) => l.replace(/#.*$/, '')).join('\n');
  assert.ok(!/continue-on-error/.test(cfg), 'continue-on-error 会把门禁变成摆设');
  assert.ok(!/npm run fixture.*\|\|\s*true/.test(cfg), '|| true 会吞掉失败退出码');
  assert.ok(/run: npm run fixture/.test(cfg), '样本生成步骤应当直接跑 npm run fixture');
});

test('ci.yml：GDAL 必须钉住小版本（否则行为变化会以噪声的形式让 CI 变红）', () => {
  const yml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const cfg = yml.split(/\r?\n/).map((l) => l.replace(/#.*$/, '')).join('\n');
  assert.match(
    cfg,
    /gdal=\d+\.\d+/,
    'CI 必须把 GDAL 钉在固定小版本上：门禁断言的是 GDAL 的已知行为，版本漂移必须是有意为之',
  );
});
