/**
 * 多厂商持久化密钥（2026-11-15 裁定）的取钥规则。
 *
 * 约定：scripts/set-key.ps1 把每条接入线的 key 存成 DPAPI 密文，
 * 启动脚本解密注入 <大写ID>_API_KEY；server/src/llm.ts 的 PERSISTED_ENV
 * 是这份映射的唯一权威。这里钉住三条规则：
 *   1. 会话粘贴 > 持久化 env（用户刚贴的优先）；
 *   2. 每条接入线**各自**认自己的 env——给 deepseek 的 key 不能让 glm 变成已配置；
 *   3. ollama / custom 不在持久化表里（一个不用 key，一个跟端点走）。
 *
 * 红线：env 值是注入进来的密文解出物，测试里用完即删，不落任何盘。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const llmUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'src', 'llm.ts'),
).href;
const llm = await import(llmUrl);

describe('多厂商持久化密钥的取钥规则', () => {
  test('给 deepseek 的持久化 key 只对 deepseek 生效', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek';
    try {
      assert.equal(llm.currentKeySource('deepseek'), 'env');
      assert.equal(llm.currentApiKey('deepseek'), 'sk-test-deepseek');
      // 别的接入线不能被这一把 key 顺手点亮
      assert.equal(llm.currentKeySource('glm'), 'none');
      assert.equal(llm.currentKeySource('siliconflow'), 'none');
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  test('minimax-cn 的旧单文件 env 仍然认（兼容已有部署）', () => {
    process.env.MINIMAX_API_KEY = 'sk-test-minimax';
    try {
      assert.equal(llm.currentKeySource('minimax-cn'), 'env');
      assert.equal(llm.currentApiKey('minimax-cn'), 'sk-test-minimax');
    } finally {
      delete process.env.MINIMAX_API_KEY;
    }
  });

  test('会话粘贴优先于持久化 env', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-from-env';
    try {
      llm.setSessionApiKey('deepseek', 'sk-from-session');
      assert.equal(llm.currentKeySource('deepseek'), 'session');
      assert.equal(llm.currentApiKey('deepseek'), 'sk-from-session');
      llm.setSessionApiKey('deepseek', null);
      assert.equal(llm.currentKeySource('deepseek'), 'env');
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
      llm.setSessionApiKey('deepseek', null);
    }
  });

  test('ollama / custom 不在持久化表里', () => {
    process.env.OLLAMA_API_KEY = 'should-not-count';
    process.env.CUSTOM_API_KEY = 'should-not-count';
    try {
      assert.equal(llm.currentKeySource('ollama'), 'none');
      assert.equal(llm.currentKeySource('custom'), 'none');
    } finally {
      delete process.env.OLLAMA_API_KEY;
      delete process.env.CUSTOM_API_KEY;
    }
  });
});
