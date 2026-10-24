/**
 * 厂商目录的测试。
 *
 * 盯住的是三件容易悄悄错掉的事：
 *
 * 1. **目录里不能有重复 id** —— 重复会让"选哪家"这个动作变得不确定。
 * 2. **没区分度的 key 前缀不能拿来判厂商** —— `sk-` 是 DeepSeek、Kimi、
 *    硅基流动、百炼按量**全都**开头的那一段，拿它当百炼的特征，
 *    等于把别家的 key 一律误判成百炼。
 * 3. **端点明说没有清单接口的，要标出来** —— 界面据此不给「拉取模型清单」，
 *    不发一个必然失败的请求。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  LLM_PROVIDERS,
  LLM_FAMILY_LABELS,
  findProvider,
  detectProviderByKey,
} = await import(pathToFileURL(join(root, 'src', 'engine', 'llm', 'providers.ts')).href);

test('目录里没有重复的 id', () => {
  const ids = LLM_PROVIDERS.map((p) => p.id);
  assert.deepEqual(ids, [...new Set(ids)], '有重复 id');
});

test('每条接入线都有家族与端点（自定义那条除外）', () => {
  for (const p of LLM_PROVIDERS) {
    assert.ok(p.family, `${p.id} 缺 family`);
    assert.ok(LLM_FAMILY_LABELS[p.family], `${p.id} 的家族没有中文名`);
    if (!p.customEndpoint) {
      assert.match(p.baseUrl, /^https?:\/\//, `${p.id} 的端点不合法`);
    }
  }
});

test('端点只能用 https（本机那条除外）', () => {
  for (const p of LLM_PROVIDERS) {
    if (p.customEndpoint) continue; // 自定义端点由用户自己填
    if (p.id === 'ollama') {
      assert.match(p.baseUrl, /^http:\/\/127\.0\.0\.1/, '本机服务只走回环');
      continue;
    }
    assert.match(p.baseUrl, /^https:\/\//, `${p.id} 用了明文 http`);
  }
});

test('认 key：`sk-sp-` 是百炼 Coding Plan，不是百炼按量', () => {
  // sk-sp- 是 sk- 的前缀 —— 匹配必须按长度倒序，否则套餐 key 会被当成按量 key。
  const hit = detectProviderByKey('sk-sp-abcdef123456');
  assert.ok(hit, '应该认得出来');
  assert.equal(hit.family, 'dashscope');
  assert.equal(hit.providerId, 'dashscope-coding', '要认出是 Coding Plan 那条');
});

test('认 key：`sk-` 开头认不出是哪一家（太通用）', () => {
  // DeepSeek / Kimi / 硅基流动 / 百炼按量 的 key 全是 sk- 开头。
  // 拿它判厂商 = 把别家的 key 误判成百炼。所以认不出就认不出。
  assert.equal(detectProviderByKey('sk-abcdef123456'), null, '通用前缀不能用来判厂商');
});

test('认 key：MiniMax 的 key 认得出家族，但认不出国内版还是国际版', () => {
  const hit = detectProviderByKey('sk-cp-abcdef123456');
  assert.ok(hit, '应该认得出家族');
  assert.equal(hit.family, 'minimax');
  assert.equal(hit.providerId, null, '国内版与国际版 key 长得一样，分不出');
});

test('认 key：认不出来就返回 null（不能硬猜）', () => {
  assert.equal(detectProviderByKey('not-a-key-at-all'), null);
  assert.equal(detectProviderByKey(''), null);
  assert.equal(detectProviderByKey('   '), null);
});

test('找接入线：找不到就 null（不抛错）', () => {
  assert.equal(findProvider('minimax-cn')?.displayName, 'MiniMax（国内版）');
  assert.equal(findProvider('不存在的接入线'), null);
});

test('没有清单接口的接入线要标出来，且带原因', () => {
  const arkCoding = findProvider('ark-coding');
  assert.ok(arkCoding, '火山方舟 Coding Plan 应该在目录里');
  assert.equal(arkCoding.modelsSupported, false, '官方只给了 Anthropic 协议路径');
  assert.ok(arkCoding.note, '要说清为什么');
});

test('只给 MiniMax 发思考深度参数', () => {
  // 多发一个不认的参数（reasoning_effort）会让整次请求 400。
  for (const p of LLM_PROVIDERS) {
    if (p.id.startsWith('minimax')) {
      assert.equal(p.effortSupported, true, `${p.id} 认 reasoning_effort`);
      assert.ok((p.fallbackModels ?? []).length > 0, `${p.id} 要有离线兜底清单`);
    } else {
      assert.notEqual(p.effortSupported, true, `${p.id} 没核实过，不该发思考深度`);
    }
  }
});
