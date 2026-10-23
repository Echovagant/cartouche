/**
 * 人话 → SQL 的翻译。
 *
 * 这组用例的核心不是"能翻多少"，而是**翻不了的时候必须翻不了**：
 * 猜错一次，用户就会拿着错的结果去改图 —— 那比"没听懂"糟得多。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { translatePlainChinese, evaluateExpression, PlainChineseError } = await import(
  eng('expression/index.ts')
);

/** 翻译并断言结果（忽略空白差异）。 */
function tr(text) {
  return translatePlainChinese(text).replace(/\s+/g, ' ').trim();
}

/** 断言翻不了，并检查错误里带没带着原话与已翻出的部分。 */
function assertUntranslatable(text, hint = '') {
  let err = null;
  try {
    translatePlainChinese(text);
  } catch (e) {
    err = e;
  }
  assert.ok(err, `这句应该翻不了，却翻译成功了：${text}`);
  assert.ok(err instanceof PlainChineseError, `应该是 PlainChineseError，实为 ${err?.name}`);
  assert.equal(err.original, text, '错误里要带上用户原话');
  assert.ok(typeof err.position === 'number', '错误里要带上卡住的位置');
  if (hint) {
    assert.match(err.message, new RegExp(hint), `错误消息里应当出现「${hint}」：${err.message}`);
  }
  // 错误消息里必须有"没看懂"与已翻出的部分，不能只丢一句语法错误
  assert.match(err.message, /没看懂/);
  assert.match(err.message, /翻到这里就卡住了/);
  return err;
}

/* ── 认得的词 ─────────────────────────────────────────────── */

test('比较词：等于 / 是 / 不等于 / 不是 / 大于 / 小于 / 大于等于 / 小于等于', () => {
  assert.equal(tr('人口 等于 1000'), '人口 = 1000');
  assert.equal(tr('人口 是 1000'), '人口 = 1000');
  assert.equal(tr('人口 不等于 1000'), '人口 <> 1000');
  assert.equal(tr('人口 大于 1000'), '人口 > 1000');
  assert.equal(tr('人口 小于 1000'), '人口 < 1000');
  assert.equal(tr('人口 大于等于 1000'), '人口 >= 1000');
  assert.equal(tr('人口 小于等于 1000'), '人口 <= 1000');
});

test('逻辑词：并且 / 且 / 和 / 或者 / 或', () => {
  assert.equal(tr('人口 大于 1000 并且 名称 等于 北京'), '人口 > 1000 AND 名称 = 北京');
  assert.equal(tr('人口 大于 1000 且 名称 等于 北京'), '人口 > 1000 AND 名称 = 北京');
  assert.equal(tr('人口 大于 1000 和 名称 等于 北京'), '人口 > 1000 AND 名称 = 北京');
  assert.equal(tr('人口 大于 1000 或者 名称 等于 北京'), '人口 > 1000 OR 名称 = 北京');
  assert.equal(tr('人口 大于 1000 或 名称 等于 北京'), '人口 > 1000 OR 名称 = 北京');
});

test('空值词：为空 / 不为空', () => {
  assert.equal(tr('人口 为空'), '人口 IS NULL');
  assert.equal(tr('人口 不为空'), '人口 IS NOT NULL');
  assert.equal(tr('人口 是空的'), '人口 IS NULL');
  assert.equal(tr('人口 不是空的'), '人口 IS NOT NULL');
});

test('包含词：包含 / 不包含（自动补通配符）', () => {
  assert.equal(tr("名称 包含 '城'"), "名称 LIKE '%城%'");
  assert.equal(tr("名称 不包含 '城'"), "名称 NOT LIKE '%城%'");
});

test('区间词：在……之间 / 不在……之间', () => {
  assert.equal(tr('人口 在 1000 到 5000 之间'), '人口 BETWEEN 1000 AND 5000');
  assert.equal(tr('人口 在 1000 至 5000 之间'), '人口 BETWEEN 1000 AND 5000');
  assert.equal(tr('人口 不在 1000 到 5000 之间'), '人口 NOT BETWEEN 1000 AND 5000');
});

test('「不是」：在值的位置是"非"，在运算符的位置是"不等于"', () => {
  // 运算符位置
  assert.equal(tr('人口 不是 1000'), '人口 <> 1000');
  // 值位置
  assert.match(tr('不是 1000'), /^NOT /);
});

test('括号与混写（中英混排也要认）', () => {
  assert.equal(
    tr('(人口 大于 1000 或者 名称 等于 北京) 并且 比例 小于 1'),
    '(人口 > 1000 OR 名称 = 北京) AND 比例 < 1',
  );
  assert.equal(tr('人口 大于 1000 AND 名称 LIKE \'Bei%\''), "人口 > 1000 AND 名称 LIKE 'Bei%'");
});

test('列名带空格要用方括号', () => {
  assert.equal(tr('[列 名] 大于 1000'), '[列 名] > 1000');
});

test('翻译结果能直接求值', () => {
  const row = { 人口: 2000, 名称: '北京' };
  const sql = translatePlainChinese('人口 大于 1000');
  assert.equal(evaluateExpression(sql, row), true);
});

test('人话入口能直接求值', () => {
  const row = { 人口: 2000, 名称: '北京' };
  assert.equal(evaluateExpression('人口 大于 1000', row), true);
  assert.equal(evaluateExpression('人口 大于 3000', row), false);
});

/* ── 翻不了的：必须报错，不许猜 ───────────────────────────── */

test('词表里没有的词：翻不了', () => {
  // 「超出」不在词表里
  assertUntranslatable('人口 超出 500', '没看懂');
});

test('没写完的句子：翻不了', () => {
  assertUntranslatable('人口 大于');
});

test('「包含」后面必须给一个写死的文字', () => {
  const err = assertUntranslatable("名称 包含 北京", '包含');
  assert.match(err.reason, /包含/);
});

test('「在……之间」缺了「之间」：翻不了', () => {
  assertUntranslatable('人口 在 1000 到 5000', '之间');
});

test('「在……之间」缺了分隔词：翻不了', () => {
  assertUntranslatable('人口 在 1000 5000 之间');
});

test('空条件：翻不了', () => {
  assertUntranslatable('', '空的');
});

test('中文词用错位置：翻不了', () => {
  // 「包含」出现在值的位置，说不通
  assertUntranslatable('包含');
});

test('翻不了时错误里带着原话与已翻出的部分', () => {
  const err = assertUntranslatable('人口 大于 1000 并且 名称 包含 北京');
  assert.match(err.original, /人口 大于 1000/);
  // 已翻出的部分至少要能看出前半句翻对了
  assert.match(err.partial, />|人口|1000/);
});
