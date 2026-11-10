import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 发布包的完整性回归测试。
 *
 * 为什么要有这个测试：
 * 2026-11-08 查出，已发布的 v0.1.0 与 v0.2.0 两个源码包**都缺**
 * `src/engine/workspace/`（连同它的预构建产物 `src/engine/dist/workspace/`），
 * 导致包里预构建好的引擎**根本加载不了** ——
 * `import('.../src/engine/dist/index.js')` 直接报
 * `Cannot find module .../dist/workspace/index.js`。
 *
 * 根因：`scripts/pack-release.mjs` 的跳过规则写成了「路径段相等」，
 * 于是 `src/engine/workspace/` 里的 `workspace` 段被当成
 * 「仓库根那个用户工作区目录」一起跳掉了。
 * **同一个坑在 `.gitignore` 里已经踩过一次并修过**（那里锚定成 `/workspace/`），
 * 打包脚本这边当时漏改了。
 *
 * 为什么这道闸之前没拦住：当时所有门禁（类型检查、单测、许可、密钥、编码）
 * 检查的都是**仓库**，不是**包**。仓库是好的，包是坏的。
 * 所以这里测的是「打包规则本身」，而不是仓库的内容。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packScript = join(root, 'scripts', 'pack-release.mjs');

/** 读打包脚本里声明的跳过规则与包含清单 */
function readPackRules() {
  const src = execFileSync('node', ['-e', `
    const fs = require('fs');
    const s = fs.readFileSync(process.argv[1], 'utf8');
    process.stdout.write(s);
  `, packScript], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return src;
}

/**
 * 只取**代码部分**，把注释剥掉。
 *
 * 为什么必须剥：打包脚本的注释里**故意保留**了旧写法的原文
 * （「曾经写成 rel.split('/').some(...)」）作为事故记录，
 * 不剥注释的话，正则会匹配到注释里的字面量，测试永远红。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')  // 块注释
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // 行注释（避开 URL 里的 //）
}

test('打包规则：跳过目录必须区分「根层」与「任意层级」', () => {
  const code = stripComments(readPackRules());

  // 旧写法：路径段相等就跳 —— 这就是 workspace 被吞的根因
  assert.ok(
    !/rel\.split\(['"]\/['"]\)\.some\(/.test(code),
    '打包脚本里还在用「路径段相等就跳过」的旧写法 —— src/engine/workspace/ 会被吞掉',
  );

  // 新的分流规则必须都在
  assert.ok(code.includes('SKIP_DIR_ROOT_ONLY'), '缺少 SKIP_DIR_ROOT_ONLY（只跳仓库根那一层）');
  assert.ok(code.includes('SKIP_DIR_ANYWHERE'), '缺少 SKIP_DIR_ANYWHERE（任何层级都跳）');
});

test('打包规则：必需文件清单覆盖引擎的工作区适配器', () => {
  const src = readPackRules();

  // 这些文件缺一个，包就是坏的 —— 必须出现在完整性自检清单里
  const required = [
    'src/engine/workspace/index.ts',
    'src/engine/dist/workspace/index.js',
    'web/fonts/geist.woff2',
    'web/fonts/geist-mono.woff2',
    'test/helpers/listen-safe.mjs',
  ];
  for (const f of required) {
    assert.ok(src.includes(f), `完整性自检清单里缺少 ${f} —— 它缺失时包是坏的`);
  }
});

test('打包规则：web/fonts 与整个 test 目录必须进 INCLUDE 清单', () => {
  const code = stripComments(readPackRules());
  const includeBlock = code.slice(code.indexOf('const INCLUDE'), code.indexOf('const PREBUILT'));

  assert.ok(includeBlock.includes('web/fonts'), "INCLUDE 里缺少 'web/fonts' —— 字体是自托管的，不收就 build 不了");
  // 收的是**整个** test 目录，不只是 helpers：
  // 源码包给的是「要自己改代码、走流水线」的人，拿到的得是一份能跑测试的完整源码。
  // 只收 helpers 的话，对方 npm test 会一条用例都跑不到 —— 而那看起来是「测试都过了」。
  assert.ok(
    /'test'/.test(includeBlock),
    "INCLUDE 里缺少 'test' —— 源码包要带完整测试，只收 helpers 的话用户 npm test 一条都跑不到",
  );
});

test('打包规则：不再出现把 workspace 当成「任意层级都跳」的写法', () => {
  const code = stripComments(readPackRules());
  // SKIP_DIR_ANYWHERE 里绝不能出现 workspace
  const anywhereBlock = code.slice(
    code.indexOf('const SKIP_DIR_ANYWHERE'),
    code.indexOf('const SKIP_FILE'),
  );
  assert.ok(
    !/SKIP_DIR_ANYWHERE\s*=\s*new Set\(\[([^\]]*)\]/.exec(anywhereBlock)?.[1].includes('workspace'),
    'SKIP_DIR_ANYWHERE 里不能有 workspace —— 引擎的 workspace/ 适配器是核心代码',
  );
});

test('打包产物：实际出包后引擎必须能加载', async (t) => {
  // 这一条要真跑打包器，慢；用 t.skip 让 CI 之外的快速测试不受影响
  if (process.env.CARTOUCHE_PACK_E2E !== '1') {
    t.skip('设 CARTOUCHE_PACK_E2E=1 才跑真出包验证（要几十秒）');
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), 'cartouche-pack-'));
  try {
    // 在临时目录里出包，避免覆盖 release/ 里的正式产物
    const out = execFileSync('node', [packScript], {
      encoding: 'utf8',
      cwd: root,
      env: { ...process.env },
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.ok(/完整性核对通过/.test(out), `打包器没有通过完整性自检：\n${out}`);

    const zip = join(root, 'release', 'cartouche-0.2.0.zip');
    assert.ok(existsSync(zip), '没有产出 zip');

    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${tmp}' -Force`,
    ], { stdio: 'pipe', timeout: 300000 });

    const engineEntry = join(tmp, 'src', 'engine', 'dist', 'index.js');
    assert.ok(existsSync(engineEntry), '包里没有引擎入口');

    // 真的 import 一次 —— 这是「包能不能用」的最终判据
    const r = execFileSync('node', ['-e', `
      import('${engineEntry.replace(/\\/g, '/')}').then(m => {
        process.stdout.write('exports=' + Object.keys(m).length);
      }).catch(e => { console.error(e.message); process.exit(1); });
    `], { encoding: 'utf8', stdio: 'pipe' });

    assert.match(r, /exports=\d+/, `引擎加载失败：${r}`);
    const n = Number(r.match(/exports=(\d+)/)[1]);
    assert.ok(n > 50, `引擎导出的东西太少（${n} 个），说明加载的是残缺的包`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
