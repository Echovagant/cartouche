/**
 * 提示词 ↔ 契约 ↔ 引擎 的**三方对齐**测试。
 *
 * 盯住一件事：AI 照着提示词写的形状，必须能真的跑起来。
 *
 * 背景：提示词原来把 region 和 target / source 一起归进「路径类参数」，
 * 让模型写成 "layer://…" 或 "dataset://…" 引用。
 * 但 region 在引擎里是**像元坐标对象**或**4 元地理范围数组**，
 * 引用形式既过不了闸门①，引擎也不认 ——
 * 于是「AI 一句话改图」永远停在提议阶段，AI 提得最多的几个 op 拿不到执行按钮。
 *
 * 本文件按提示词里的规则**手工构造**一份合法计划，
 * 断言它能过闸门①（契约校验），也能过闸门②（引擎预演），
 * 并端到端跑一遍 POST /api/llm/plan 的核心链路（createPlan + 假 fetch）。
 *
 * 造出来的栅格（16×12 三波段、像元值由公式生成）**全部是构造数据**，
 * 不对应任何真实数据。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { previewOp } = await import(eng('ops/index.ts'));
const { builtinTemplates, TemplateRegistry } = await import(eng('templates/registry.ts'));

/** 假密钥：只在这一条链路上用一次，不落盘、不进仓库 */
const FAKE_KEY = 'sk-test-0123456789abcdefghijklmnop'; // secret-scan:allow
process.env.MINIMAX_API_KEY = FAKE_KEY;

const {
  buildPlanPrompt,
  opCatalog,
  readOpsSchema,
  validatePlanSchema,
  createPlan,
  implementedOps,
} = await import(pathToFileURL(join(root, 'server', 'src', 'llm-plan.ts')).href);

const loc = resolveGdal();
const gdal = tools(loc);
const SCHEMA = readOpsSchema();

/* ── 构造数据 ────────────────────────────────────────────── */

/** 造一张 16×12 的三波段影像（构造数据：像元值由公式生成，与真实数据无关） */
async function makeRaster(dir, name) {
  const w = 16;
  const h = 12;
  const bands = 3;
  const raw = new Uint8Array(w * h * bands);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let b = 0; b < bands; b++) {
        raw[(y * w + x) * bands + b] = (x * 7 + y * 3 + b * 40 + 11) % 200;
      }
    }
  }
  const bin = join(dir, `${name}.bin`);
  const hdr = join(dir, `${name}.hdr`);
  await writeFile(bin, raw);
  await writeFile(
    hdr,
    [
      'ENVI',
      `samples = ${w}`,
      `lines   = ${h}`,
      `bands   = ${bands}`,
      'header offset = 0',
      'file type = ENVI Standard',
      'data type = 1',
      'interleave = bip',
      'byte order = 0',
      '',
    ].join('\n'),
    'utf8',
  );
  const tif = join(dir, `${name}.tff`);
  await gdal.translate([
    '-of', 'GTiff',
    '-a_srs', 'EPSG:4326',
    '-a_ullr', '120.30', '30.532', '120.316', '30.52',
    bin, tif,
  ]);
  return tif;
}

let ctx = null;

async function setup() {
  if (ctx) return ctx;
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-prompt-region-'));
  const store = new LocalFolderStore(dir);
  await makeRaster(dir, 'scan-2023');
  ctx = { dir, store };
  return ctx;
}

after(async () => {
  if (ctx) await rm(ctx.dir, { recursive: true, force: true });
});

/* ── 提示词里的规则 ──────────────────────────────────────── */

const CONTEXT = {
  projectName: '示例图件',
  layers: [
    {
      id: 'scan-2023',
      kind: 'raster',
      path: 'scan-2023.tff',
      visible: true,
      opacity: 1,
      fields: [],
      featureCount: null,
      crs: 'EPSG:4326',
    },
  ],
  features: [],
  viewport: [120.3, 30.52, 120.316, 30.532],
};

function promptText() {
  return buildPlanPrompt({
    context: CONTEXT,
    instruction: '把图幅中部那块红色标注擦掉',
    catalog: opCatalog(SCHEMA, implementedOps()),
  });
}

/**
 * **按提示词规则构造**的一份计划：
 *   - 路径类参数写 "dataset://<相对路径>"；
 *   - region 写 4 元地理范围数组（AI 拿不到像元坐标时的形状）。
 */
function planPerPrompt() {
  return {
    version: '1.0',
    intent: '把图幅中部那块红色标注擦掉',
    ops: [
      {
        op: 'raster.erase',
        params: {
          target: 'dataset://scan-2023.tff',
          region: [120.302, 30.523, 120.306, 30.527],
        },
      },
    ],
  };
}

/** 假 fetch：按剧本回一个 chat/completions 响应 */
function fakeChat(content, status = 200) {
  return async () => ({
    ok: status < 400,
    status,
    text: async () =>
      JSON.stringify({
        model: 'MiniMax-M3.1-Flash',
        choices: status < 400 ? [{ message: { role: 'assistant', content } }] : [],
      }),
  });
}

/* ── 1. 提示词本身 ───────────────────────────────────────── */

test('提示词：路径类规则里不能再有 region（region 不是引用）', () => {
  const prompt = promptText();
  const lines = prompt.split('\n');
  const pathRules = lines.filter((l) => l.includes('路径类参数'));
  assert.equal(pathRules.length, 1, '应当只有一条「路径类参数」规则');
  assert.ok(
    !pathRules[0]?.includes('region'),
    `路径类规则里不该再出现 region：${pathRules[0] ?? ''}`,
  );
});

test('提示词：region 必须单独讲清楚是哪两种形状，并写明不要用引用', () => {
  const prompt = promptText();
  const lines = prompt.split('\n');
  const start = lines.findIndex((l) => l.includes('region（要改动的区域）'));
  assert.ok(start >= 0, '提示词里必须有一条单独讲 region 的规则');
  const block = lines.slice(start, start + 6).join('\n');
  assert.match(block, /像元坐标/, '要讲清楚像元坐标对象这种形状');
  assert.match(block, /地理范围/, '要讲清楚地理范围数组这种形状');
  assert.match(block, /layer:\/\//, '要写明不要写 layer:// 引用');
  assert.match(block, /dataset:\/\//, '要写明不要写 dataset:// 引用');
});

test('提示词：路径类参数只准写 dataset://（引擎不认 layer://）', () => {
  const prompt = promptText();
  const lines = prompt.split('\n');
  const start = lines.findIndex((l) => l.includes('路径类参数'));
  assert.ok(start >= 0, '提示词里必须有「路径类参数」这条规则');
  const block = lines.slice(start, start + 6).join('\n');
  assert.match(block, /dataset:\/\//, '路径类规则必须给出 dataset:// 的写法');
  assert.match(
    prompt,
    /layer:\/\/.*(不是文件路径|引擎会直接拒掉)/,
    '提示词必须说明 layer:// 不是文件路径、引擎会拒',
  );
});

/* ── 2. 按提示词规则构造的计划：闸门① 放行 ───────────────── */

test('闸门①：按提示词规则构造的计划必须被契约放行', () => {
  const issues = validatePlanSchema(planPerPrompt(), SCHEMA);
  assert.deepEqual(
    issues.map((i) => i.message),
    [],
    '按提示词写的计划不该被契约拒下',
  );
});

test('闸门①：旧写法（region 写成引用）必须被契约拒下', () => {
  const old = {
    version: '1.0',
    ops: [
      {
        op: 'raster.erase',
        params: { target: 'dataset://scan-2023.tff', region: 'layer://markup' },
      },
    ],
  };
  const issues = validatePlanSchema(old, SCHEMA);
  assert.ok(issues.length > 0, '引用形式的 region 必须被拒');
  assert.match(issues[0]?.message ?? '', /region/);
});

/* ── 3. 闸门②：同一份计划引擎真的跑得动 ─────────────────── */

test('闸门②：按提示词规则构造的计划，引擎必须跑得动且真的改到像元', async () => {
  const c = await setup();
  const plan = planPerPrompt();
  const rec = await previewOp({ loc, store: c.store }, plan.ops[0]);
  assert.equal(rec.ok, true, rec.error ?? '');
  assert.ok(
    (rec.impact?.affectedPixels ?? 0) > 0,
    '按提示词写的计划必须真的改到像元，不许空跑',
  );
});

/* ── 4. 端到端：POST /api/llm/plan 的核心链路 ────────────── */

test('端到端（假模型）：按提示词规则写的计划，闸门①②都要过（不是停在某一关）', async () => {
  const c = await setup();
  const res = await createPlan({
    prompt: '把图幅中部那块红色标注擦掉',
    model: 'MiniMax-M3.1-Flash',
    context: CONTEXT,
    fetchImpl: fakeChat(JSON.stringify(planPerPrompt())),
    // 闸门②：跟 app.ts 一样交给引擎自己判
    precheck: async (spec) => {
      const record = await previewOp({ loc, store: c.store }, spec);
      return {
        ok: record.ok,
        error: record.error ?? null,
        unimplemented: record.unimplemented === true,
      };
    },
  });

  assert.equal(res.ok, true, `闸门没过：${res.error ?? ''} ${res.message ?? ''}`);
  assert.equal(res.error, null);
  assert.deepEqual(res.schemaIssues, [], '闸门①不该有问题');
  assert.deepEqual(res.unsupported, [], '闸门②不该有未实现的 op');
  assert.equal(res.precheck.length, 1);
  assert.equal(res.precheck[0]?.status, 'pass', `闸门②没过：${res.precheck[0]?.message ?? ''}`);
  assert.equal(res.plan?.ops.length, 1);
});

test('端到端（假模型）：旧写法的计划必须被闸门①明确拒下（不是假装成功）', async () => {
  const c = await setup();
  const res = await createPlan({
    prompt: '把图幅中部那块红色标注擦掉',
    model: 'MiniMax-M3.1-Flash',
    context: CONTEXT,
    fetchImpl: fakeChat(
      JSON.stringify({
        version: '1.0',
        ops: [
          {
            op: 'raster.erase',
            params: { target: 'dataset://scan-2023.tff', region: 'layer://markup' },
          },
        ],
      }),
    ),
    precheck: async (spec) => {
      const record = await previewOp({ loc, store: c.store }, spec);
      return {
        ok: record.ok,
        error: record.error ?? null,
        unimplemented: record.unimplemented === true,
      };
    },
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'plan_schema_invalid');
  assert.ok(res.schemaIssues.length > 0);
  assert.match(res.message ?? '', /不符合操作契约/);
});

/* ── 5. 模板与基准集：region 必须是引擎跑得动的形状 ───────── */

/** 引擎认的两种 region 形状 */
function isRunnableRegion(v) {
  if (Array.isArray(v)) {
    return v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
  }
  if (typeof v === 'object' && v !== null) {
    return ['minX', 'minY', 'maxX', 'maxY'].every(
      (k) => typeof v[k] === 'number' && Number.isFinite(v[k]),
    );
  }
  return false;
}

test('模板：region 的参数类型不再是 layerRef，示例值也是引擎跑得动的形状', () => {
  for (const t of builtinTemplates) {
    const spec = t.params.find((p) => p.name === 'region');
    if (!spec) continue;
    assert.equal(spec.type, 'region', `${t.id} 的 region 参数类型应当是 region`);
    const example = t.example['region'];
    if (example === undefined) continue; // 可选参数，示例里不给也合法
    assert.ok(
      isRunnableRegion(example),
      `${t.id} 的 region 示例不是引擎跑得动的形状：${JSON.stringify(example)}`,
    );
  }
});

test('模板：建出来的计划里 region 不被契约挑出问题', () => {
  const registry = new TemplateRegistry(builtinTemplates);
  for (const t of builtinTemplates) {
    if (!t.params.some((p) => p.name === 'region')) continue;
    const plan = registry.build(t.id, t.example);
    const issues = validatePlanSchema({ version: '1.0', ops: [plan] }, SCHEMA);
    const regionIssues = issues.filter((i) => /region/i.test(i.message));
    assert.deepEqual(
      regionIssues.map((i) => i.message),
      [],
      `${t.id} 的 region 被契约挑出了毛病`,
    );
  }
});

test('基准集：期望计划里的 region 必须是引擎跑得动的两种形状之一', async () => {
  for (const file of ['bench/cases.json', 'bench/cases-pro.json']) {
    const bench = JSON.parse(await readFile(join(root, file), 'utf8'));
    for (const c of bench.cases ?? []) {
      for (const op of c.expected?.ops ?? []) {
        const region = op.params?.['region'];
        if (region === undefined) continue;
        assert.ok(
          isRunnableRegion(region),
          `${file} ${c.id} / ${op.op} 的 region 不是引擎跑得动的形状：${JSON.stringify(region)}`,
        );
      }
    }
  }
});

test('基准集：引擎执行的 op 的路径类参数必须是 dataset:// 引用', async () => {
  for (const file of ['bench/cases.json', 'bench/cases-pro.json']) {
    const bench = JSON.parse(await readFile(join(root, file), 'utf8'));
    for (const c of bench.cases ?? []) {
      for (const op of c.expected?.ops ?? []) {
        if (!op.op.startsWith('raster.')) continue;
        for (const key of ['target', 'source', 'clip']) {
          const value = op.params?.[key];
          if (typeof value !== 'string') continue;
          assert.match(
            value,
            /^dataset:\/\/.+$/,
            `${file} ${c.id} / ${op.op} 的 ${key} 必须是 dataset:// 引用：${value}`,
          );
        }
      }
    }
  }
});
