#!/usr/bin/env node
/**
 * 依赖许可门禁。
 *
 * 目标：保证本仓库（Apache-2.0）及其分发出去的产物**不引入**会传染或限制商用的许可。
 *
 * 分级：
 *  - 强 copyleft（GPL / AGPL / SSPL / OSL / EUPL）→ 直接失败，不可用 allowlist 绕过
 *  - 弱 copyleft（LGPL / MPL / EPL）           → 需在 ALLOWLIST 登记并写明义务
 *  - 未知 / 未声明                             → 失败（无法证明可商用就不许进）
 *  - 数据类许可（CC-BY-4.0 等）                → 需登记（属于数据不是代码）
 *  - **双许可 `(MIT OR Apache-2.0)`**            → 任选其一即可，但必须能识别这种写法
 *  - **自定义宽松许可**（如 GSAP 的 "No Charge"）→ 需在 ALLOWLIST 登记并摘录官网关键条款
 *  - 其余宽松许可                             → 通过
 *
 * 注意：GDAL 是**系统级预编译二进制**，不是 npm 依赖，不在本门禁范围内；
 * 它的分发义务由部署文档单独承担（见 docs/deploy）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 显式登记的例外：必须写明义务。
 * 一旦引入新的弱 copyleft、数据类许可或自定义宽松许可，必须在这里登记并说明如何履行义务。
 * match 支持尾部 * 前缀匹配。
 */
const ALLOWLIST = [
  {
    match: 'gsap',
    note:
      "GSAP Standard \"No Charge\" License（Webflow，2025-04-30 生效，许可字段不是 SPDX）。" +
      '官网原文允许商用：' +
      '"Can I really use GSAP in commercial projects without paying anything? ' +
      'Yes, really! Commercial usage is covered under the standard license."' +
      '且明确允许 AI 生成代码：' +
      '"Is it acceptable for AI tools like ChatGPT, Cursor... to generate GSAP code? Absolutely!"' +
      '禁止的只有「无代码可视化动画构建器」这类与 Webflow 正面竞争的产品（Prohibited Uses），' +
      '本项目是地图修改工作台、动画只用于界面表现，不属于该范围。义务：保留版权声明、不得移除商标标识。',
  },
  {
    match: '@gsap/react',
    note:
      'GSAP Standard "No Charge" License（Webflow）— 与 gsap 同一份许可，' +
      '许可字段写作 "SEE LICENSE AT https://gsap.com/standard-license"，同样允许商用。',
  },
  {
    match: 'caniuse-lite',
    note: 'CC-BY-4.0 — 纯浏览器支持数据文件，非代码；分发时保留其 LICENSE 与出处署名',
  },
  {
    match: 'lightningcss*',
    note:
      'MPL-2.0 — Tailwind v4 的 CSS 转换引擎（@tailwindcss/node 的依赖，原生 napi 二进制）。' +
      'MPL 是**文件级** copyleft：只对我们自己修改过的 MPL 文件负责，本项目不改它的源码。' +
      '它是**构建期**工具，编译产物里只有编译后的 CSS，不随 npm 包或 web/out 分发。',
  },
  {
    match: '@img/sharp-*',
    note:
      'LGPL-3.0（libvips 动态链接预编译包）— Next.js 的可选图片优化依赖。' +
      '本项目不启用 next/image（images.unoptimized=true），这些包不随产物分发；' +
      '若将来启用图片优化，须改为自行构建并履行 libvips 的 LGPL 义务。',
  },
  {
    match: 'sharp',
    note: 'Apache-2.0 — Next.js 可选依赖，不随本项目产物分发',
  },
];

/** 允许的宽松许可（按前缀匹配） */
const ALLOWED = [
  'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Apache-2.0', '0BSD',
  'Python-2.0', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'MIT-0',
];

/** 弱 copyleft：可商用，但有义务 */
const WEAK_COPYLEFT = ['LGPL', 'MPL', 'EPL', 'CDDL'];

/** 强 copyleft：闭源商用分发不可用 */
const STRONG_COPYLEFT = ['AGPL', 'GPL', 'SSPL', 'OSL', 'EUPL', 'CC-BY-SA', 'CC-BY-NC'];

const OK = '\x1b[32m●\x1b[0m';
const BAD = '\x1b[31m■\x1b[0m';
const WARN = '\x1b[33m▲\x1b[0m';
const DIM = '\x1b[90m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const lockPath = join(root, 'package-lock.json');
if (!existsSync(lockPath)) {
  console.error(`${BAD} 未找到 package-lock.json，无法执行许可门禁`);
  process.exit(1);
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const entries = lock.packages ?? {};

/** 工作区内的自有包：从各自的 package.json 读许可 */
function localLicense(pkgPath) {
  const manifest = join(root, pkgPath, 'package.json');
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).license ?? null;
  } catch {
    return null;
  }
}

/** 工作区链接项在 lock 里是 "node_modules/@cartouche/web" → "web" */
function isLocalTarget(pkgPath, meta) {
  if (!pkgPath.includes('node_modules/')) return pkgPath;
  // 链接项的 resolved 指向真实工作区目录
  if (meta && typeof meta.resolved === 'string' && !meta.resolved.includes('node_modules')) {
    return meta.resolved;
  }
  const m = pkgPath.match(/^node_modules\/@[^/]+\/[^/]+$/);
  return m ? m[0].replace('node_modules/@', '') : pkgPath;
}

/** 匹配 allowlist（支持尾部 *） */
function matchAllowlist(name) {
  for (const entry of ALLOWLIST) {
    if (entry.match.endsWith('*')) {
      if (name.startsWith(entry.match.slice(0, -1))) return entry;
    } else if (name === entry.match || name.endsWith('/' + entry.match)) {
      return entry;
    }
  }
  return null;
}

/**
 * 解析 SPDX 的"任选其一"许可表达式。
 *
 * 形如 `(MIT OR Apache-2.0)`、`(MIT OR Apache-2.0 OR ISC)`。
 * 返回各分支；不是这种写法就返回 null。
 */
function permissiveAlternatives(license) {
  const m = /^\(([^()]+)\)$/.exec(license.trim());
  if (!m) return null;
  const parts = m[1]
    .split(/\s+OR\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts : null;
}

const violations = [];
const allowlisted = [];
let checked = 0;

for (const [pkgPath, meta] of Object.entries(entries)) {
  if (!pkgPath) continue; // 根包

  const name = pkgPath.split('node_modules/').pop();
  // 工作区链接项（lock 里 "link": true）也是我们自己的包
  const isLocal = !pkgPath.includes('node_modules/') || meta.link === true;

  let license = typeof meta.license === 'string' ? meta.license : null;
  if (!license && Array.isArray(meta.licenses)) {
    const first = meta.licenses.find((l) => l && typeof l.type === 'string');
    if (first) license = first.type;
  }
  if (!license && isLocal) license = localLicense(isLocalTarget(pkgPath, meta));

  if (!license) {
    violations.push({ name, license: 'UNKNOWN', reason: '依赖未声明许可' });
    continue;
  }

  checked++;
  const upper = license.toUpperCase();

  // 顺序很重要：先判弱 copyleft（LGPL/MPL/EPL），
  // 否则 'LGPL-3.0' 会被 'GPL' 子串误判成强 copyleft。
  if (WEAK_COPYLEFT.some((k) => upper.includes(k))) {
    const allow = matchAllowlist(name);
    if (allow) {
      allowlisted.push({ name, license, note: allow.note });
    } else {
      violations.push({ name, license, reason: '弱 copyleft，需在 ALLOWLIST 中登记并履行义务' });
    }
    continue;
  }

  if (STRONG_COPYLEFT.some((k) => upper.includes(k))) {
    violations.push({ name, license, reason: '强 copyleft，不可用于闭源商用分发' });
    continue;
  }

  // SPDX 的**双许可**写法：`(MIT OR Apache-2.0)` —— 语义是"你可选其中一个"。
  // 必须单独处理：许可串带括号，startsWith 判断一律不匹配，会被误判成"未知许可"。
  // （真实踩坑：@maplibre/mlt 的 license 字段就是 `(MIT OR Apache-2.0)`。）
  const alternatives = permissiveAlternatives(license);
  if (alternatives) {
    const anyStrong = alternatives.some((alt) =>
      STRONG_COPYLEFT.some((k) => alt.toUpperCase().includes(k)),
    );
    if (anyStrong) {
      violations.push({ name, license, reason: '双许可的分支里含强 copyleft，没法只选宽松的那个' });
      continue;
    }
    const anyAllowed = alternatives.some((alt) =>
      ALLOWED.some((a) => alt.toUpperCase().startsWith(a.toUpperCase())),
    );
    if (anyAllowed) {
      allowlisted.push({
        name,
        license,
        note: `双许可，任选其一（${alternatives.join(' / ')}）即可闭源商用`,
      });
      continue;
    }
    violations.push({ name, license, reason: '双许可的所有分支都不在允许清单中' });
    continue;
  }

  const allow = matchAllowlist(name);
  if (allow) {
    allowlisted.push({ name, license, note: allow.note });
    continue;
  }

  if (!ALLOWED.some((a) => upper.startsWith(a.toUpperCase()))) {
    violations.push({ name, license, reason: '未在允许清单中的许可，需人工确认' });
  }
}

console.log(`\n${BOLD}依赖许可门禁${RESET}\n`);
console.log(`  ${OK} 已检查 ${checked} 个依赖`);

if (allowlisted.length > 0) {
  console.log(`  ${WARN} ${allowlisted.length} 个已登记例外：`);
  for (const a of allowlisted) {
    console.log(`    ${DIM}· ${a.name}（${a.license}）— ${a.note}${RESET}`);
  }
}

if (violations.length === 0) {
  console.log(`  ${OK} 全部依赖均为可闭源商用的宽松许可\n`);
  process.exit(0);
}

console.log(`  ${BAD} 发现 ${violations.length} 个需要处理的依赖：\n`);
for (const v of violations) {
  console.log(`    ${BAD} ${v.name.padEnd(32, ' ')} ${DIM}${v.license} — ${v.reason}${RESET}`);
}
console.log(`\n  ${DIM}提示：弱 copyleft 需在 ALLOWLIST 中登记并说明义务；强 copyleft 不允许绕过。${RESET}\n`);
process.exit(1);
