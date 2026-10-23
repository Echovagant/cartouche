/**
 * 闸门①全量自检：基准集与模板产出的计划，都必须能过操作契约。
 *
 * 盯的是「AI / 模板产出的计划，闸门①放不放行」：
 *   - bench/cases.json 与 bench/cases-pro.json 里每一条 expected.ops
 *   - 每个内置模板用示例参数 build() 出来的计划
 * 都必须过 validatePlanSchema（闸门①用的就是服务端这一份，不另写一套——
 * 两套校验器各说各话，测出来的「绿」是假的）。
 *
 * 这条测试盯的是一个反复出现的病：
 * 契约里留着一个引擎根本不读的参数，模板/基准集又照着写，
 * 于是计划在闸门①就被拒（「不认识的字段 xxx」），AI 提得出来的操作永远执行不了。
 *
 * 本文件不构造任何栅格，也不碰真实数据：只读 JSON、只跑纯校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;
// 闸门①用的就是服务端这一份校验器，不另写一套
const { readOpsSchema, validatePlanSchema } = await import(
  pathToFileURL(join(root, 'server', 'src', 'llm-plan.ts')).href
);
const { TemplateRegistry, builtinTemplates } = await import(eng('templates/registry.ts'));

const SCHEMA = readOpsSchema();
const BENCH_FILES = ['cases.json', 'cases-pro.json'];

function loadCases(name) {
  const data = JSON.parse(readFileSync(join(root, 'bench', name), 'utf8'));
  return data.cases ?? [];
}

/** gap 用例没有期望计划（它考的是「缺什么能力」），不参与闸门①自检 */
function planOf(c) {
  const ops = c.expected?.ops ?? [];
  return ops.length > 0 ? { version: '1.0', ops } : null;
}

function issuesOf(plan) {
  return validatePlanSchema(plan, SCHEMA).map((i) => i.message);
}

test('闸门①：基准集里每一条期望计划都能过契约', () => {
  let total = 0;
  const bad = [];
  for (const name of BENCH_FILES) {
    for (const c of loadCases(name)) {
      const plan = planOf(c);
      if (!plan) continue;
      total += 1;
      const issues = issuesOf(plan);
      if (issues.length > 0) bad.push({ file: name, id: c.id, issues });
    }
  }
  console.log(`  闸门①自检：${total - bad.length} / ${total} 条期望计划通过契约`);
  for (const b of bad) {
    console.log(`    ${b.file} ${b.id}：${b.issues.join('；')}`);
  }
  assert.deepEqual(
    bad.map((b) => `${b.file}:${b.id}`),
    [],
    `有 ${bad.length} 条期望计划过不了闸门①`,
  );
});

test('闸门①：每个内置模板用示例参数 build 出来的计划都能过契约', () => {
  const registry = new TemplateRegistry(builtinTemplates);
  const bad = [];
  for (const t of builtinTemplates) {
    const plan = registry.build(t.id, t.example);
    const issues = issuesOf({ version: '1.0', ops: [plan] });
    if (issues.length > 0) bad.push({ id: t.id, issues });
  }
  console.log(
    `  模板自检：${builtinTemplates.length - bad.length} / ${builtinTemplates.length} 个模板产出的计划通过契约`,
  );
  for (const b of bad) console.log(`    ${b.id}：${b.issues.join('；')}`);
  assert.deepEqual(
    bad.map((b) => b.id),
    [],
    `有 ${bad.length} 个模板产出的计划过不了闸门①`,
  );
});

test('闸门①：erase-markup 模板产出的计划能过契约（且不再承诺引擎没实现的参数）', () => {
  const registry = new TemplateRegistry(builtinTemplates);
  const plan = registry.build('erase-markup', {
    target: 'dataset://scan.tff',
    region: [120.3, 30.52, 120.31, 30.53],
  });
  console.log(`  erase-markup 产出：${JSON.stringify(plan)}`);
  assert.equal(plan.op, 'raster.erase');
  assert.deepEqual(issuesOf({ version: '1.0', ops: [plan] }), [], '模板产出的计划必须过闸门①');

  // keepAnnotations / fill 引擎都不读：模板不该再产出这两个字段
  assert.throws(
    () =>
      registry.build('erase-markup', {
        target: 'dataset://scan.tff',
        region: [120.3, 30.52, 120.31, 30.53],
        keepAnnotations: false,
      }),
    /未知参数/,
    '模板不该再接受引擎没实现的参数',
  );
});

/**
 * 契约说「clip 与 bbox 至少给一个」，引擎就必须真的守住这一条。
 *
 * 契约里的 anyOf 本地校验器不认（它只实现 required / allOf），所以守这条的
 * 责任落在引擎上：两个都不给时必须**报错**，不能把原图原样复制一遍还报成功。
 */
test('契约与引擎对齐：raster.clip 不给 bbox 也不给 clip 时引擎必须报错', async () => {
  const { resolveGdal } = await import(eng('gdal/env.ts'));
  const { LocalFolderStore } = await import(eng('workspace/index.ts'));
  const { executePlan } = await import(eng('ops/index.ts'));

  const dir = await mkdtemp(join(tmpdir(), 'cartouche-clip-guard-'));
  try {
    const res = await executePlan(
      { loc: resolveGdal(), store: new LocalFolderStore(dir) },
      { op: 'raster.clip', params: { target: 'dataset://missing.tif' } },
    );
    assert.equal(res.ok, false, '两个范围都不给必须失败');
    assert.match(res.results[0]?.error ?? '', /裁切范围|bbox 或 clip/, '报错要说清缺什么');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
