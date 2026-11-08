#!/usr/bin/env node
/**
 * 依赖漏洞门禁。
 *
 * 为什么要有这个（而不是直接跑 `npm audit`）：
 *  1. `npm audit` 只报「有漏洞」，且只分「生产依赖 / 开发依赖」两档。
 *     本仓库的真实边界更细，分三档：
 *       - **运行时**：用户机器上真正执行的代码会加载的包。
 *         实测（release/portable/cartouche-portable-0.2.0.zip）：**一个 node_modules 都没进包**；
 *         server/ 只依赖工作区内的 @cartouche/engine，src/engine/ 只有 devDependencies。
 *         ⇒ 运行时 npm 依赖面为**空**。
 *       - **构建期**：打包者机器上跑一次、不随产物分发的包。
 *         web/ 是 Next.js 纯静态导出（output:'export'），next / react / maplibre / gsap /
 *         postcss / tailwind 都只在这一档。
 *       - **开发期**：devDependencies（typescript、@types/*）。
 *  2. 漏洞库来自 npm 官方 advisory 接口（底层是 GitHub Advisory Database）。
 *     **默认 registry 是国内镜像，而镜像站不实现 `/-/npm/v1/security/advisories/bulk`**
 *     （实测：404 NOT_IMPLEMENTED），照默认 registry 跑只会得到一个假绿。
 *     所以这里默认走官方源，可用 CARTOUCHE_AUDIT_REGISTRY 覆盖。
 *
 * 用法：
 *   node scripts/check-vulns.mjs                     # 默认：运行时 + 构建期
 *   node scripts/check-vulns.mjs --scope runtime      # 只看用户机器上真跑的
 *   node scripts/check-vulns.mjs --scope all          # 含开发期依赖
 *   node scripts/check-vulns.mjs --severity high      # 阈值改成 high（默认 critical）
 *   node scripts/check-vulns.mjs --json               # 机器可读输出
 *   node scripts/check-vulns.mjs --allow-network-failure
 *                                                    # 拉不到漏洞库时**不**让构建失败
 *
 * 退出码：
 *   0 = 通过（在 --allow-network-failure 下也包含"拉不到库"）
 *   1 = 超过阈值的漏洞存在
 *   2 = 环境问题（lockfile 读不到 / 漏洞库不可达）—— 与「有漏洞」严格区分
 *
 * 不修改 package-lock.json，不跑 npm install。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = join(root, 'package-lock.json');

/* ── 参数 ─────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const SCOPE = val('--scope', 'build'); // runtime | build | all
const AS_JSON = has('--json');
const ALLOW_NET_FAIL = has('--allow-network-failure');
const THRESHOLD = val('--severity', 'critical');
const REGISTRY = (process.env.CARTOUCHE_AUDIT_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '');

const ORDER = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
const THRESHOLD_RANK = ORDER[THRESHOLD] ?? 0;

const SCOPE_LABEL = {
  runtime: '运行时（用户机器上真跑的）',
  build: '运行时 + 构建期',
  all: '全部（含开发期依赖）',
}[SCOPE] ?? SCOPE;

/* ── 工具 ─────────────────────────────────────────────────────────── */

function fail(code, message) {
  console.error(`[check-vulns] ${message}`);
  process.exit(code);
}

/* ── 读 lockfile ──────────────────────────────────────────────────── */

if (!existsSync(LOCK)) fail(2, `找不到 ${LOCK}：依赖门禁需要已提交的 package-lock.json`);
let lock;
try {
  lock = JSON.parse(readFileSync(LOCK, 'utf8'));
} catch (err) {
  fail(2, `package-lock.json 解析失败：${err.message}`);
}
if (!lock.packages || typeof lock.packages !== 'object') {
  fail(2, 'package-lock.json 不是 lockfileVersion 2/3 的结构（缺 packages）');
}

/** 工作区根：路径里不含 node_modules */
function workspaceRoots() {
  return Object.keys(lock.packages).filter((p) => p !== '' && !p.includes('node_modules'));
}

/**
 * npm 式解析：在 `fromPath` 所在包里解析依赖 `name`。
 * 候选顺序由深到浅：包自身的 node_modules → 各级祖先的 node_modules → 仓库根的 node_modules。
 * 工作区根（如 `web`）的依赖通常被提升到仓库根，所以必须带上根这一级。
 */
function resolveDep(fromPath, name) {
  const prefixes = [];
  if (fromPath === '') {
    prefixes.push('');
  } else if (!fromPath.includes('node_modules')) {
    prefixes.push(fromPath, ''); // 工作区：先自身，再提升到仓库根
  } else {
    let cur = '';
    for (const part of fromPath.split('/node_modules/')) {
      cur = cur === '' ? part : `${cur}/node_modules/${part}`;
      prefixes.push(cur);
    }
    prefixes.push('');
  }
  for (const p of prefixes) {
    const candidate = p === '' ? `node_modules/${name}` : `${p}/node_modules/${name}`;
    if (candidate in lock.packages) return candidate;
  }
  return null;
}

/** 从给定工作区根出发，收集其 dependencies / optionalDependencies 的可达闭包 */
function closureFrom(wsPaths) {
  const seen = new Set();
  const queue = [];
  for (const wsPath of wsPaths) {
    const meta = lock.packages[wsPath];
    for (const kind of ['dependencies', 'optionalDependencies']) {
      for (const name of Object.keys(meta?.[kind] ?? {})) {
        const r = resolveDep(wsPath, name);
        if (r) queue.push(r);
      }
    }
  }
  while (queue.length) {
    const cur = queue.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const meta = lock.packages[cur];
    if (!meta) continue;
    for (const kind of ['dependencies', 'optionalDependencies']) {
      for (const name of Object.keys(meta[kind] ?? {})) {
        const r = resolveDep(cur, name);
        if (r && !seen.has(r)) queue.push(r);
      }
    }
  }
  return seen;
}

/**
 * 分档：
 *  - runtime：server/ 与 src/engine/ 的依赖闭包（用户机器上真跑）
 *  - build  ：web/ 的依赖闭包（静态导出，只在打包者机器上跑一次）
 *  - dev    ：其余（devDependencies）
 */
const RUNTIME_WORKSPACES = workspaceRoots().filter((p) => p !== 'web');
const BUILD_WORKSPACES = workspaceRoots().filter((p) => p === 'web');
const runtimeSet = closureFrom(RUNTIME_WORKSPACES);
const buildSet = closureFrom(BUILD_WORKSPACES);
for (const p of runtimeSet) buildSet.delete(p);

function tierOf(path) {
  if (runtimeSet.has(path)) return 'runtime';
  if (buildSet.has(path)) return 'build';
  return 'dev';
}

/* ── 查漏洞库 ─────────────────────────────────────────────────────── */

function buildAdvisoryPayload() {
  const payload = {};
  for (const [path, meta] of Object.entries(lock.packages)) {
    if (!path.includes('node_modules/')) continue;
    if (meta.link) continue;
    if (!meta.version) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    (payload[name] ??= []).push(meta.version);
  }
  return payload;
}

const payload = buildAdvisoryPayload();

let body;
try {
  const res = await fetch(`${REGISTRY}/-/npm/v1/security/advisories/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    fail(
      2,
      `漏洞库返回 HTTP ${res.status} ${res.statusText}。` +
        '注意：国内镜像站不实现 advisory 接口，请设 CARTOUCHE_AUDIT_REGISTRY=https://registry.npmjs.org。' +
        (ALLOW_NET_FAIL ? '（已按 --allow-network-failure 放行）' : ''),
    );
  }
  body = await res.json();
} catch (err) {
  fail(
    2,
    `拉不到漏洞库（${REGISTRY}）：${err.message}` +
      (ALLOW_NET_FAIL ? '（已按 --allow-network-failure 放行）' : '。如需放行请加 --allow-network-failure。'),
  );
}

/* ── 汇总 ─────────────────────────────────────────────────────────── */

const findings = [];
for (const [name, advisories] of Object.entries(body ?? {})) {
  for (const adv of advisories) {
    const installed = [];
    for (const [path, meta] of Object.entries(lock.packages)) {
      if (!path.includes('node_modules/')) continue;
      if (meta.link || !meta.version) continue;
      const pkgName = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (pkgName === name) installed.push({ path, version: meta.version, tier: tierOf(path) });
    }
    findings.push({
      name,
      severity: adv.severity ?? 'info',
      title: adv.title ?? '(无标题)',
      url: adv.url ?? '',
      cve: adv.cve ?? '',
      ghsa: adv.ghsa ?? '',
      vulnerable_versions: adv.vulnerable_versions ?? '',
      installed,
      tiers: [...new Set(installed.map((i) => i.tier))],
    });
  }
}

findings.sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9) || a.name.localeCompare(b.name));

const counts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
const tierCounts = { runtime: { ...counts }, build: { ...counts }, dev: { ...counts } };
for (const f of findings) {
  counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  for (const t of f.tiers) tierCounts[t][f.severity] = (tierCounts[t][f.severity] ?? 0) + 1;
}

const inScope = findings.filter(
  (f) =>
    (ORDER[f.severity] ?? 9) <= THRESHOLD_RANK &&
    f.tiers.some((t) => (SCOPE === 'all' ? true : SCOPE === 'runtime' ? t === 'runtime' : t !== 'dev')),
);

const fmt = (c) => `critical ${c.critical} / high ${c.high} / moderate ${c.moderate} / low ${c.low} / info ${c.info}`;

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        registry: REGISTRY,
        scope: SCOPE,
        threshold: THRESHOLD,
        counts,
        tierCounts,
        findings: findings.map((f) => ({
          package: f.name,
          severity: f.severity,
          title: f.title,
          cve: f.cve,
          ghsa: f.ghsa,
          vulnerable_versions: f.vulnerable_versions,
          url: f.url,
          tiers: f.tiers,
          installed: f.installed.map((i) => ({ version: i.version, path: i.path, tier: i.tier })),
        })),
      },
      null,
      2,
    ),
  );
} else {
  console.log(`[check-vulns] 漏洞库：${REGISTRY}`);
  console.log(`[check-vulns] 范围：${SCOPE_LABEL}；阈值：${THRESHOLD} 及以上`);
  console.log(
    `[check-vulns] lockfile ${Object.keys(lock.packages).length} 个条目 —— ` +
      `运行时 ${runtimeSet.size} / 构建期 ${buildSet.size} / 其余（开发期）`,
  );
  console.log(`[check-vulns] 全部：${fmt(counts)}`);
  console.log(`[check-vulns] 运行时：${fmt(tierCounts.runtime)}`);
  console.log(`[check-vulns] 构建期：${fmt(tierCounts.build)}`);
  console.log(`[check-vulns] 开发期：${fmt(tierCounts.dev)}`);
  if (findings.length === 0) {
    console.log('[check-vulns] 未发现已知漏洞。');
  } else {
    console.log('');
    for (const f of findings) {
      const ids = [f.cve, f.ghsa].filter(Boolean).join(' / ');
      console.log(`  [${f.severity}] ${f.name}@${f.installed.map((i) => i.version).join(', ')}  ${ids}  ${f.title}`);
      console.log(`      受影响范围：${f.vulnerable_versions}`);
      console.log(`      路径：${f.tiers.join('+')}   ${f.url}`);
    }
  }
}

if (inScope.length > 0) {
  console.error(`\n[check-vulns] 不通过：${inScope.length} 个 ${THRESHOLD} 及以上漏洞落在「${SCOPE_LABEL}」范围内。`);
  process.exit(1);
}

console.log(`\n[check-vulns] 通过（「${SCOPE_LABEL}」无 ${THRESHOLD} 及以上漏洞）。`);
process.exit(0);
