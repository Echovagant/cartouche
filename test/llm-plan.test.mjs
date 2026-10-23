/**
 * AI 提议层的单元测试。
 *
 * 盯住三件最容易"悄悄出错"的事：
 *   1. **上下文裁剪**：上游多带一个字段，就得**不**出现在发给模型的内容里；
 *   2. **闸门① Schema 校验**：不合法的计划要指明是**哪一条**不合法；
 *   3. **未实现的 op**：要说"该操作尚未支持"，不能静默通过、不能假装成功。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  buildPlanContext,
  buildPlanPrompt,
  opCatalog,
  readOpsSchema,
  validatePlanSchema,
  findUnsupportedOps,
  implementedOps,
  parsePlanReply,
  classifyPrecheck,
  createPlan,
  buildContextPreview,
} = await import(
  pathToFileURL(join(root, 'server', 'src', 'llm-plan.ts')).href
);

/** 假密钥：只在这一条链路上用一次，不落盘、不进仓库 */
const FAKE_KEY = 'sk-test-0123456789abcdefghijklmnop'; // secret-scan:allow
process.env.MINIMAX_API_KEY = FAKE_KEY;

/**
 * 假 fetch：按剧本回一个 chat/completions 响应。
 *
 * 把模型这一端也变成可测的 —— 提议层真正的逻辑（裁剪、闸门、错误分类）
 * 都在这一侧，不该靠"真调一次模型"来验。
 */
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

/** 官方报错形态（OpenAI 兼容）：{"error":{"message":"...","code":1004}} */
function fakeError(status, body) {
  return async () => ({
    ok: false,
    status,
    text: async () => JSON.stringify(body),
  });
}

/** 引擎当前已实现的 op（固定输入：不跟着引擎的实现进度漂移） */
const RASTER_OPS = [
  'raster.adjustLevels',
  'raster.clip',
  'raster.erase',
  'raster.inpaint',
  'raster.mosaic',
  'raster.paint',
  'raster.replaceRegion',
  'raster.resample',
];

/** 一份"什么都带了"的原始上下文 */
const RAW_CONTEXT = {
  projectName: '演示项目',
  // ↓ 多余的顶层字段：一个都不该进上下文
  absolutePath: 'C:\\Users\\someone\\secrets\\demo',
  machine: { hostname: 'WORKSTATION-01', user: 'someone' },
  apiKey: 'sk-not-a-real-key-just-a-placeholder',
  layers: [
    {
      id: 'basemap',
      kind: 'raster',
      path: '底图/current.tff',
      visible: true,
      opacity: 0.8,
      fields: [{ name: 'Value', type: 'Real', secretColumn: 'x' }],
      featureCount: 12,
      crs: 'EPSG:4326',
      // ↓ 多余的图层字段
      absolutePath: 'C:\\Users\\someone\\secrets\\demo\\current.tff',
      checksum: 'deadbeef',
      sourceUrl: 'http://internal.example/data',
    },
  ],
  features: [
    {
      layerId: 'basemap',
      geometry: { type: 'Point', coordinates: [120.3, 30.5] },
      properties: { name: '甲', code: 12, token: '不该发', nested: { a: 1 } },
      // ↓ 多余的要素字段
      rawGeometry: { type: 'Point', coordinates: [120.3000001, 30.5000001] },
    },
  ],
  viewport: [120.3, 30.5, 120.4, 30.6],
  // ↓ 多余的顶层字段
  apiKeyEcho: 'sk-not-a-real-key-just-a-placeholder',
};

test('上下文裁剪：只保留白名单字段，多余的一个都不许留下', () => {
  const ctx = buildPlanContext(RAW_CONTEXT);

  assert.deepEqual(
    Object.keys(ctx).sort(),
    ['features', 'layers', 'projectName', 'viewport'],
    '顶层只应有 projectName / layers / features / viewport',
  );
  assert.deepEqual(
    Object.keys(ctx.layers[0] ?? {}).sort(),
    ['crs', 'featureCount', 'fields', 'id', 'kind', 'opacity', 'path', 'visible'],
    '图层只应有白名单里的字段',
  );
  assert.deepEqual(
    Object.keys(ctx.layers[0]?.fields?.[0] ?? {}).sort(),
    ['name', 'type'],
    '字段只应保留名字与类型',
  );
  assert.deepEqual(
    Object.keys(ctx.features[0] ?? {}).sort(),
    ['geometry', 'layerId', 'properties'],
    '要素只应保留图层归属、几何与属性',
  );

  const dumped = JSON.stringify(ctx);
  assert.ok(!dumped.includes('WORKSTATION-01'), '机器名不该进上下文');
  assert.ok(!dumped.includes('someone'), '用户名不该进上下文');
  assert.ok(!dumped.includes('C:\\\\Users'), '绝对路径不该进上下文');
  assert.ok(!dumped.includes('deadbeef'), '校验和不该进上下文');
  assert.ok(!dumped.includes('internal.example'), '内部地址不该进上下文');
  assert.ok(!dumped.includes('sk-not-a-real-key'), '密钥不该进上下文');
  assert.ok(!dumped.includes('secretColumn'), '多余字段名不该进上下文');
  assert.ok(!dumped.includes('rawGeometry'), '原始几何不该进上下文');
});

test('上下文裁剪：属性里只留原始类型的值，嵌套结构丢掉', () => {
  const ctx = buildPlanContext(RAW_CONTEXT);
  const props = ctx.features[0]?.properties ?? {};
  assert.deepEqual(
    Object.keys(props).sort(),
    ['code', 'name', 'token'],
    'token 是字符串（在白名单内），nested 是对象（不在白名单内）',
  );
  assert.ok(!('nested' in props), '嵌套对象不该留在属性里');
});

test('上下文裁剪：路径不安全的图层直接不进上下文', () => {
  const ctx = buildPlanContext({
    layers: [
      { id: 'abs', kind: 'raster', path: 'C:\\data\\a.tff' },
      { id: 'up', kind: 'raster', path: '../outside/a.tff' },
      { id: 'ok', kind: 'raster', path: 'a.tff' },
    ],
  });
  assert.deepEqual(
    ctx.layers.map((l) => l.id),
    ['ok'],
    '绝对路径与越界路径都不该进上下文',
  );
});

test('提示词：发出去的内容里没有白名单之外的字段', () => {
  const ctx = buildPlanContext(RAW_CONTEXT);
  const catalog = opCatalog(readOpsSchema(), RASTER_OPS);
  const prompt = buildPlanPrompt({
    context: ctx,
    instruction: '把底图提亮一点',
    catalog,
  });
  assert.ok(prompt.includes('底图/current.tff'), '该发的图层路径要在');
  assert.ok(prompt.includes('把底图提亮一点'), '用户原话要在');
  assert.ok(!prompt.includes('WORKSTATION-01'), '机器名不能在提示词里');
  assert.ok(!prompt.includes('sk-not-a-real-key'), '密钥不能在提示词里');
  assert.ok(!prompt.includes('deadbeef'), '校验和不能在提示词里');
  // 只放行栅格 op：矢量 op 不该出现在清单里
  assert.ok(!prompt.includes('"feature.delete"'), '未实现的 op 不该进清单');
  assert.ok(prompt.includes('"raster.adjustLevels"'), '已实现的栅格 op 要进清单');
});

test('op 清单：引擎实现了的矢量 op 必须看得见（2026-10-24 补的洞）', () => {
  // 为什么要有这条：清单曾经只放行 raster.*，而 vector.* 的 op 早就实现并登记进
  // 执行器了 —— 模型**根本看不到**它们，于是所有矢量需求都落到「该操作尚未支持」。
  // 这种缺口不报错，只是功能凭空少了一半，比报错更难发现。
  const catalog = opCatalog(readOpsSchema(), [
    'raster.paint',
    'vector.query',
    'vector.addField',
    'vector.spatialJoin',
    'vector.reproject',
    'vector.renameFields',
    'vector.recode',
  ]);
  assert.deepEqual(
    catalog.map((c) => c.op),
    [
      'raster.paint',
      'vector.addField',
      'vector.query',
      'vector.recode',
      'vector.renameFields',
      'vector.reproject',
      'vector.spatialJoin',
    ],
    '已实现的矢量 op 都要进清单',
  );
  const addField = catalog.find((c) => c.op === 'vector.addField');
  assert.equal(addField?.label, '计算字段', '中文名要跟引擎调度器一致');
  assert.ok(addField?.params, '参数契约要一起给模型');
});

test('op 清单：还没实现的 op 不进清单（几何写回那几个还在开发）', () => {
  // 用**生产真源**（引擎注册表）来断言，而不是自己编一份名单：
  // 清单只放行 raster.* 与 vector.* 两个前缀，而注册表里只有真能跑的 op，
  // 两边一交叉就既不会漏（已实现的看得见），也不会多（没实现的看不见）。
  const implemented = implementedOps();
  assert.ok(
    !implemented.includes('feature.delete'),
    'feature.* 还没实现，不该在注册表里',
  );
  const catalog = opCatalog(readOpsSchema(), implemented);
  assert.ok(
    !catalog.some((c) => c.op.startsWith('feature.')),
    'feature.* 不该进清单',
  );
  assert.ok(
    catalog.some((c) => c.op.startsWith('vector.')),
    '已实现的 vector.* 要进清单',
  );
  assert.ok(
    catalog.some((c) => c.op.startsWith('raster.')),
    '已实现的 raster.* 要进清单',
  );
});

test('提示词里看得见矢量 op：模型得能选得到它', () => {
  // 这是"洞"的最后一环：清单里有了，还得真的进了发出去的那段提示词。
  const prompt = buildPlanPrompt({
    context: buildPlanContext(RAW_CONTEXT),
    instruction: '给底图加一列面积',
    catalog: opCatalog(readOpsSchema(), implementedOps()),
  });
  assert.ok(prompt.includes('"vector.addField"'), '已实现的矢量 op 要出现在提示词里');
  assert.ok(prompt.includes('"vector.query"'), '属性查询也要在');
  assert.ok(prompt.includes('"vector.reproject"'), '重投影也要在');
  assert.ok(!prompt.includes('"feature.delete"'), '没实现的 op 不该在');
});

test('闸门①：合法的计划通过校验', () => {
  const schema = readOpsSchema();
  const issues = validatePlanSchema(
    {
      version: '1.0',
      intent: '把底图提亮',
      ops: [
        {
          op: 'raster.adjustLevels',
          params: { target: 'dataset://底图/current.tff', contrast: 1.2 },
        },
      ],
    },
    schema,
  );
  assert.deepEqual(issues, [], '合法计划不该报问题');
});

test('闸门①：不合法的计划要指明是哪一条、缺了什么', () => {
  const schema = readOpsSchema();
  const issues = validatePlanSchema(
    {
      version: '1.0',
      ops: [
        {
          op: 'raster.adjustLevels',
          params: { target: 'dataset://底图/current.tff' },
        },
        { op: 'feature.delete', params: { target: 'dataset://a.shp' } },
      ],
    },
    schema,
  );
  assert.equal(issues.length, 1, '只有第 2 条不合法');
  assert.match(issues[0]?.message ?? '', /第 2 条操作（feature\.delete）/, '要指明是哪一条');
  assert.match(issues[0]?.message ?? '', /where/, '要指明缺了什么');
});

test('闸门①：op 名不在契约里要说清楚', () => {
  const schema = readOpsSchema();
  const issues = validatePlanSchema(
    { version: '1.0', ops: [{ op: 'raster.teleport', params: {} }] },
    schema,
  );
  assert.ok(issues.length > 0, '不认识的 op 不能放过去');
  assert.match(issues[0]?.message ?? '', /raster\.teleport/, '要写出那个 op 名');
});

test('闸门①：多余的字段与错的 version 都要被拒', () => {
  const schema = readOpsSchema();
  const extra = validatePlanSchema(
    {
      version: '1.0',
      ops: [
        {
          op: 'raster.paint',
          params: {
            target: 'dataset://a.tff',
            region: 'dataset://a.tff',
            color: '#ffffff',
            whoops: 1,
          },
        },
      ],
    },
    schema,
  );
  assert.ok(extra.length > 0, '多余的参数不该被静默接受');

  const badVersion = validatePlanSchema(
    {
      version: '0.9',
      ops: [
        {
          op: 'raster.paint',
          params: { target: 'dataset://a.tff', region: 'dataset://a.tff', color: '#ffffff' },
        },
      ],
    },
    schema,
  );
  assert.ok(
    badVersion.some((i) => i.opIndex === null && /version/.test(i.message)),
    'version 不对要单独报出来',
  );
});

test('闸门①：裸路径不符合契约（layerRef 要的是 dataset:// 形式）', () => {
  const schema = readOpsSchema();
  const issues = validatePlanSchema(
    { version: '1.0', ops: [{ op: 'raster.adjustLevels', params: { target: '底图/current.tff' } }] },
    schema,
  );
  assert.ok(issues.length > 0, '裸相对路径过不了契约');
  assert.match(issues[0]?.message ?? '', /格式不符合要求/, '要说清是格式不对');
});

test('闸门②：feature.* / vector.* 判为「尚未支持」，不静默通过', () => {
  const plan = {
    version: '1.0',
    ops: [
      { op: 'feature.delete', params: { target: 'a.shp', where: 'x=1' } },
      { op: 'vector.reproject', params: { target: 'a.shp', to: 'EPSG:4326' } },
      { op: 'raster.paint', params: { target: 'a.tff', region: 'r', color: '#ff0000' } },
    ],
  };
  const unsupported = findUnsupportedOps(plan, RASTER_OPS);
  assert.equal(unsupported.length, 2, '两条矢量 op 都要被认出来');
  assert.match(unsupported[0]?.message ?? '', /该操作尚未支持：feature\.delete/);
  assert.match(unsupported[1]?.message ?? '', /该操作尚未支持：vector\.reproject/);
  assert.ok(
    !unsupported.some((u) => u.op === 'raster.paint'),
    '已实现的栅格 op 不该被误判',
  );
});

test('闸门②：引擎前置校验的结论分四类', () => {
  assert.equal(classifyPrecheck({ ok: true, error: null, unimplemented: false }), 'pass');
  assert.equal(
    classifyPrecheck({ ok: false, error: '该操作尚未支持：feature.delete', unimplemented: true }),
    'unimplemented',
  );
  assert.equal(
    classifyPrecheck({ ok: false, error: '该操作无法预演影响面（裁切需要真的产出文件才能知道改了什么）', unimplemented: false }),
    'unpreviewable',
    '预演不了影响面是能力边界，不算校验失败',
  );
  assert.equal(
    classifyPrecheck({ ok: false, error: '目标文件打不开', unimplemented: false }),
    'fail',
  );
});

test('模型回话：能抠出 JSON，抠不出就明说', () => {
  const fenced = parsePlanReply('```json\n{"version":"1.0","ops":[]}\n```');
  assert.equal(fenced.ok, true, '代码块里的 JSON 要认得出来');

  const plain = parsePlanReply('{"version":"1.0","ops":[]}');
  assert.equal(plain.ok, true);

  const noisy = parsePlanReply('好的，这是计划：{"version":"1.0","ops":[]} 以上。');
  assert.equal(noisy.ok, true, '前后有说明文字也要抠得出来');

  const garbage = parsePlanReply('我觉得应该把图调亮一点');
  assert.equal(garbage.ok, false, '不是 JSON 就不能当成功');
  assert.match(garbage.ok ? '' : garbage.message, /不是可解析的 JSON/);
});

test('端到端（假模型）：合法计划 → 闸门①②的结论 + 上下文预览一起回来', async () => {
  const res = await createPlan({
    prompt: '把底图提亮一点',
    model: 'MiniMax-M3.1-Flash',
    effort: 'max',
    context: RAW_CONTEXT,
    fetchImpl: fakeChat(
      JSON.stringify({
        version: '1.0',
        intent: '把底图提亮一点',
        ops: [
          {
            op: 'raster.adjustLevels',
            params: { target: 'dataset://底图/current.tff', contrast: 1.2 },
          },
        ],
      }),
    ),
  });

  assert.equal(res.ok, true, '合法计划应当通过');
  assert.equal(res.error, null);
  assert.equal(res.plan?.ops.length, 1);
  assert.deepEqual(res.schemaIssues, [], '闸门①不该有问题');
  assert.deepEqual(res.unsupported, [], '闸门②不该有未实现的 op');
  assert.ok(res.elapsedMs !== null && res.elapsedMs >= 0, '耗时要有');
  // 上下文预览：发出去的那段原文 + 字节数
  assert.ok(res.context && res.context.bytes > 0, '要带上下文预览');
  assert.ok(res.context?.prompt.includes('把底图提亮一点'), '预览里要有用户原话');
  assert.ok(!res.context?.prompt.includes('WORKSTATION-01'), '预览里不能有机器名');
});

test('端到端（假模型）：计划不合法 → 说清是哪一条，不假装成功', async () => {
  const res = await createPlan({
    prompt: '删掉一些要素',
    model: 'MiniMax-M3.1-Flash',
    context: RAW_CONTEXT,
    fetchImpl: fakeChat(
      JSON.stringify({
        version: '1.0',
        ops: [{ op: 'feature.delete', params: { target: 'dataset://a.shp' } }],
      }),
    ),
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'plan_schema_invalid');
  assert.ok(res.schemaIssues.length > 0);
  assert.match(res.schemaIssues[0]?.message ?? '', /第 1 条操作（feature\.delete）/);
  assert.match(res.message ?? '', /不符合操作契约/);
});

test('端到端（假模型）：请求了还没做的 op → 明确说「该操作尚未支持」', async () => {
  const res = await createPlan({
    prompt: '删掉一些要素',
    model: 'MiniMax-M3.1-Flash',
    context: RAW_CONTEXT,
    // 这条计划过得了契约（feature.delete 的参数齐），但引擎还没实现
    fetchImpl: fakeChat(
      JSON.stringify({
        version: '1.0',
        ops: [{ op: 'feature.delete', params: { target: 'dataset://a.shp', where: 'x=1' } }],
      }),
    ),
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'op_not_supported');
  assert.equal(res.unsupported.length, 1);
  assert.match(res.unsupported[0]?.message ?? '', /该操作尚未支持：feature\.delete/);
  assert.match(res.message ?? '', /该操作尚未支持/);
});

test('端到端（假模型）：密钥被官方拒了 → 报官方错误码，且不回显密钥', async () => {
  const res = await createPlan({
    prompt: '把底图提亮一点',
    model: 'MiniMax-M3.1-Flash',
    context: RAW_CONTEXT,
    fetchImpl: fakeError(401, {
      error: { message: 'invalid api key', code: 1004 },
    }),
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'llm_unauthorized');
  assert.equal(res.code, 1004, '官方错误码要带回来');
  assert.match(res.message ?? '', /invalid api key/);
  assert.ok(
    !(res.message ?? '').includes(FAKE_KEY),
    '错误信息里绝不能出现密钥',
  );
});

test('端到端（假模型）：连不上模型服务 → 与「密钥错」分开', async () => {
  const res = await createPlan({
    prompt: '把底图提亮一点',
    model: 'MiniMax-M3.1-Flash',
    context: RAW_CONTEXT,
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'llm_unreachable');
  assert.match(res.message ?? '', /连不上模型服务/);
});

test('上下文预览端点：算出来的那段就是会发出去的那段', async () => {
  const preview = await buildContextPreview({
    prompt: '把底图提亮一点',
    model: 'MiniMax-M3.1-Flash',
    effort: 'max',
    context: RAW_CONTEXT,
  });
  assert.ok(preview.bytes > 0);
  assert.equal(preview.model, 'MiniMax-M3.1-Flash');
  assert.equal(preview.effort, 'max');
  assert.ok(preview.prompt.includes('把底图提亮一点'));
  assert.ok(!preview.prompt.includes('WORKSTATION-01'));
});
