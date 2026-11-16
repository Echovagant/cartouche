import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  MiniMaxProvider,
  SessionKeyProvider,
  redactSecrets,
  MINIMAX_CN_BASE_URL,
  MINIMAX_MODELS,
} = await import(pathToFileURL(join(root, 'src', 'engine', 'key-provider.ts')).href);

const FAKE_KEY = 'sk-test-0123456789abcdefghijklmnop'; // secret-scan:allow

test('MiniMaxProvider：没有密钥时 resolve 返回 null，hasCredentials 为 false', async () => {
  const p = new MiniMaxProvider({ readApiKey: () => null });
  assert.equal(await p.resolve('local'), null);
  assert.equal(await p.hasCredentials('local'), false);
});

test('MiniMaxProvider：配置后返回凭据，默认走国内版接入点', async () => {
  const p = new MiniMaxProvider({ readApiKey: () => FAKE_KEY });
  const creds = await p.resolve('local');
  assert.ok(creds);
  assert.equal(creds.apiKey, FAKE_KEY);
  assert.equal(creds.baseUrl, MINIMAX_CN_BASE_URL);
  assert.equal(creds.model, MINIMAX_MODELS[0]);
  assert.equal(await p.hasCredentials('local'), true);
});

test('MiniMaxProvider：离线兜底清单只留还在售的型号', async () => {
  const p = new MiniMaxProvider({ readApiKey: () => null });
  const models = await p.listModels();
  assert.ok(models.includes('MiniMax-M3.1-Flash'), '应包含 MiniMax-M3.1-Flash');
  assert.ok(models.includes('MiniMax-M3'), '应包含 MiniMax-M3');
  // 清单跟着「账号实际能调的型号」走：
  //   2026-10-24 用真 key 调 GET /models，那把订阅 key 能调到 M2 全系；
  //   2026-11-15 按官方在售清单核对，M2.7/M2.5/M2.1/M2 **将于 2026-11-18 退役**
  //   （老用户自动路由到 M3.1 Flash），所以兜底清单里不再留它们 ——
  //   留着会让离线兜底选出一个当天就调不了的型号。
  assert.deepEqual(
    [...models].sort(),
    ['MiniMax-M3', 'MiniMax-M3.1-Flash'].sort(),
  );
  assert.ok(
    ![...models].some((m) => m.startsWith('MiniMax-M2')),
    'M2 系已于 2026-11-18 退役，不该再出现在兜底清单里',
  );
});

test('MiniMaxProvider：默认接入点是官网公布的国内版 base_url', async () => {
  const p = new MiniMaxProvider({ readApiKey: () => null });
  assert.equal(p.baseUrl, 'https://api.minimax.cn/v1');
});

test('SessionKeyProvider：内存态密钥可读，置空后失效', async () => {
  let key = null;
  const p = new SessionKeyProvider({
    id: 'minimax',
    displayName: '会话态',
    readApiKey: () => key,
    models: ['MiniMax-M2.7'],
  });
  assert.equal(await p.hasCredentials('local'), false);
  key = FAKE_KEY;
  assert.equal(await p.hasCredentials('local'), true);
  const creds = await p.resolve('local');
  assert.equal(creds?.apiKey, FAKE_KEY);
  key = null;
  assert.equal(await p.hasCredentials('local'), false);
});

test('redactSecrets：把密钥从任意文本里抹掉', () => {
  const msg = `请求失败：Authorization: Bearer ${FAKE_KEY} （重试 3 次）`;
  const out = redactSecrets(msg, [FAKE_KEY]);
  assert.ok(!out.includes(FAKE_KEY), '密钥不应出现在结果里');
  assert.ok(out.includes('***REDACTED***'));
  assert.ok(out.includes('重试 3 次'), '非密钥内容应保留');
});

test('redactSecrets：过短的串不抹（避免把正常文本打成马赛克）', () => {
  const out = redactSecrets('short ab', ['ab']);
  assert.equal(out, 'short ab');
});

test('redactSecrets：null / undefined 的密钥不报错', () => {
  assert.equal(redactSecrets('hello', [null, undefined]), 'hello');
});

test('redactSecrets：兜底识别厂商格式的 key', () => {
  const jwtish = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'; // secret-scan:allow
  const out = redactSecrets(`token=${jwtish}`, []);
  assert.ok(!out.includes(jwtish), 'JWT 形态的 key 应被抹掉');
});
