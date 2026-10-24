#!/usr/bin/env node
/**
 * 把便携包自带的示例数据播种进工作区。
 *
 * 为什么要有这一步：
 *   上一版便携包双击打开是空画布。对不懂技术的人来说，
 *   空画布和"软件坏了"长得一样 —— 第一次体验就废了。
 *   启动时先把一份公开的教学数据放进工作区，新用户立刻能看到东西。
 *
 * 为什么是**复制**而不是软链接 / 直接指过去：
 *   ① 便携包可能被放在 U 盘或临时目录里，指过去的话包一挪位置数据就断了；
 *   ② 用户在工作区里改坏了示例数据，不该反过来污染包里的那份原件。
 *
 * 为什么**不覆盖**已有的同名文件：
 *   用户可能已经改过示例数据（删了某个图层、改了属性表）。
 *   播种只补缺失的文件，绝不覆盖 —— 否则每次启动都在偷偷回滚用户的改动。
 *
 * 幂等：工作区里已经有示例数据时，重复运行不会改动任何已有文件。
 *
 * 用法：
 *   node scripts/seed-portable-samples.mjs
 *   ENGINE_WORKSPACE_ROOT=<目录> node scripts/seed-portable-samples.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 包里的示例数据（打包时由 pack-portable.mjs 放进去） */
const sourceDir = join(pkgRoot, '示例数据');

/**
 * 工作区根：优先听环境变量的（启动器会设成 %LOCALAPPDATA%\cartouche\workspace），
 * 没有就退回同一个位置 —— 脚本单独跑时也要落在同一个地方。
 */
function resolveWorkspace() {
  const fromEnv = process.env.ENGINE_WORKSPACE_ROOT;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  const base = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return join(base, 'cartouche', 'workspace');
}

const workspace = resolveWorkspace();
const targetDir = join(workspace, '示例数据');

if (!existsSync(sourceDir)) {
  console.error(`[seed] 找不到示例数据：${sourceDir}`);
  console.error('[seed] 这个便携包可能没有完整解压，请重新解压一次 zip。');
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });

let copied = 0;
let skipped = 0;
let bytes = 0;

/**
 * 递归复制：只补不存在的文件。
 * @param {string} from 源目录
 * @param {string} to 目标目录
 */
function copyMissing(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dst, { recursive: true });
      copyMissing(src, dst);
      continue;
    }
    if (!entry.isFile()) continue;
    if (existsSync(dst)) {
      skipped++;
      continue;
    }
    copyFileSync(src, dst);
    copied++;
    bytes += statSync(dst).size;
  }
}

copyMissing(sourceDir, targetDir);

console.log(`[seed] 示例数据目录：${targetDir}`);
if (copied > 0) {
  console.log(`[seed] 新增 ${copied} 个文件（${(bytes / 1024 / 1024).toFixed(1)} MB）`);
}
if (skipped > 0) {
  console.log(`[seed] 已有 ${skipped} 个文件保持原样（不覆盖你改过的版本）`);
}
console.log('[seed] 打开说明：README.txt（在示例数据目录里）');
