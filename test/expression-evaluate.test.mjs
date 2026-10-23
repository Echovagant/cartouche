/**
 * 表达式求值：类型、空值、大小写、边界。
 *
 * 这组用例盯的是三条底线：
 *  1. 数字列和文字列比大小必须报错（悄悄按字符串比出来的结果会被拿去改图）；
 *  2. 列名不存在必须点名；
 *  3. 除零、空值这些边界必须给出确定的行为，不许抛未定义的东西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { evaluate, evaluateExpression, parseExpression, ExpressionError } = await import(
  eng('expression/index.ts')
);

const ROW = {
  POP2020: 1000,
  NAME: 'Beijing',
  '列 名': '带空格',
  RATIO: 1.5,
  FLAG: true,
  EMPTY: null,
};

/** 求值并断言结果。 */
function ev(src, row = ROW) {
  return evaluateExpression(src, row);
}

/** 断言求值报错，并检查分类与消息关键词。 */
function assertEvalError(src, code, hint = '', row = ROW) {
  let err = null;
  try {
    evaluateExpression(src, row);
  } catch (e) {
    err = e;
  }
  assert.ok(err, `这句应该报错，却算出了结果：${src}`);
  assert.ok(err instanceof ExpressionError, `应该是 ExpressionError，实为 ${err?.name}`);
  assert.equal(err.code, code, `错误的分类应该是 ${code}：${err.message}`);
  if (hint) assert.match(err.message, new RegExp(hint), `错误消息里应当出现「${hint}」：${err.message}`);
  return err;
}

/* ── 基本求值 ─────────────────────────────────────────────── */

test('字段引用与常量', () => {
  assert.equal(ev('POP2020'), 1000);
  assert.equal(ev('NAME'), 'Beijing');
  assert.equal(ev('[列 名]'), '带空格');
  assert.equal(ev('123'), 123);
  assert.equal(ev("'abc'"), 'abc');
  assert.equal(ev('TRUE'), true);
  assert.equal(ev('NULL'), null);
});

test('算术运算', () => {
  assert.equal(ev('1 + 2'), 3);
  assert.equal(ev('5 - 8'), -3);
  assert.equal(ev('3 * 4'), 12);
  assert.equal(ev('10 / 4'), 2.5);
  assert.equal(ev('-3'), -3);
  assert.equal(ev('POP2020 + RATIO'), 1001.5);
});

test('比较运算', () => {
  assert.equal(ev('POP2020 > 500'), true);
  assert.equal(ev('POP2020 >= 1000'), true);
  assert.equal(ev('POP2020 < 500'), false);
  assert.equal(ev("NAME = 'Beijing'"), true);
  assert.equal(ev("NAME <> 'Beijing'"), false);
  assert.equal(ev("NAME < 'Chicago'"), true);
});

test('逻辑运算与短路', () => {
  assert.equal(ev("POP2020 > 500 AND NAME = 'Beijing'"), true);
  assert.equal(ev("POP2020 > 500 OR NAME = 'Shanghai'"), true);
  assert.equal(ev("NOT POP2020 > 500"), false);
  assert.equal(ev('POP2020 > 500 AND NAME = \'Shanghai\''), false);
});

test('IN / BETWEEN / LIKE / IS NULL', () => {
  assert.equal(ev("NAME IN ('Beijing', 'Shanghai')"), true);
  assert.equal(ev("NAME NOT IN ('Shanghai')"), true);
  assert.equal(ev('POP2020 BETWEEN 500 AND 2000'), true);
  assert.equal(ev('POP2020 BETWEEN 1500 AND 2000'), false);
  assert.equal(ev("NAME LIKE 'Bei%'"), true);
  assert.equal(ev("NAME LIKE '%jing'"), true);
  assert.equal(ev("NAME LIKE 'Bei_ing'"), true);
  assert.equal(ev('EMPTY IS NULL'), true);
  assert.equal(ev('EMPTY IS NOT NULL'), false);
  assert.equal(ev('POP2020 IS NULL'), false);
});

test('函数', () => {
  assert.equal(ev("UPPER(NAME)"), 'BEIJING');
  assert.equal(ev("LOWER(NAME)"), 'beijing');
  assert.equal(ev("TRIM('  x  ')"), 'x');
  assert.equal(ev('LENGTH(NAME)'), 7);
  assert.equal(ev('ABS(-5)'), 5);
  assert.equal(ev('ROUND(RATIO * 3, 2)'), 4.5);
  assert.equal(ev('ROUND(2.5)'), 3);
  assert.equal(ev('COALESCE(EMPTY, 0)'), 0);
  assert.equal(ev("CONCAT(NAME, '-x')"), 'Beijing-x');
});

test('LENGTH 按字符数算，中文不是字节数', () => {
  assert.equal(ev("LENGTH('中文')"), 2);
  assert.equal(ev("LENGTH('中文ab')"), 4);
});

/* ── 边界 ─────────────────────────────────────────────────── */

test('空值：参与比较结果是空值（未知），不是假', () => {
  assert.equal(ev('EMPTY = 1'), null);
  assert.equal(ev('EMPTY > 1'), null);
  assert.equal(ev('POP2020 = EMPTY'), null);
});

test('空值：AND / OR 的三值逻辑', () => {
  // 未知 AND 假 = 假
  assert.equal(ev('EMPTY = 1 AND POP2020 < 1'), false);
  // 未知 AND 真 = 未知
  assert.equal(ev('EMPTY = 1 AND POP2020 > 1'), null);
  // 未知 OR 真 = 真
  assert.equal(ev('EMPTY = 1 OR POP2020 > 1'), true);
  // 未知 OR 假 = 未知
  assert.equal(ev('EMPTY = 1 OR POP2020 < 1'), null);
});

test('空值：算术结果为空值', () => {
  assert.equal(ev('EMPTY + 1'), null);
});

test('CONCAT 里的空值当空串（拼字段时最常遇到的就是某列为空）', () => {
  assert.equal(ev("CONCAT(NAME, EMPTY, '!')"), 'Beijing!');
});

test('COALESCE 取第一个非空值', () => {
  assert.equal(ev('COALESCE(EMPTY, EMPTY, 7)'), 7);
  assert.equal(ev('COALESCE(EMPTY, NULL)'), null);
});

test('除以零要报错，不能给出 Infinity', () => {
  const err = assertEvalError('10 / 0', 'value', '除数为 0');
  assert.match(err.message, /除数为 0/);
});

test('除数为 0.0 同样报错', () => {
  assertEvalError('10 / 0.0', 'value', '除数为 0');
});

test('大小写：LIKE 不区分 ASCII 大小写；= 区分', () => {
  assert.equal(ev("'Beijing' LIKE 'bei%'"), true);
  assert.equal(ev("'Beijing' = 'beijing'"), false);
  assert.equal(ev("UPPER(NAME) = 'BEIJING'"), true);
});

/* ── 反例：类型错、列名不存在 ─────────────────────────────── */

test('数字列与文字比大小：必须报错并说清是哪一列', () => {
  const err = assertEvalError("POP2020 > 'abc'", 'type', 'POP2020');
  assert.match(err.message, /类型对不上/);
  assert.match(err.message, /数字/);
});

test('数字列与文字相等：同样报错（不许悄悄按字符串比）', () => {
  assertEvalError("POP2020 = 'abc'", 'type', 'POP2020');
});

test('算术里混入文字：报错', () => {
  assertEvalError("POP2020 + 'abc'", 'type', '数字');
});

test('列名不存在：要点名，并列出这一层有哪些列', () => {
  const err = assertEvalError('NOPE > 1', 'missing-field', 'NOPE');
  assert.match(err.message, /POP2020/);
});

test('列名大小写不敏感（SQL 标识符的惯例）', () => {
  assert.equal(ev('pop2020'), 1000);
});

test('函数用错类型要报错', () => {
  assertEvalError('UPPER(POP2020)', 'type', 'UPPER');
  assertEvalError('LENGTH(POP2020)', 'type', 'LENGTH');
  assertEvalError('ABS(NAME)', 'type', 'ABS');
});

test('不认识的函数要说清能用的是哪些', () => {
  const err = assertEvalError('FOO(1)', 'unknown-function', 'UPPER');
  assert.match(err.message, /不认识这个函数/);
});

test('NOT 用在不是判断的值上要报错', () => {
  assertEvalError('NOT POP2020', 'type', 'NOT');
});

test('AND / OR 用在不是判断的值上要报错', () => {
  assertEvalError("POP2020 AND NAME = 'x'", 'type', 'AND');
});

test('函数参数个数不对要报错', () => {
  assertEvalError("UPPER(NAME, 'x')", 'value', 'UPPER');
  assertEvalError('COALESCE()', 'value', 'COALESCE');
});

test('evaluate 也能直接吃 AST', () => {
  const node = parseExpression('POP2020 + 1');
  assert.equal(evaluate(node, ROW), 1001);
});
