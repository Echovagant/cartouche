#!/usr/bin/env node
/**
 * 校验基准集：
 *   - cases.json      ：30 条基层口语用例（回归防线）
 *   - cases-pro.json  ：ArcGIS Pro 进阶工作流对照用例（covered + gap）
 * 校验点：JSON 可解析、条数、ID 唯一、结构完整、op 是否都在操作 DSL Schema 里声明过。
 * 用法：node scripts/check-bench.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(root, 'src', 'engine', 'ops.schema.json'), 'utf8'));

const OK = '\x1b[32m●\x1b[0m';
const BAD = '\x1b[31m■\x1b[0m';
const WARN = '\x1b[33m▲\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

const declared = new Set(schema.$defs.operation.properties.op.enum);

function checkFile(name, { requireTarget, allowGap }) {
  const path = join(root, 'bench', name);
  console.log(`\n${BOLD}${name}${RESET}\n`);
  if (!existsSync(path)) {
    console.log(`  ${BAD} 文件不存在`);
    return { ok: false, used: new Set(), count: 0 };
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const cases = data.cases ?? [];
  const target = data.target ?? (requireTarget ?? 30);

  console.log(`  ${OK} JSON 可解析`);
  const countOk = cases.length >= target;
  console.log(`  ${countOk ? OK : BAD} 用例数 ${cases.length}（目标 ≥ ${target}）`);

  const ids = cases.map((c) => c.id);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  console.log(`  ${dupIds.length === 0 ? OK : BAD} 用例 ID 唯一${dupIds.length ? '（重复：' + dupIds.join(',') + '）' : ''}`);

  const byCat = {};
  for (const c of cases) byCat[c.category] = (byCat[c.category] ?? 0) + 1;
  for (const [cat, n] of Object.entries(byCat)) {
    console.log(`  ${DIM}·${RESET} ${cat.padEnd(14, ' ')} ${n} 条   ${DIM}${data.categories?.[cat] ?? ''}${RESET}`);
  }

  const used = new Set();
  let bad = 0;
  let covered = 0;
  let gap = 0;
  for (const c of cases) {
    const problems = [];
    if (!c.id || !c.title || !c.utterance) problems.push('缺少 id/title/utterance');
    if (!c.preconditions?.datasets?.length) problems.push('缺少 preconditions.datasets');
    if (!c.traps?.length) problems.push('缺少 traps');
    if (!c.proParity?.level || !c.proParity?.tools?.length) problems.push('缺少 proParity(level/tools)');

    const isGap = c.status === 'gap';
    if (isGap) {
      gap++;
      if (!allowGap) problems.push('本文件不允许 gap 用例');
      if (!c.expected?.gap?.missingCapability) problems.push('gap 用例必须写 expected.gap.missingCapability');
    } else {
      covered++;
      if (!c.expected?.ops?.length) problems.push('缺少 expected.ops');
      if (!c.expected?.assertions?.length) problems.push('缺少 expected.assertions');
    }
    for (const op of c.expected?.ops ?? []) used.add(op.op);

    if (problems.length) {
      bad++;
      console.log(`  ${BAD} ${c.id} ${c.title}：${problems.join('；')}`);
    }
  }
  if (bad === 0) {
    console.log(`  ${OK} ${cases.length} 条结构完整（utterance / preconditions / traps / proParity / ${allowGap ? 'ops 或 gap' : 'ops'} / assertions）`);
    if (allowGap) console.log(`  ${DIM}·${RESET} covered ${covered} 条 / gap ${gap} 条`);
  }

  const missing = [...used].filter((op) => !declared.has(op));
  if (missing.length === 0) {
    console.log(`  ${OK} 用到的 ${used.size} 个 op 均已在 Schema 中声明`);
  } else {
    console.log(`  ${BAD} Schema 缺少 op：${missing.join(', ')}`);
  }

  const ok = missing.length === 0 && bad === 0 && countOk && dupIds.length === 0;
  console.log(`  ${ok ? OK : BAD} 自检${ok ? '通过' : '未通过'}`);
  return { ok, used, count: cases.length };
}

const base = checkFile('cases.json', { requireTarget: 30, allowGap: false });
const pro = checkFile('cases-pro.json', { requireTarget: 18, allowGap: true });

/* ── 覆盖度汇总 ────────────────────────────────────────────── */
const allUsed = new Set([...base.used, ...pro.used]);
const unused = [...declared].filter((op) => !allUsed.has(op));
if (unused.length) {
  console.log(`\n${WARN} Schema 声明但两套基准都没覆盖：${unused.join(', ')}${RESET}`);
} else {
  console.log(`\n${OK} Schema 的 ${declared.size} 个 op 全部被基准覆盖${RESET}`);
}

const ok = base.ok && pro.ok;
console.log(`\n${ok ? OK : BAD} 基准集自检${ok ? '通过' : '未通过'}${RESET}\n`);
process.exit(ok ? 0 : 1);
