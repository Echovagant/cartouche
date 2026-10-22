import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, relative, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveGdal, gdalEnv } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
const { resolveGdalBin, resolveToolPath } = await import(pathToFileURL(join(root, 'scripts', 'lib', 'env.mjs')).href);

/**
 * 这些用例复刻 2026-10-21 那次 CI 失败的现场条件。
 *
 * 当时的失败链：
 *   ci.yml 里 `PATH: ${{ env.GDAL_BIN }}:${{ env.PATH }}` 把 runner 的 PATH 清空
 *   → npm 找不到 sh → "enoent spawn sh ENOENT"
 *   → 就算 PATH 修好，GDAL 定位仍然是 Windows 专用写法
 *     （PATH 按 ';' 切、只认 gdalinfo.exe、conda 目录写死 Library\bin）
 *   → ubuntu-latest 上仍然找不到 GDAL。
 *
 * Windows 上跑不出 Linux 运行时，所以这里用"Linux 形状的输入"直接测定位逻辑：
 * 分隔符传 ':'、可执行文件不带 .exe、conda 布局用 <prefix>/bin + <prefix>/share。
 * 这些用例在任何平台上都能跑，且改坏了一律会红。
 *
 * 注意：模拟 POSIX 形状时给的路径必须是**不含冒号**的相对路径。
 * 绝对路径在 Windows 上带盘符（'C:'），按 ':' 切会把盘符切掉——
 * 那是测试输入不真实，不是实现的问题（Linux 上根本没有盘符）。
 */

const temps = [];
function tempDir(prefix = 'cartouche-gdal-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of temps) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言结果 */ }
  }
});

/** 造一个假的 Linux GDAL bin 目录：gdalinfo / gdal_translate 都不带 .exe */
function fakeLinuxGdalBin(prefix) {
  const bin = join(prefix, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gdalinfo'), '#!/bin/sh\n');
  writeFileSync(join(bin, 'gdal_translate'), '#!/bin/sh\n');
  return bin;
}

/** 把绝对路径换成不含冒号的相对路径，才能安全地按 ':' 切 */
function asPosixShaped(absPath) {
  const rel = relative(process.cwd(), absPath);
  assert.ok(!rel.includes(':'), `相对路径不应含冒号：${rel}`);
  return rel;
}

test('engine：POSIX 形状的 PATH（: 分隔、无 .exe）能定位到 GDAL', () => {
  const base = tempDir();
  const bin = fakeLinuxGdalBin(base);
  const relBin = asPosixShaped(bin);

  const loc = resolveGdal({ pathValue: `${relBin}:/usr/bin:/bin`, pathSeparator: ':', platform: 'linux' });

  assert.ok(loc, '应能定位到 GDAL');
  assert.equal(loc.binDir, relBin, '必须命中 PATH 里那个目录，而不是回退到本机已安装的 GDAL');
});

test('engine：Windows 形状的 PATH（; 分隔、.exe）依然能定位', () => {
  const base = tempDir();
  const bin = join(base, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gdalinfo.exe'), 'MZ');

  const loc = resolveGdal({ pathValue: `${bin};C:\\Windows\\System32`, pathSeparator: ';', platform: 'win32' });

  assert.ok(loc);
  assert.equal(loc.binDir, bin);
  assert.equal(loc.exeSuffix, '.exe');
});

test('engine：exeSuffix 跟着平台走', () => {
  const base = tempDir();
  const bin = fakeLinuxGdalBin(base);
  const relBin = asPosixShaped(bin);

  const linux = resolveGdal({ pathValue: relBin, pathSeparator: ':', platform: 'linux' });
  const win = resolveGdal({ pathValue: relBin, pathSeparator: ':', platform: 'win32' });

  assert.equal(linux.exeSuffix, '');
  assert.equal(win.exeSuffix, '.exe');
});

test('engine：POSIX 布局的 GDAL_DATA 落在 <prefix>/share/gdal', () => {
  const base = tempDir();
  const bin = fakeLinuxGdalBin(base);
  const relBin = asPosixShaped(bin);
  const shareGdal = join(dirname(relBin), 'share', 'gdal');
  mkdirSync(shareGdal, { recursive: true });

  const loc = resolveGdal({ pathValue: relBin, pathSeparator: ':', platform: 'linux' });

  assert.equal(loc.gdalData, shareGdal, 'Linux 上 GDAL 数据目录是 <prefix>/share/gdal，不是 <prefix>/Library/share/gdal');
});

test('engine：gdalEnv 用平台分隔符拼 PATH', () => {
  const base = tempDir();
  const bin = fakeLinuxGdalBin(base);
  const relBin = asPosixShaped(bin);

  const loc = resolveGdal({ pathValue: relBin, pathSeparator: ':', platform: 'linux' });
  const env = gdalEnv(loc);

  assert.equal(env.PATH.split(delimiter)[0], relBin, 'GDAL 的 bin 目录要排在 PATH 最前');
  assert.ok(env.PATH.includes(delimiter), `PATH 必须用平台分隔符（${delimiter}）拼接`);
});

test('scripts/lib/env.mjs：POSIX 形状的 PATH 同样能定位（JS 孪生实现）', () => {
  const base = tempDir();
  const bin = fakeLinuxGdalBin(base);
  const relBin = asPosixShaped(bin);

  const found = resolveGdalBin({ pathValue: `${relBin}:/usr/bin`, pathSeparator: ':', platform: 'linux' });

  assert.equal(found, relBin, 'scripts 侧的定位逻辑必须和 engine 侧一致');
});

test('scripts/lib/env.mjs：工具名可以不带 .exe', () => {
  const base = tempDir();
  const bin = join(base, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gdalinfo'), '#!/bin/sh\n');

  assert.equal(resolveToolPath(bin, 'gdalinfo'), join(bin, 'gdalinfo'));
});

test('scripts/lib/env.mjs：工具名带 .exe 也能解析（Windows 写法不回归）', () => {
  const base = tempDir();
  const bin = join(base, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gdalinfo.exe'), 'MZ');

  assert.equal(resolveToolPath(bin, 'gdalinfo.exe'), join(bin, 'gdalinfo.exe'));
  assert.equal(resolveToolPath(bin, 'gdalinfo'), join(bin, 'gdalinfo.exe'), '基础名要能回退到 .exe');
});

test('engine：显式指定的 GDAL_BIN 优先于 PATH', () => {
  const base = tempDir();
  const bin = fakeLinuxGdalBin(base);
  const relBin = asPosixShaped(bin);

  const loc = resolveGdal({
    gdalBin: relBin,
    pathValue: '/usr/bin',
    pathSeparator: ':',
    platform: 'linux',
  });

  assert.equal(loc.binDir, relBin, '显式指定必须赢过 PATH 里的其它目录');
});

test('scripts/lib/env.mjs：显式指定的 GDAL_BIN 同样优先', () => {
  const base = tempDir();
  const bin = fakeLinuxGdalBin(base);
  const relBin = asPosixShaped(bin);

  const found = resolveGdalBin({
    gdalBin: relBin,
    pathValue: '/usr/bin',
    pathSeparator: ':',
    platform: 'linux',
  });

  assert.equal(found, relBin);
});

// ── CI 工作流本身的门禁 ───────────────────────────────────────

/** 只看有效配置行，忽略注释（注释里会提到被禁用的写法本身） */
function ciConfigLines() {
  const yml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  return yml
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, ''))
    .join('\n');
}

test('ci.yml：不再用 ${{ env.PATH }} 覆盖 PATH（那会把 PATH 清空）', () => {
  const cfg = ciConfigLines();

  assert.ok(
    !cfg.includes('${{ env.PATH }}'),
    'env 上下文里没有 runner 默认 PATH，${{ env.PATH }} 会展开成空串并清空 PATH',
  );
  assert.ok(!/^\s*PATH:\s*\$\{\{/m.test(cfg), '不允许再出现 PATH: ${{ ... }} 这种覆盖写法');
});

test('ci.yml：用 $GITHUB_PATH 追加 GDAL 的 bin 目录', () => {
  assert.ok(ciConfigLines().includes('$GITHUB_PATH'), '必须用 $GITHUB_PATH 改 PATH');
});

test('ci.yml：conda 路径用 Linux 布局，且不依赖 $CONDA_PREFIX', () => {
  const cfg = ciConfigLines();

  assert.ok(!cfg.includes('$CONDA_PREFIX'), 'conda create 不会激活环境，$CONDA_PREFIX 是空的');
  assert.ok(!cfg.includes('Library/bin'), 'runner 是 ubuntu-latest，conda 布局是 <prefix>/bin');
  assert.ok(cfg.includes('conda info --base'), '前缀要用 conda info --base 取');
});
