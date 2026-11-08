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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

/**
 * 受限商用许可：允许商用，但**不是**「免费可商用」的宽松许可。
 *
 * - BUSL / BSL（Business Source License）：带「不可用于生产」条款，
 *   商用需付费购买豁免 → 不满足「免费可商用」。
 * - Elastic License 2.0：实质是 SSPL 的变体 → 不满足。
 * - Commons Clause：给宽松许可加了「禁止卖服务」的限制 → 不满足。
 * - CC-BY-NC / CC-BY-ND：禁止商用或禁止改编 → 不满足。
 *
 * 这些**不能**靠"前缀命中 MIT 就放过"蒙混过关，所以单独成表。
 */
const RESTRICTED_COMMERCIAL = [
  'BUSL', 'BSL', 'ELASTIC-LICENSE', 'ELASTIC', 'COMMONS-CLAUSE',
  'CC-BY-NC', 'CC-BY-ND', 'CC-BY-NC-SA', 'PROPRIETARY', 'UNLICENSED',
];

/**
 * 判定结果的严重度排序（数字越大越严重）。
 *
 * 用于复合表达式里挑出"最该报告的那一条原因"：
 * 一个包里若同时出现弱 copyleft 与受限商用条款，要报受限商用那条 ——
 * 前者可登记放行，后者不满足"免费可商用"，不能靠登记绕过。
 */
const KIND_SEVERITY = {
  ok: 0,
  weak: 1,
  unknown: 2,
  restricted: 3,
  strong: 4,
};

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
 * 把一个许可表达式拆成 AND 连接的全部分支。
 *
 * 为什么需要这一步：`"MIT AND BUSL-1.1"` 这种写法里，前半段是 MIT，
 * 但 `startsWith('MIT')` 会让它整串被判成宽松许可 —— 受限条款被吃掉。
 * SPDX 的 AND 语义是"同时适用"，所以必须逐个分支判。
 */
function conjunctionBranches(license) {
  const trimmed = license.trim();
  // 去掉外层括号后按 AND 拆
  const inner = /^\((.*)\)$/.exec(trimmed)?.[1] ?? trimmed;
  return inner
    .split(/\s+AND\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 判断一个许可分支本身是否属于「受限商用」类。
 * 命中即不可用于免费闭源商用。
 */
function restrictedReason(license) {
  const upper = license.toUpperCase();
  for (const key of RESTRICTED_COMMERCIAL) {
    if (upper.includes(key)) return key;
  }
  return null;
}

/**
 * 判定一个许可表达式（含 AND / OR 组合）是否满足「免费可商用」。
 *
 * SPDX 的语义：
 *   - `A OR B`  → 可以**任选其一**，只要有一支满足条件即可。
 *   - `A AND B` → **同时适用**，每一支都得满足条件。
 *
 * 返回 {ok, kind, reason, note}：
 *   kind='ok'        → 宽松许可，可闭源商用
 *   kind='weak'      → 弱 copyleft（LGPL/MPL/EPL/CDDL）：可商用，但有义务
 *   kind='unknown'   → 自定义 / 数据类许可（如 GSAP、CC-BY）：需登记后人工确认
 *   kind='strong'    → 强 copyleft：不可用于闭源商用分发
 *   kind='restricted'→ 受限商用（BUSL/Elastic/Commons Clause 等）：不满足「免费可商用」
 *
 * 为什么要整个重写而不是"前缀命中就放过"：
 *   `"MIT AND BUSL-1.1"` 前缀是 MIT，整串会被误判成宽松，
 *   而 BUSL 的商用限制就此被吃掉 —— 这正是本门禁的真实漏检点。
 */
function evaluateExpression(expression) {
  const trimmed = expression.trim();

  // OR 优先拆：`(MIT OR Apache-2.0)`、`(MIT OR BUSL-1.1)`
  const orParts = trimmed
    .replace(/^\((.*)\)$/, '$1')
    .split(/\s+OR\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (orParts.length >= 2) {
    const results = orParts.map((p) => evaluateExpression(p));
    // 任一支满足即满足（可以选它）
    const winner = results.find((r) => r.ok);
    if (winner) {
      return { ok: true, kind: 'ok', note: `双许可，任选其一（${orParts.join(' / ')}）` };
    }
    // 没有一支满足：取最严重的那个原因
    const worst = results.reduce((a, b) => (KIND_SEVERITY[b.kind] > KIND_SEVERITY[a.kind] ? b : a));
    return {
      ok: false,
      kind: worst.kind,
      reason: `双许可的所有分支都不满足：${results.map((r) => r.reason).join('；')}`,
    };
  }

  // AND 拆：每一支都必须满足
  const andParts = conjunctionBranches(trimmed);
  if (andParts.length >= 2) {
    const results = andParts.map((p) => evaluateExpression(p));
    const bad = results.filter((r) => !r.ok);
    if (bad.length > 0) {
      const worst = bad.reduce((a, b) => (KIND_SEVERITY[b.kind] > KIND_SEVERITY[a.kind] ? b : a));
      return {
        ok: false,
        kind: worst.kind,
        reason: `复合许可串含不满足的分支（${bad.map((r) => r.reason).join('；')}）`,
      };
    }
    return { ok: true, kind: 'ok', note: `复合许可串，各分支均为宽松许可（${andParts.join(' AND ')}）` };
  }

  // 单个许可标识
  const upper = trimmed.toUpperCase();

  const restricted = restrictedReason(trimmed);
  if (restricted) {
    return {
      ok: false,
      kind: 'restricted',
      reason: `受限商用许可（${restricted}），不满足"免费可商用"`,
    };
  }
  // 弱 copyleft 优先于强 copyleft 判定：'LGPL-3.0' 里含 'GPL' 子串，
  // 直接按强 copyleft 判会误伤（弱 copyleft 可商用，只是有义务）。
  if (WEAK_COPYLEFT.some((k) => upper.includes(k))) {
    return { ok: false, kind: 'weak', reason: '弱 copyleft，需在 ALLOWLIST 中登记并履行义务' };
  }
  if (STRONG_COPYLEFT.some((k) => upper.includes(k))) {
    return { ok: false, kind: 'strong', reason: '强 copyleft，不可用于闭源商用分发' };
  }
  if (ALLOWED.some((a) => upper.startsWith(a.toUpperCase()))) {
    return { ok: true, kind: 'ok' };
  }
  return { ok: false, kind: 'unknown', reason: '未在允许清单中的许可，需人工确认' };
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

  // 统一按 SPDX 表达式求值：AND 的每一支都要满足，OR 只要有一支满足。
  // 不能只看整串前缀 —— "MIT AND BUSL-1.1" 前缀是 MIT，
  // 但 BUSL 的商用限制会被整串放过（这是本门禁的真实漏检点）。
  const verdict = evaluateExpression(license);

  if (verdict.ok) {
    // 宽松许可。包名命中 ALLOWLIST 的（GSAP 自定义许可等）走登记路径，
    // 把义务说明一并写清楚。
    const allow = matchAllowlist(name);
    if (allow) {
      allowlisted.push({ name, license, note: allow.note });
    } else if (verdict.note) {
      allowlisted.push({ name, license, note: verdict.note });
    }
    continue;
  }

  // 不满足宽松：按原因分流。
  //  - weak / unknown：可登记放行（弱 copyleft 有义务、自定义许可需人工确认）
  //  - strong / restricted：**不可**用 ALLOWLIST 绕过
  if (verdict.kind === 'strong' || verdict.kind === 'restricted') {
    violations.push({ name, license, reason: verdict.reason });
    continue;
  }

  const allow = matchAllowlist(name);
  if (allow) {
    allowlisted.push({ name, license, note: allow.note });
    continue;
  }

  violations.push({ name, license, reason: verdict.reason });
}

/* ───────────────── 非 npm 的第三方资产（字体） ───────────────── */

/**
 * 字体资产登记：路径 → 许可。
 *
 * 为什么门禁要管字体：npm 依赖那一套只覆盖 `node_modules`，
 * 而 `web/fonts/` 下的 woff2 是**直接提交进公开仓库的二进制**，
 * 随仓库与产物一起分发，不受任何 npm 门禁保护。
 *
 * 踩过的坑（2026-10-22）：Satoshi（Fontshare）的许可明确禁止再分发，
 * 把字体二进制提交进公开仓库正落在禁止条款上，当时靠人工发现才移除。
 * 所以字体必须有"登记 + 上游许可原文"这道闸。
 */
const FONT_ASSETS = [
  {
    path: 'web/fonts/geist.woff2',
    license: 'SIL-OFL-1.1',
    name: 'Geist',
    upstream: 'https://github.com/vercel/geist-font/blob/main/LICENSE.txt',
    note: 'SIL OFL 1.1 允许随软件捆绑再分发；须保留版权声明与许可文本',
  },
  {
    path: 'web/fonts/geist-mono.woff2',
    license: 'SIL-OFL-1.1',
    name: 'Geist Mono',
    upstream: 'https://github.com/vercel/geist-font/blob/main/LICENSE.txt',
    note: 'SIL OFL 1.1 允许随软件捆绑再分发；须保留版权声明与许可文本',
  },
];

/** 字体许可允许值：OFL 家族都是免费可商用的（允许捆绑再分发）。 */
const FONT_ALLOWED = ['SIL-OFL-1.1', 'OFL-1.1', 'SIL OFL 1.1'];

const fontViolations = [];
const fontChecked = [];

for (const asset of FONT_ASSETS) {
  const full = join(root, asset.path);
  if (!existsSync(full)) {
    fontViolations.push({ path: asset.path, reason: '登记的字体文件不存在（路径改了？登记没跟上？）' });
    continue;
  }
  fontChecked.push(asset);
  if (!FONT_ALLOWED.includes(asset.license)) {
    fontViolations.push({ path: asset.path, reason: `字体许可 ${asset.license} 不在允许清单中` });
  }
}

/**
 * 扫描 web/fonts/ 下**未登记**的字体文件。
 *
 * 为什么：登记表只写"已知是好的"，新塞进来的字体文件不会自动进表。
 * 这道检查保证"表外的字体文件 = 违规"，而不是"表内的才检查"。
 */
const fontsDir = join(root, 'web', 'fonts');
if (existsSync(fontsDir)) {
  const registered = new Set(FONT_ASSETS.map((a) => a.path.replace(/\\/g, '/')));
  for (const name of readdirSync(fontsDir)) {
    if (!/\.(woff2?|ttf|otf|eot)$/i.test(name)) continue;
    const rel = `web/fonts/${name}`;
    if (!registered.has(rel)) {
      fontViolations.push({
        path: rel,
        reason: '字体文件未在门禁登记表中登记（须核实上游许可是否允许再分发后再登记）',
      });
    }
  }
}

/* ───────────────── lock 元数据 vs 磁盘实物 ───────────────── */

/**
 * 核对已安装包的 `package.json` 与 lock 里的许可字段是否一致。
 *
 * 为什么：lock 是 npm 写下的**缓存**，真正被分发的是磁盘上那份文件。
 * 两者不一致时，以实物为准 —— 否则门禁可能在给一个不存在的许可背书。
 */
const driftViolations = [];
for (const [pkgPath, meta] of Object.entries(entries)) {
  if (!pkgPath.includes('node_modules/')) continue;
  const manifestPath = join(root, pkgPath, 'package.json');
  if (!existsSync(manifestPath)) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    continue;
  }
  const diskLicense =
    typeof manifest.license === 'string'
      ? manifest.license
      : Array.isArray(manifest.licenses)
        ? manifest.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean).join(' AND ') || null
        : null;
  const lockLicense = typeof meta.license === 'string' ? meta.license : null;
  // 工作区链接项在 lock 里没有 license 字段，属正常，不算漂移。
  if (meta.link === true) continue;
  if ((diskLicense ?? null) !== (lockLicense ?? null)) {
    driftViolations.push({
      name: pkgPath.split('node_modules/').pop(),
      lockLicense: lockLicense ?? '(无)',
      diskLicense: diskLicense ?? '(无)',
    });
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

console.log(`  ${OK} 已检查 ${fontChecked.length} 个字体资产（非 npm 第三方）`);
if (driftViolations.length === 0) {
  console.log(`  ${OK} lock 许可字段与磁盘实物一致`);
}

const totalProblems = violations.length + fontViolations.length + driftViolations.length;

if (totalProblems === 0) {
  console.log(`  ${OK} 全部依赖与资产均为可闭源商用的宽松许可\n`);
  process.exit(0);
}

if (violations.length > 0) {
  console.log(`  ${BAD} 发现 ${violations.length} 个需要处理的依赖：\n`);
  for (const v of violations) {
    console.log(`    ${BAD} ${v.name.padEnd(32, ' ')} ${DIM}${v.license} — ${v.reason}${RESET}`);
  }
}

if (fontViolations.length > 0) {
  console.log(`\n  ${BAD} 发现 ${fontViolations.length} 个需要处理的字体资产：\n`);
  for (const f of fontViolations) {
    console.log(`    ${BAD} ${f.path.padEnd(32, ' ')} ${DIM}${f.reason}${RESET}`);
  }
}

if (driftViolations.length > 0) {
  console.log(`\n  ${BAD} 发现 ${driftViolations.length} 个许可漂移（lock 与磁盘实物不一致）：\n`);
  for (const d of driftViolations) {
    console.log(
      `    ${BAD} ${d.name.padEnd(32, ' ')} ${DIM}lock=${d.lockLicense} / 实物=${d.diskLicense}${RESET}`,
    );
  }
}

console.log(
  `\n  ${DIM}提示：弱 copyleft 需在 ALLOWLIST 中登记并说明义务；强 copyleft 不允许绕过；` +
    `受限商用许可（BUSL / Elastic / Commons Clause）不满足"免费可商用"。${RESET}\n`,
);
process.exit(1);
