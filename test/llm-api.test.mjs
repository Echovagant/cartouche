import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  listModelIds,
  chatOnce,
  extractErrorMessage,
  parseModelIds,
  parseChatReply,
  pickModelsAfterFailure,
  MinimaxApiError,
} = await import(pathToFileURL(join(root, 'src', 'engine', 'llm', 'minimax-api.ts')).href);

const FAKE_KEY = 'sk-test-0123456789abcdefghijklmnop'; // secret-scan:allow

/**
 * 假 fetch：记录请求，按剧本回响应。
 *
 * 关键：**模拟 undici（Node 自带的 fetch）的硬规矩** ——
 * GET/HEAD 不许带 body，带了就直接抛错。
 * 不模拟这条，代码里多塞一个空 body 字符串测试也照样绿，
 * 而真实请求会当场炸掉（2026-10-22 浏览器实测踩到过）。
 */
function fakeFetch(response, recorder) {
  return async (url, init) => {
    if ((init.method === 'GET' || init.method === 'HEAD') && 'body' in init) {
      throw new Error('Request with GET/HEAD method must have no body');
    }
    recorder.push({ url, init });
    return {
      ok: response.status < 400,
      status: response.status,
      text: async () => response.body,
    };
  };
}

const CREDENTIALS = {
  apiKey: FAKE_KEY,
  baseUrl: 'https://api.minimax.cn/v1',
  model: 'MiniMax-M3.1-Flash',
};

test('listModelIds：从 OpenAI 兼容响应里取出模型 id', async () => {
  const calls = [];
  const models = await listModelIds({
    ...CREDENTIALS,
    fetchImpl: fakeFetch(
      {
        status: 200,
        body: JSON.stringify({
          object: 'list',
          data: [{ id: 'MiniMax-M3.1-Flash' }, { id: 'MiniMax-M3' }, { id: '  ' }],
        }),
      },
      calls,
    ),
  });
  assert.deepEqual([...models], ['MiniMax-M3.1-Flash', 'MiniMax-M3'], '空的 id 不该算进去');
  assert.equal(calls[0].url, 'https://api.minimax.cn/v1/models', '要拼成 {base}/models');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${FAKE_KEY}`, '鉴权走 Bearer');
});

test('listModelIds：base 带结尾斜杠也不会拼出 //models', async () => {
  const calls = [];
  await listModelIds({
    ...CREDENTIALS,
    baseUrl: 'https://api.minimax.cn/v1/',
    fetchImpl: fakeFetch({ status: 200, body: JSON.stringify({ data: [{ id: 'm' }] }) }, calls),
  });
  assert.equal(calls[0].url, 'https://api.minimax.cn/v1/models');
});

test('listModelIds：GET 请求不许带 body（undici 会当场拒绝）', async () => {
  const calls = [];
  await listModelIds({
    ...CREDENTIALS,
    fetchImpl: fakeFetch({ status: 200, body: JSON.stringify({ data: [{ id: 'm' }] }) }, calls),
  });
  assert.equal('body' in calls[0].init, false, 'GET 请求带了 body 键就算带');
});

test('listModelIds：官方报错要读出原因，而不是只报状态码', async () => {
  await assert.rejects(
    () =>
      listModelIds({
        ...CREDENTIALS,
        fetchImpl: fakeFetch(
          {
            status: 401,
            body: JSON.stringify({ error: { message: 'invalid api key', code: 1004 } }),
          },
          [],
        ),
      }),
    (err) => {
      assert.ok(err instanceof MinimaxApiError);
      assert.match(err.message, /invalid api key/);
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test('listModelIds：密钥绝不出现在错误信息里', async () => {
  await assert.rejects(
    () =>
      listModelIds({
        ...CREDENTIALS,
        fetchImpl: async () => {
          // 模拟"请求头被原样塞进异常"的坏情况
          throw new Error(`connect ECONNREFUSED with Authorization: Bearer ${FAKE_KEY}`);
        },
      }),
    (err) => {
      assert.ok(!err.message.includes(FAKE_KEY), `错误信息里漏出了密钥：${err.message}`);
      assert.match(err.message, /连不上模型服务/);
      return true;
    },
  );
});

test('listModelIds：官方返回 401 时错误信息里也不能有密钥', async () => {
  await assert.rejects(
    () =>
      listModelIds({
        ...CREDENTIALS,
        fetchImpl: fakeFetch(
          { status: 401, body: JSON.stringify({ error: { message: `bad key ${FAKE_KEY}` } }) },
          [],
        ),
      }),
    (err) => {
      assert.ok(!err.message.includes(FAKE_KEY), `错误信息里漏出了密钥：${err.message}`);
      return true;
    },
  );
});

test('listModelIds：清单为空要报错，不能给一份空列表', async () => {
  await assert.rejects(
    () =>
      listModelIds({
        ...CREDENTIALS,
        fetchImpl: fakeFetch({ status: 200, body: JSON.stringify({ data: [] }) }, []),
      }),
    /没有可用的模型 id/,
  );
});

test('chatOnce：拿到回话与耗时', async () => {
  const calls = [];
  const result = await chatOnce({
    ...CREDENTIALS,
    prompt: '打个招呼',
    effort: 'low',
    fetchImpl: fakeFetch(
      {
        status: 200,
        body: JSON.stringify({
          model: 'MiniMax-M3.1-Flash',
          choices: [{ message: { role: 'assistant', content: '你好，我在。' } }],
        }),
      },
      calls,
    ),
  });
  assert.equal(result.reply, '你好，我在。');
  assert.equal(result.model, 'MiniMax-M3.1-Flash');
  assert.ok(result.elapsedMs >= 0, '耗时不能是负数');
  assert.equal(calls[0].url, 'https://api.minimax.cn/v1/chat/completions');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'MiniMax-M3.1-Flash');
  assert.equal(body.messages[0].content, '打个招呼');
  assert.equal(body.reasoning_effort, 'low', '档位要按 OpenAI 兼容的字段名传');
});

test('chatOnce：不给档位就不传这个字段（官方默认即 max）', async () => {
  const calls = [];
  await chatOnce({
    ...CREDENTIALS,
    prompt: '你好',
    fetchImpl: fakeFetch(
      {
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: '在。' } }] }),
      },
      calls,
    ),
  });
  const body = JSON.parse(calls[0].init.body);
  assert.equal('reasoning_effort' in body, false);
});

test('chatOnce：回话是数组形态时也要读得出来', async () => {
  const result = await chatOnce({
    ...CREDENTIALS,
    prompt: '你好',
    fetchImpl: fakeFetch(
      {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: [{ type: 'text', text: '你好' }, { type: 'text', text: '，在。' }] } }],
        }),
      },
      [],
    ),
  });
  assert.equal(result.reply, '你好，在。');
});

test('chatOnce：响应里读不出回话要报错，不能把空字符串当成功', async () => {
  await assert.rejects(
    () =>
      chatOnce({
        ...CREDENTIALS,
        prompt: '你好',
        fetchImpl: fakeFetch({ status: 200, body: JSON.stringify({ choices: [] }) }, []),
      }),
    /没能读出回话内容/,
  );
});

test('extractErrorMessage：认得官方两种错误体', () => {
  assert.equal(
    extractErrorMessage(JSON.stringify({ error: { message: 'A' } })),
    'A',
    'OpenAI 兼容形态',
  );
  assert.equal(
    extractErrorMessage(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'B' } })),
    'B',
    '官方原生形态',
  );
  assert.equal(extractErrorMessage('not json'), null, '不是 JSON 就返回 null');
  assert.equal(extractErrorMessage(JSON.stringify({})), null);
});

test('parseModelIds：数据不对时给空数组，不抛异常', () => {
  assert.deepEqual(parseModelIds('not json'), []);
  assert.deepEqual(parseModelIds(JSON.stringify({ data: 'nope' })), []);
  assert.deepEqual(parseModelIds(JSON.stringify({ data: [{ id: 'a' }] })), ['a']);
});

test('parseChatReply：结构不认识时给空串', () => {
  assert.deepEqual(parseChatReply('not json'), { reply: '', model: '' });
  assert.deepEqual(parseChatReply(JSON.stringify({})), { reply: '', model: '' });
});

test('拉取失败：优先给上一次成功的清单，并标成 stale', () => {
  const out = pickModelsAfterFailure({
    lastSuccessful: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
    fallback: ['offline-only'],
    warning: '连不上',
  });
  assert.deepEqual([...out.models], ['MiniMax-M3.1-Flash', 'MiniMax-M3'], '要用上一次成功的那份');
  assert.equal(out.source, 'stale');
  assert.equal(out.warning, '连不上');
});

test('拉取失败：一次都没成功过才用离线兜底清单', () => {
  const out = pickModelsAfterFailure({
    lastSuccessful: null,
    fallback: ['offline-only'],
    warning: '连不上',
  });
  assert.deepEqual([...out.models], ['offline-only']);
  assert.equal(out.source, 'fallback');
});

test('拉取失败：上次成功的是空数组也当没成功过', () => {
  const out = pickModelsAfterFailure({
    lastSuccessful: [],
    fallback: ['offline-only'],
    warning: '连不上',
  });
  assert.equal(out.source, 'fallback');
  assert.deepEqual([...out.models], ['offline-only']);
});
