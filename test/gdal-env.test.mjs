import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, relative, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveGdal, gdalEnv, GDAL_CACHE_MAX_BYTES } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
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

/**
 * 测试用的临时目录建在**仓库根之下**，不用系统 tmpdir。
 *
 * 为什么不能用系统 tmpdir：这个测试要把路径换成「不含冒号的相对路径」（POSIX 形状），
 * 而 `relative(cwd, dir)` 只有在两者**同盘**时才给得出相对路径 ——
 * 仓库在 D:、系统临时目录在 C: 时，它返回的是带盘符的绝对路径，断言必挂
 * （2026-10-23 实测：D: 上的 worktree 跑这条挂 10 个用例）。
 * 建在仓库根之下，任何盘上都成立。
 */
const TMP_BASE = join(root, '.tmp-test');

const temps = [];
function tempDir(prefix = 'cartouche-gdal-') {
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TMP_BASE, prefix));
  temps.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of temps) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言结果 */ }
  }
  try { rmSync(TMP_BASE, { recursive: true, force: true }); } catch { /* 目录非空就算了 */ }
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

  const loc = resolveGdal({ gdalBin: '', pathValue: `${relBin}:/usr/bin:/bin`, pathSeparator: ':', platform: 'linux' });

  assert.ok(loc, '应能定位到 GDAL');
  assert.equal(loc.binDir, relBin, '必须命中 PATH 里那个目录，而不是回退到本机已安装的 GDAL');
});

test('engine：Windows 形状的 PATH（; 分隔、.exe）依然能定位', () => {
  const base = tempDir();
  const bin = join(base, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gdalinfo.exe'), 'MZ');

  const loc = resolveGdal({ gdalBin: '', pathValue: `${bin};C:\\Windows\\System32`, pathSeparator: ';', platform: 'win32' });

  assert.ok(loc);
  assert.equal(loc.binDir, bin);
  assert.equal(loc.exeSuffix, '.exe');
});

test('engine：exeSuffix 跟着平台走', () => {
  const base = tempDir();
  const bin = fakeLinuxGdalBin(base);
  const relBin = asPosixShaped(bin);

  const linux = resolveGdal({ gdalBin: '', pathValue: relBin, pathSeparator: ':', platform: 'linux' });
  const win = resolveGdal({ gdalBin: '', pathValue: relBin, pathSeparator: ':', platform: 'win32' });

  assert.equal(linux.exeSuffix, '');
  assert.equal(win.exeSuffix, '.exe');
});

test('engine：POSIX 布局的 GDAL_DATA 落在 <prefix>/share/gdal', () => {
  const base = tempDir();
  const bin = fakeLinuxGdalBin(base);
  const relBin = asPosixShaped(bin);
  const shareGdal = join(dirname(relBin), 'share', 'gdal');
  mkdirSync(shareGdal, { recursive: true });

  const loc = resolveGdal({ gdalBin: '', pathValue: relBin, pathSeparator: ':', platform: 'linux' });

  assert.equal(loc.gdalData, shareGdal, 'Linux 上 GDAL 数据目录是 <prefix>/share/gdal，不是 <prefix>/Library/share/gdal');
});

test('engine：gdalEnv 用平台分隔符拼 PATH', () => {
  const base = tempDir();
  const bin = fakeLinuxGdalBin(base);
  const relBin = asPosixShaped(bin);

  const loc = resolveGdal({ gdalBin: '', pathValue: relBin, pathSeparator: ':', platform: 'linux' });
  const env = gdalEnv(loc);

  assert.equal(env.PATH.split(delimiter)[0], relBin, 'GDAL 的 bin 目录要排在 PATH 最前');
  assert.ok(env.PATH.includes(delimiter), `PATH 必须用平台分隔符（${delimiter}）拼接`);
});

test('engine：gdalEnv 钉死 GDAL 的块缓存上限（默认是物理内存的 5%，峰值会跟着机器涨）', () => {
  const base = tempDir();
  const bin = fakeLinuxGdalBin(base);
  const relBin = asPosixShaped(bin);

  const loc = resolveGdal({ gdalBin: '', pathValue: relBin, pathSeparator: ':', platform: 'linux' });
  const env = gdalEnv(loc);

  assert.ok(env.GDAL_CACHEMAX, '必须显式给出块缓存上限');
  assert.equal(
    Number(env.GDAL_CACHEMAX),
    GDAL_CACHE_MAX_BYTES,
    '块缓存上限必须是我们定的那一档，不是 GDAL 的默认（物理内存的 5%）',
  );
  // 写成字节数：GDAL 对小于 100000 的裸数字按 MB 解释，
  // 用一个明确大于该阈值的字节数，两种解释下都是同一个意思。
  assert.ok(Number(env.GDAL_CACHEMAX) > 100000, '要写成字节数，不能是会被当成 MB 的小数字');
});

test('engine：用户自己设了 GDAL_CACHEMAX 就不覆盖', () => {
  const base = tempDir();
  const bin = fakeLinuxGdalBin(base);
  const relBin = asPosixShaped(bin);
  const loc = resolveGdal({ gdalBin: '', pathValue: relBin, pathSeparator: ':', platform: 'linux' });

  const saved = process.env.GDAL_CACHEMAX;
  process.env.GDAL_CACHEMAX = '1048576';
  try {
    const env = gdalEnv(loc);
    assert.equal(env.GDAL_CACHEMAX, '1048576', '用户特意调过的值不该被覆盖');
  } finally {
    if (saved === undefined) delete process.env.GDAL_CACHEMAX;
    else process.env.GDAL_CACHEMAX = saved;
  }
});

test('scripts/lib/env.mjs：POSIX 形状的 PATH 同样能定位（JS 孪生实现）', () => {
  const base = tempDir();
  const bin = fakeLinuxGdalBin(base);
  const relBin = asPosixShaped(bin);

  const found = resolveGdalBin({ gdalBin: '', pathValue: `${relBin}:/usr/bin`, pathSeparator: ':', platform: 'linux' });

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

/**
 * 环境变量 GDAL_BIN 的语义（2026-10-22 CI 踩过）：
 *   不传 gdalBin 这个键 → 读 process.env.GDAL_BIN（CI 里就是这么设的）
 *   传 gdalBin: ''      → 明确表示"别看环境变量"
 *
 * 为什么要有第二种：CI 环境里 GDAL_BIN 指向真实的 conda GDAL，
 * 而这些用例要断言的是"按 PATH/显式路径解析"，不隔离就会被环境变量劫持
 * （2026-10-22 那次 CI 就是这么红的：拿到 /usr/share/miniconda/... 而不是测试目录）。
 */
test('engine：环境变量 GDAL_BIN 会被采用，但显式传 gdalBin:"" 可以屏蔽它', () => {
  const base = tempDir();
  const bin = fakeLinuxGdalBin(base);
  const relBin = asPosixShaped(bin);
  const saved = process.env.GDAL_BIN;
  try {
    process.env.GDAL_BIN = relBin;

    const fromEnv = resolveGdal({ pathValue: '/usr/bin', pathSeparator: ':', platform: 'linux' });
    assert.equal(fromEnv.binDir, relBin, '不传 gdalBin 时应采用环境变量');

    const isolated = resolveGdal({ gdalBin: '', pathValue: '/usr/bin', pathSeparator: ':', platform: 'linux' });
    assert.notEqual(isolated?.binDir, relBin, '显式传空串必须屏蔽环境变量');
  } finally {
    if (saved === undefined) delete process.env.GDAL_BIN;
    else process.env.GDAL_BIN = saved;
  }
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
