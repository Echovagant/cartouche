/**
 * 表达式解析：SQL 子集的语法与优先级。
 *
 * 这组用例盯的是"读不懂要报错"和"优先级不能搞错"两件事。
 * 优先级搞错不会立刻崩，它会让条件悄悄筛出另一批要素 —— 那比报错糟得多。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { parseExpression, renderExpression, ExpressionError } = await import(eng('expression/index.ts'));

/** 解析并取出节点（简化断言用）。 */
function parse(src) {
  return parseExpression(src);
}

/** 断言语法错误，并检查错误分类。 */
function assertSyntaxError(src, hint = '') {
  let err = null;
  try {
    parseExpression(src);
  } catch (e) {
    err = e;
  }
  assert.ok(err, `这句应该读不懂，却解析成功了：${src}`);
  assert.ok(err instanceof ExpressionError, `应该是 ExpressionError，实为 ${err?.name}`);
  assert.equal(err.code, 'syntax', `错误的分类应该是 syntax：${err.message}`);
  if (hint) assert.match(err.message, new RegExp(hint), `错误消息里应当出现「${hint}」：${err.message}`);
  return err;
}

test('字段引用：裸列名与方括号列名', () => {
  assert.deepEqual(parse('POP2020'), { kind: 'field', name: 'POP2020' });
  assert.deepEqual(parse('[列 名]'), { kind: 'field', name: '列 名' });
  assert.deepEqual(parse('[a-b]'), { kind: 'field', name: 'a-b' });
});

test('常量：数字、文字、布尔、空值', () => {
  assert.deepEqual(parse('123'), { kind: 'literal', value: 123 });
  assert.deepEqual(parse('1.5'), { kind: 'literal', value: 1.5 });
  assert.deepEqual(parse("'abc'"), { kind: 'literal', value: 'abc' });
  assert.deepEqual(parse('TRUE'), { kind: 'literal', value: true });
  assert.deepEqual(parse('FALSE'), { kind: 'literal', value: false });
  assert.deepEqual(parse('NULL'), { kind: 'literal', value: null });
  // SQL 风格的 '' 转义
  assert.deepEqual(parse("'it''s'"), { kind: 'literal', value: "it's" });
});

test('算术与优先级：乘法先于加法', () => {
  const node = parse('1 + 2 * 3');
  assert.equal(node.kind, 'binary');
  assert.equal(node.op, '+');
  assert.equal(node.right.kind, 'binary');
  assert.equal(node.right.op, '*');
  // 括号能改优先级
  const paren = parse('(1 + 2) * 3');
  assert.equal(paren.op, '*');
  assert.equal(paren.left.op, '+');
});

test('比较运算符全集', () => {
  for (const op of ['=', '<>', '<', '<=', '>', '>=']) {
    const node = parse(`A ${op} 1`);
    assert.equal(node.kind, 'binary');
    assert.equal(node.op, op);
  }
  // != 是 <> 的别名
  assert.equal(parse('A != 1').op, '<>');
});

test('逻辑运算符与优先级：AND 先于 OR', () => {
  const node = parse('A = 1 OR B = 2 AND C = 3');
  assert.equal(node.op, 'OR');
  assert.equal(node.right.op, 'AND');
  const notNode = parse('NOT A = 1');
  assert.equal(notNode.kind, 'unary');
  assert.equal(notNode.op, 'NOT');
});

test('IN / NOT IN', () => {
  const node = parse('A IN (1, 2, 3)');
  assert.equal(node.kind, 'in');
  assert.equal(node.negated, false);
  assert.equal(node.list.length, 3);
  assert.equal(parse('A NOT IN (1)').negated, true);
});

test('BETWEEN / NOT BETWEEN（两端都含）', () => {
  const node = parse('A BETWEEN 1 AND 10');
  assert.equal(node.kind, 'between');
  assert.equal(node.low.value, 1);
  assert.equal(node.high.value, 10);
  assert.equal(parse('A NOT BETWEEN 1 AND 10').negated, true);
});

test('LIKE / NOT LIKE', () => {
  const node = parse("A LIKE 'x%'");
  assert.equal(node.kind, 'like');
  assert.equal(node.negated, false);
  assert.equal(node.wrap, 'exact');
  assert.equal(parse("A NOT LIKE 'x%'").negated, true);
});

test('IS NULL / IS NOT NULL', () => {
  const node = parse('A IS NULL');
  assert.equal(node.kind, 'isnull');
  assert.equal(node.negated, false);
  assert.equal(parse('A IS NOT NULL').negated, true);
});

test('函数调用', () => {
  const node = parse('UPPER(A)');
  assert.equal(node.kind, 'call');
  assert.equal(node.name, 'UPPER');
  assert.equal(node.args.length, 1);
  // 函数名大小写不敏感
  assert.equal(parse('upper(A)').name, 'UPPER');
  assert.equal(parse('COALESCE(A, 0, 1)').args.length, 3);
});

test('渲染回 SQL：列名带空格时用方括号，且能重新读进去', () => {
  const sql = renderExpression(parse("[列 名] >= 1000 AND A = 'x'"));
  assert.match(sql, /\[列 名\]/);
  assert.match(sql, />=/);
  // 自洽：渲染结果能被自己的解析器读回，且语义相同
  assert.deepEqual(parse(sql), parse("[列 名] >= 1000 AND A = 'x'"));
});

test('渲染保留中文列名的原样（不丢字）', () => {
  const sql = renderExpression(parse('人口 > 1000'));
  assert.match(sql, /人口/);
});

/* ── 反例：语法错必须报错，不能猜 ───────────────────────────── */

test('语法错：表达式没写完', () => {
  assertSyntaxError('POP2020 >');
  assertSyntaxError('1 +');
  assertSyntaxError('AND');
});

test('语法错：括号没闭合', () => {
  assertSyntaxError('(1 + 2', '括号没有闭合');
  assertSyntaxError('UPPER(A', '括号没有闭合');
});

test('语法错：比较运算符不能连用', () => {
  assertSyntaxError('A = 1 = 2', '多出来');
});

test('语法错：两个值挨在一起', () => {
  assertSyntaxError('A B');
});

test('语法错：IN 的清单不能空', () => {
  assertSyntaxError('A IN ()', '清单是空的');
});

test('语法错：BETWEEN 少了 AND', () => {
  assertSyntaxError('A BETWEEN 1', 'BETWEEN');
});

test('语法错：认不出来的字符', () => {
  assertSyntaxError('A @ B', '认不出来的字符');
});

test('语法错：空表达式', () => {
  assertSyntaxError('', '空的');
  assertSyntaxError('   ', '空的');
});

test('语法错：方括号没闭合', () => {
  assertSyntaxError('[列 名', '方括号没有闭合');
});
