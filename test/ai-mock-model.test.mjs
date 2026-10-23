/**
 * 本地 mock 模型端点 + 「一句话 → 操作计划」整条链路的端到端验证。
 *
 * 为什么要有 mock：本机没配真实模型密钥，而"链路通不通"这件事
 * **不能**靠真调一次模型来验 —— 那是网络问题，不是链路问题。
 * 这里起一个讲 OpenAI 兼容协议的最小 HTTP 服务：
 *
 *   GET  {base}/models             → 一两个模型 id
 *   POST {base}/chat/completions   → 一份符合 ops.schema.json 的操作计划
 *
 * 然后让引擎的模型接入点（MINIMAX_BASE_URL）指向它，跑真正的
 * `createPlan()`：裁剪上下文 → 拼提示词 → 发请求 → 解析 → 闸门① → 闸门②。
 * 这条链路里除了"模型"换成 mock，其余全是生产代码。
 *
 * ── 两种跑法 ──────────────────────────────────────────────────
 *   验测试：  node --test test/ai-mock-model.test.mjs
 *   起服务：  node test/ai-mock-model.test.mjs --serve
 *             （给浏览器实测用；端口取 MOCK_LLM_PORT，默认 8799）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listenSafe } from './helpers/listen-safe.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverSrc = (p) => pathToFileURL(join(root, 'server', 'src', p)).href;

/** 假密钥：只在这一条链路上用一次，不落盘、不进仓库 */
const FAKE_KEY = 'sk-test-0123456789abcdefghijklmnop'; // secret-scan:allow

/** mock 提供的模型 id */
const MOCK_MODELS = ['mock-planner-1', 'mock-planner-2'];

/**
 * 把提示词切成三段：可用操作清单、上下文、用户要求。
 *
 * mock 要像模型一样**读上下文**挑目标，否则它只会回一个写死的目标，
 * 换个项目就指错文件。切段靠的是提示词里那三个固定标记
 * （标记与提示词模板在 server/src/llm-plan.ts 的 buildPlanPrompt 里）。
 */
export function parsePromptSections(prompt) {
  const contextMarker = '【本次可见的项目上下文】';
  const userMarker = '【用户的要求】';
  const outputMarker = '【输出】';
  let contextText = '';
  let userText = '';
  const ctxIdx = prompt.indexOf(contextMarker);
  if (ctxIdx >= 0) {
    const afterCtx = prompt.slice(ctxIdx);
    const userIdx = afterCtx.indexOf(userMarker);
    const ctxBody = userIdx >= 0 ? afterCtx.slice(0, userIdx) : afterCtx;
    const nl = ctxBody.indexOf('\n');
    contextText = nl >= 0 ? ctxBody.slice(nl + 1) : '';
    if (userIdx >= 0) {
      const rest = afterCtx.slice(userIdx + userMarker.length);
      const outIdx = rest.indexOf(outputMarker);
      userText = (outIdx >= 0 ? rest.slice(0, outIdx) : rest).trim();
    }
  }
  return { contextText, userText };
}

/**
 * 从上下文里挑出要改的文件。
 *
 * 优先读上下文的图层清单（那才是"这个项目里有什么"），
 * 再退到正则；写死的目标只作最后兜底。
 */
export function pickTargetFromPrompt(prompt, fallback) {
  const { contextText } = parsePromptSections(prompt);
  try {
    const ctx = JSON.parse(contextText.trim());
    const first = Array.isArray(ctx.layers) ? ctx.layers[0] : null;
    if (first && typeof first.path === 'string' && first.path.trim()) {
      return `dataset://${first.path.trim()}`;
    }
  } catch {
    /* 上下文不是 JSON 就退到正则 */
  }
  const layerPath = prompt.match(/"path"\s*:\s*"([^"]+)"/);
  if (layerPath?.[1]) return `dataset://${layerPath[1]}`;
  // 提示词模板里有 "dataset://<工作区相对路径>" 这种占位写法，不能当真的目标
  const datasetRef = prompt.match(/dataset:\/\/([^"'<\s]+)/);
  if (datasetRef?.[1]) return `dataset://${datasetRef[1]}`;
  return fallback;
}

/**
 * 造一份符合契约的计划。
 *
 * 区域用**像元坐标**：跟画布框选给出的形状一致，不依赖目标影像的坐标系。
 */
export function buildMockPlan(prompt, options = {}) {
  const target = options.target ?? pickTargetFromPrompt(prompt, 'dataset://底图.tff');
  const region = options.region ?? { minX: 2, minY: 2, maxX: 12, maxY: 10 };
  const color = options.color ?? '#d9480f';
  const { userText } = parsePromptSections(prompt);
  const intent = options.intent ?? (userText ? userText.slice(0, 200) : '按用户要求涂色一小块');
  return {
    version: '1.0',
    intent,
    ops: [
      {
        op: 'raster.paint',
        params: { target, region, color },
        requireUserConfirm: true,
      },
    ],
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 起一个讲 OpenAI 兼容协议的模型端点。
 *
 * @param {{models?: readonly string[], planBuilder?: (prompt: string) => unknown,
 *          failWith?: {status: number, body: unknown} | null, port?: number}} [options]
 */
export async function startMockModelServer(options = {}) {
  const models = options.models ?? MOCK_MODELS;
  const planBuilder = options.planBuilder ?? ((prompt) => buildMockPlan(prompt));
  const failWith = options.failWith ?? null;
  const requests = [];

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      requests.push({ method: req.method, path, body: raw });

      if (failWith) {
        sendJson(res, failWith.status, failWith.body);
        return;
      }

      if (req.method === 'GET' && /\/models$/.test(path)) {
        sendJson(res, 200, {
          object: 'list',
          data: models.map((id) => ({ id, object: 'model' })),
        });
        return;
      }

      if (req.method === 'POST' && /\/chat\/completions$/.test(path)) {
        let payload = {};
        try {
          payload = JSON.parse(raw || '{}');
        } catch {
          payload = {};
        }
        const prompt =
          Array.isArray(payload.messages) && payload.messages[0]
            ? String(payload.messages[0].content ?? '')
            : '';
        const plan = planBuilder(prompt);
        sendJson(res, 200, {
          id: 'mock-chatcmpl',
          object: 'chat.completion',
          model: payload.model ?? models[0],
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify(plan) },
              finish_reason: 'stop',
            },
          ],
        });
        return;
      }

      sendJson(res, 404, { error: { message: `mock 没有这个端点：${path}` } });
    });
  });

  // 固定端口时不做"撞了换一个"的兜底：引擎的接入点是靠环境变量指过来的，
  // 端口悄悄换掉就等于两边对不上。占用就直接报错。
  if (options.port) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', resolve);
    });
  } else {
    await listenSafe(server);
  }
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    /** 引擎认的接入点形态：{base}/v1 */
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 把真 fetch 适配成引擎要的最小接口（Ok / status / text） */
function fetchAdapter() {
  return async (url, init) => {
    const res = await fetch(url, init);
    return { ok: res.ok, status: res.status, text: () => res.text() };
  };
}

/* ── 起服务 + 把引擎的接入点指过来 ──────────────────────────── */

const mock = await startMockModelServer();
process.env.MINIMAX_API_KEY = FAKE_KEY;
process.env.MINIMAX_BASE_URL = mock.url;

const { createPlan, checkPlanAgainstContract, parsePlanReply } = await import(
  serverSrc('llm-plan.ts')
);

const { listModelIds } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'llm', 'minimax-api.ts')).href
);

/** 提议层用的最小上下文：一个栅格图层 */
const CONTEXT = {
  projectName: '演示项目',
  layers: [
    { id: 'layer-1', kind: 'raster', path: '底图.tff', visible: true, opacity: 1 },
  ],
  features: [],
  viewport: null,
};

/* ── 用例 ────────────────────────────────────────────────────── */

test('mock 端点讲的是 OpenAI 兼容协议：GET /models 给出模型 id', async () => {
  const res = await fetch(`${mock.base}/v1/models`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.data));
  assert.deepEqual(
    body.data.map((m) => m.id),
    [...MOCK_MODELS],
  );

  // 引擎自己的清单解析器也要能读懂它
  const ids = await listModelIds({ apiKey: FAKE_KEY, baseUrl: mock.url, model: MOCK_MODELS[0] });
  assert.deepEqual([...ids], [...MOCK_MODELS]);
});

test('mock 端点的 chat/completions 回一份能被解析的计划', async () => {
  const res = await fetch(`${mock.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MOCK_MODELS[0], messages: [{ role: 'user', content: '涂一块' }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const reply = body.choices?.[0]?.message?.content;
  assert.equal(typeof reply, 'string');

  const parsed = parsePlanReply(reply);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.version, '1.0');
  assert.equal(parsed.value.ops.length, 1);
});

test('mock 的计划符合操作契约（闸门①放行）', async () => {
  const plan = buildMockPlan('把底图涂红');
  const gate = checkPlanAgainstContract(plan);
  assert.equal(gate.ok, true, `闸门①没过：${gate.message ?? ''}`);
  assert.deepEqual(gate.schemaIssues, []);
});

test('整条链：一句话 → 提议 → 契约校验，目标是上下文里的那个图层', async () => {
  const result = await createPlan({
    prompt: '把底图右上角涂成橙色，别动别的',
    model: MOCK_MODELS[0],
    context: CONTEXT,
  });

  assert.equal(result.ok, true, `提议失败：${result.error ?? ''} ${result.message ?? ''}`);
  assert.equal(result.error, null);
  assert.ok(result.plan);
  assert.equal(result.plan.ops.length, 1);
  assert.equal(result.plan.ops[0].op, 'raster.paint');
  // 目标是从上下文里的图层路径挑出来的，不是写死的
  assert.equal(result.plan.ops[0].params.target, 'dataset://底图.tff');
  // 引擎把选中的模型名发了出去，mock 原样回显
  assert.equal(result.model, MOCK_MODELS[0]);
  // 上下文预览也在同一次返回里：发出去的那段原文能看到
  assert.ok(result.context);
  assert.ok(result.context.bytes > 0);
  assert.ok(result.context.prompt.includes('底图.tff'));
});

test('引擎拒绝不合约的计划时，错误说清是哪一条不合规', async () => {
  const broken = await startMockModelServer({
    planBuilder: () => ({
      version: '1.0',
      intent: '瞎写的',
      ops: [{ op: 'raster.这不是一个操作', params: {} }],
    }),
  });
  try {
    const result = await createPlan({
      prompt: '随便改改',
      context: CONTEXT,
      fetchImpl: async (_url, init) => {
        const res = await fetch(`${broken.base}/v1/chat/completions`, init);
        return { ok: res.ok, status: res.status, text: () => res.text() };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'plan_schema_invalid');
    assert.ok(result.schemaIssues.length > 0);
    assert.ok((result.message ?? '').length > 0);
  } finally {
    await broken.close();
  }
});

test('模型服务拒绝密钥时，错误分类是鉴权失败，且消息里没有密钥', async () => {
  const denied = await startMockModelServer({
    failWith: {
      status: 401,
      body: { error: { message: 'Please carry the API secret key', code: 1004 } },
    },
  });
  try {
    const result = await createPlan({
      prompt: '把底图涂红',
      context: CONTEXT,
      fetchImpl: async (_url, init) => {
        const res = await fetch(`${denied.base}/v1/chat/completions`, init);
        return { ok: res.ok, status: res.status, text: () => res.text() };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'llm_unauthorized');
    assert.equal(result.code, 1004);
    assert.ok(!(result.message ?? '').includes(FAKE_KEY));
  } finally {
    await denied.close();
  }
});

test.after(async () => {
  await mock.close();
});

/* ── 独立运行：给浏览器实测起一个常驻端点 ─────────────────────── */

if (process.argv.includes('--serve')) {
  const port = Number(process.env.MOCK_LLM_PORT ?? 8799);
  const serving = await startMockModelServer({ port });
  // 这一行给外面的脚本读：引擎的 MINIMAX_BASE_URL 要指向它
  console.log(`[mock-llm] ${JSON.stringify({ baseUrl: serving.url, port: serving.port })}`);
  const stop = async () => {
    await serving.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}
