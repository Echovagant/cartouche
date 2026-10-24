#!/usr/bin/env node
/**
 * 真机验证：拿一把真密钥，跑一遍 AI 这条路线的**生产代码**。
 *
 * 为什么要有这个脚本（2026-10-24）：
 *   mock 端点只能验「链路通不通」—— 上下文裁剪、闸门拦不拦、JSON 抠不抠得出来。
 *   **验不了两件更要紧的事**：
 *     1. 意图质量：模型会不会把「给要素加一列」翻成 `vector.addField` + 正确的参数；
 *     2. 真实厂商的返回形态：万一 content 的形状变了，界面正常、功能正常、日志干净，
 *        只是效果从来没生效过 —— 这种洞用户不会报告，因为他们没有「预期」可对照。
 *
 * 所以这个脚本直接调**生产代码**（引擎的 listModelIds/chatOnce、服务端的 createPlan），
 * 不重写一遍请求逻辑 —— 重写的那份能通过，不代表生产那份能通过。
 *
 * ## 怎么用
 *
 *   # 密钥从环境变量读（**不要**把密钥写进任何文件，也不要贴在命令行里）
 *   # 推荐的注入方式：读本机 DPAPI 密文，注入到当前进程的环境变量
 *   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-engine.ps1   # 另一种（会顺带起引擎）
 *
 *   $env:MINIMAX_API_KEY = <从密文解出来的明文>   # 只在这一条命令的进程里存在
 *   node scripts/verify-llm-live.mjs
 *
 * ## 纪律
 *
 *   - 密钥只从环境变量读，**永不打印、永不落盘、永不进仓库**；
 *   - 报告里只给绝对数字（成功 N 次 / 正文为空 M 次 / 耗时分布），不给「基本正常」；
 *   - 同一提示词要跑 N 次（默认 10）—— 推理型模型的输出长度有波动，
 *     单次成功不能证明稳定；
 *   - 自证闸门：至少跑一次「故意塞一个不存在的 op」，期望被拒 —— 否则这份报告
 *     证明不了「闸门真的在拦」。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const apiKey = (process.env.MINIMAX_API_KEY ?? '').trim();
if (!apiKey) {
  console.error(
    '没有配置密钥：把 MINIMAX_API_KEY 放进当前进程的环境变量再跑。\n' +
      '（密钥不要写进任何文件、不要贴在命令行上——命令行会被记进 shell 历史。）',
  );
  process.exit(2);
}
const baseUrl = (process.env.MINIMAX_BASE_URL ?? '').trim() || undefined;
const model = (process.env.MINIMAX_MODEL ?? '').trim() || undefined;
/** 跑几遍 —— 推理型模型的输出长度有波动，单次不算数 */
const RUNS = Number(process.env.VERIFY_RUNS ?? 10);

const { listModelIds } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'llm', 'minimax-api.ts')).href
);
// MINIMAX_MODELS 在 key-provider.ts（不在 minimax-api.ts）——别凭记忆写路径
const { MINIMAX_MODELS, MINIMAX_CN_BASE_URL } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'key-provider.ts')).href
);
const { createPlan } = await import(
  pathToFileURL(join(root, 'server', 'src', 'llm-plan.ts')).href
);
const { listImplementedOps } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'ops', 'index.ts')).href
);

/** 故意做的坏计划：用一个根本不存在的 op，期望被闸门②挡下来 */
const BROKEN_OP = 'vector.thisOpDoesNotExist';

const PROMPTS = [
  { text: '给要素加一列叫「面积」的字段', want: 'vector.addField' },
  { text: '按类型汇总面积和人口', want: 'feature.summarize' },
  { text: '把图层重投影到 EPSG:32650', want: 'vector.reproject' },
  { text: '把 NAME 字段改名叫「名称」', want: 'vector.renameFields' },
  // 歧义输入：模型**不该猜**。提示词教它的做法是 ops 写空数组、在 intent 里说明缺什么，
  // 这一条单独统计成「澄清率」，不能混进意图命中率 —— 混进去会把
  // 「模型不乱猜」记成「模型没听懂」，两回事。
  { text: '把这一列改名叫「更新编号」', want: 'clarify' },
];

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;

console.log(`\n${'='.repeat(64)}`);
console.log('真机验证 · AI 一句话改图');
console.log(`端点：${baseUrl ?? '（默认）'}　模型：${model ?? '（默认）'}　每条提示跑 ${RUNS} 遍`);
console.log('='.repeat(64));

/* ── 1. 拉模型清单（生产代码） ───────────────────────────────── */
console.log(`\n【1】拉模型清单`);
let pulled = [];
try {
  const res = await listModelIds({ apiKey, baseUrl: baseUrl ?? MINIMAX_CN_BASE_URL });
  // listModelIds 返回的是**模型 id 数组**，不是一个带 models 字段的对象
  pulled = [...res];
  console.log(`  ${ok('✓')} 实时拉到 ${pulled.length} 个：${pulled.join('、')}`);
  const offline = MINIMAX_MODELS;
  const missing = pulled.filter((m) => !offline.includes(m));
  const stale = offline.filter((m) => !pulled.includes(m));
  if (missing.length > 0) {
    console.log(`  ${warn('△')} 线上有、离线兜底清单里没有：${missing.join('、')}`);
  }
  if (stale.length > 0) {
    console.log(`  ${warn('△')} 离线清单里有、线上已没有：${stale.join('、')}`);
  }
  if (missing.length === 0 && stale.length === 0) {
    console.log(`  ${ok('✓')} 离线兜底清单与线上一致`);
  }
} catch (err) {
  console.log(`  ${bad('✗')} 拉清单失败：${(err && err.message ? err.message : String(err))}`);
  console.log(dim('     （清单拉不到不影响下面的意图质量测试，继续）'));
}

/* ── 2. 意图质量（生产代码：服务端的 createPlan） ─────────────── */
const implemented = new Set(listImplementedOps());
console.log(`\n【2】意图质量：每条提示跑 ${RUNS} 遍，用服务端的 createPlan`);

const ctx = {
  projectName: '验证项目',
  layers: [
    {
      id: 'layer-1',
      kind: 'vector',
      path: 'districts.shp',
      visible: true,
      opacity: 1,
      fields: [
        { name: 'NAME', type: 'String' },
        { name: 'TYPE', type: 'String' },
        { name: 'POP', type: 'Integer' },
      ],
      featureCount: 5,
      crs: 'EPSG:32650',
    },
  ],
  features: [],
  viewport: null,
};

const report = [];
for (const p of PROMPTS) {
  let okCount = 0;
  let emptyCount = 0;
  let wantCount = 0;
  let unknownOp = 0;
  let rejected = 0;
  let clarifyCount = 0;
  const ops = new Set();
  const times = [];
  let firstError = null;

  for (let i = 0; i < RUNS; i++) {
    const started = Date.now();
    try {
      const res = await createPlan({
        prompt: p.text,
        ...(model ? { model } : {}),
        context: ctx,
      });
      times.push(Date.now() - started);
      if (!res.ok) {
        // 闸门拒了：这也算"有结论"，但要记下原因
        if (res.error === 'op_not_supported') rejected += 1;
        else if (res.error === 'plan_needs_clarification') clarifyCount += 1;
        else if (res.error === 'plan_not_json' || res.error === 'plan_schema_invalid') emptyCount += 1;
        if (!firstError) firstError = `${res.error ?? '?'}: ${res.message ?? ''}`;
        continue;
      }
      const planned = (res.plan?.ops ?? []).map((o) => o.op);
      for (const o of planned) {
        ops.add(o);
        if (!implemented.has(o)) unknownOp += 1;
      }
      if (planned.includes(p.want)) wantCount += 1;
      okCount += 1;
    } catch (err) {
      times.push(Date.now() - started);
      emptyCount += 1;
      if (!firstError) firstError = (err && err.message ? err.message : String(err));
    }
  }

  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  const max = times.length ? Math.max(...times) : 0;
  const min = times.length ? Math.min(...times) : 0;

  const expectLabel =
    p.want === 'clarify'
      ? `　其中模型拒绝乱猜并说清缺什么 ${clarifyCount}/${RUNS}`
      : `　其中命中期望 op「${p.want}」 ${wantCount}/${RUNS}`;
  const line =
    `  ${p.text}\n` +
    `    提议成功 ${okCount}/${RUNS}${expectLabel}` +
    `　未实现 op ${unknownOp}　被闸门拒 ${rejected}　解析失败/空 ${emptyCount}\n` +
    `    出现的 op：${ops.size ? [...ops].join('、') : '（无）'}\n` +
    `    耗时 ${min}~${max} ms（均 ${avg}）` +
    (firstError ? dim(`\n    首个错误：${firstError}`) : '');
  console.log(line);

  report.push({
    prompt: p.text,
    want: p.want,
    runs: RUNS,
    ok: okCount,
    wantHits: wantCount,
    unknownOp,
    rejected,
    clarify: clarifyCount,
    empty: emptyCount,
    ops: [...ops],
    minMs: min,
    avgMs: avg,
    maxMs: max,
    firstError,
  });
}

/* ── 3. 自证闸门：故意塞一个不存在的 op，期望被拒 ─────────────── */
console.log(`\n【3】自证闸门：故意提议一个不存在的 op「${BROKEN_OP}」`);
try {
  const res = await createPlan({
    prompt: '随便改点什么',
    ...(model ? { model } : {}),
    context: ctx,
    // 直接注入坏计划：模型不配合也得验闸门
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          model: model ?? 'mock',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  version: '1.0',
                  intent: '故意错的',
                  ops: [{ op: BROKEN_OP, params: { target: 'dataset://districts.shp' } }],
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
    }),
  });
  const rejectedOk = res.ok === false;
  // 挡它下来的可能是闸门①（契约：op 名不在枚举里）或闸门②（引擎还没实现）——
  // 哪个都算"闸门在拦"，但要说清是哪一道，别笼统报"挡住了"。
  const which =
    res.error === 'op_not_supported'
      ? '闸门②（引擎尚未实现）'
      : res.error === 'plan_schema_invalid'
        ? '闸门①（操作契约）'
        : res.error ?? '（原因未知）';
  console.log(
    rejectedOk
      ? `  ${ok('✓')} 闸门把它挡下来了 —— ${which}（error=${res.error}）`
      : `  ${bad('✗')} 闸门没挡住！这份报告证明不了「闸门真的在拦」`,
  );
  if (!rejectedOk) {
    console.log(`     实际返回：ok=${res.ok} error=${res.error} message=${res.message}`);
  }
} catch (err) {
  console.log(`  ${bad('✗')} 自证闸门这一步自己报错了：${(err && err.message ? err.message : String(err))}`);
}

/* ── 4. 结论 ────────────────────────────────────────────────── */
console.log(`\n【4】结论（绝对数字）`);
let totalRuns = 0;
let totalOk = 0;
let totalWant = 0;
let totalEmpty = 0;
let clarifyRuns = 0;
let clarifyHits = 0;
for (const r of report) {
  totalRuns += r.runs;
  totalOk += r.ok;
  totalEmpty += r.empty;
  if (r.want === 'clarify') {
    clarifyRuns += r.runs;
    clarifyHits += r.clarify;
  } else {
    totalWant += r.wantHits;
  }
}
const intentRuns = totalRuns - clarifyRuns;
console.log(`  总提议 ${totalRuns} 次，成功 ${totalOk} 次，命中期望 op ${totalWant} 次，解析失败/空正文 ${totalEmpty} 次`);
console.log(
  `  意图命中率（说清要哪个 op，模型就给了哪个）：${intentRuns > 0 ? ((totalWant / intentRuns) * 100).toFixed(1) : '0'}%（分母 ${intentRuns} 次明确意图的提议）`,
);
console.log(
  `  歧义澄清率（信息不足时模型拒绝乱猜并说清缺什么）：${clarifyRuns > 0 ? ((clarifyHits / clarifyRuns) * 100).toFixed(1) : '0'}%（分母 ${clarifyRuns} 次）`,
);
console.log(`  空正文率：${totalRuns > 0 ? ((totalEmpty / totalRuns) * 100).toFixed(1) : '0'}%`);
console.log(`\n  注：空正文率必须是 0 才算稳；单次成功不算数（所以上面每条跑了 ${RUNS} 遍）。`);
console.log(`  密钥自始至终没有出现在这份输出里。\n`);

/* 机器可读的结果，便于 CI 或后续脚本读 */
const out = {
  when: new Date().toISOString(),
  baseUrl: baseUrl ?? '(default)',
  model: model ?? '(default)',
  runsPerPrompt: RUNS,
  modelsPulled: pulled,
  prompts: report,
  totals: { totalRuns, totalOk, totalWant, totalEmpty },
};
const outPath = join(root, 'release', 'llm-live-verify.json');
try {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`  结果已写：${outPath}`);
} catch (err) {
  console.log(dim(`  （结果写盘失败：${(err && err.message ? err.message : String(err))}）`));
}
