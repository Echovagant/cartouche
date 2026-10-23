/**
 * 把 AST 渲染回 SQL 文本。
 *
 * 两个用途：
 *  1. 人话翻译的结果要**给用户看** —— "你这句话我翻成了这样"必须是可读的 SQL，
 *     而不是一棵树。
 *  2. 渲染结果要能被自己的解析器重新读进去（自洽），所以列名带空格时用方括号括起来。
 *
 * 括号按优先级加，不多不少：多了看着乱，少了语义会变。
 */
import { literalText } from './parser.ts';
import { tokenize } from './lexer.ts';
import type { BinaryOp, ExprNode } from './types.ts';

/** 各层运算符的优先级（数字大的 binds 得紧）。 */
const PREC = {
  OR: 1,
  AND: 2,
  NOT: 3,
  CMP: 4,
  ADD: 5,
  MUL: 6,
  UNARY: 7,
  ATOM: 8,
} as const;

function precOf(op: BinaryOp): number {
  switch (op) {
    case 'OR':
      return PREC.OR;
    case 'AND':
      return PREC.AND;
    case '+':
    case '-':
      return PREC.ADD;
    case '*':
    case '/':
      return PREC.MUL;
    default:
      return PREC.CMP;
  }
}

/**
 * 列名要不要加方括号。
 *
 * 不能一律加：中文列名（人口、名称）是这个项目里最常见的列名，
 * 一律写成 `[人口]` 看着像在报错。
 * 但也不能一律不加：含中文关键词的列名（和平、包含量）会被词法器切碎，
 * 那种必须用方括号整体包住。
 *
 * 判据交给词法器：这个名字能不能被读成**一个**标识符。
 */
export function quoteField(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  try {
    const tokens = tokenize(name);
    // tokenize 末尾会补一个 eof 记号，所以"一个标识符"是长度 2
    if (tokens.length === 2 && tokens[0]!.kind === 'ident' && tokens[0]!.name === name) {
      return name;
    }
  } catch {
    /* 读不成标识符就走加括号那条路 */
  }
  return `[${name}]`;
}

function render(node: ExprNode, minPrec: number): string {
  switch (node.kind) {
    case 'literal':
      return literalText(node.value);

    case 'field':
      return quoteField(node.name);

    case 'unary': {
      if (node.op === 'NOT') {
        const text = `NOT ${render(node.operand, PREC.NOT)}`;
        return PREC.NOT < minPrec ? `(${text})` : text;
      }
      const text = `${node.op}${render(node.operand, PREC.UNARY)}`;
      return PREC.UNARY < minPrec ? `(${text})` : text;
    }

    case 'binary': {
      const prec = precOf(node.op);
      const left = render(node.left, prec);
      const right = render(node.right, prec + 1);
      const text = `${left} ${node.op} ${right}`;
      return prec < minPrec ? `(${text})` : text;
    }

    case 'call': {
      const args = node.args.map((a) => render(a, PREC.ATOM)).join(', ');
      return `${node.name}(${args})`;
    }

    case 'in': {
      const list = node.list.map((a) => render(a, PREC.ATOM)).join(', ');
      const text = `${render(node.operand, PREC.CMP)} ${node.negated ? 'NOT IN' : 'IN'} (${list})`;
      return PREC.CMP < minPrec ? `(${text})` : text;
    }

    case 'between': {
      const text =
        `${render(node.operand, PREC.CMP)} ${node.negated ? 'NOT BETWEEN' : 'BETWEEN'} ` +
        `${render(node.low, PREC.ADD)} AND ${render(node.high, PREC.ADD)}`;
      return PREC.CMP < minPrec ? `(${text})` : text;
    }

    case 'like': {
      // 中文「包含」的 % 是翻译时补的，渲染回去要还原成带 % 的模式，
      // 否则用户看到的是「包含」而不是「LIKE '%x%'」，对不上自己写的条件。
      const pattern =
        node.wrap === 'both' && node.pattern.kind === 'literal' && typeof node.pattern.value === 'string'
          ? literalText(`%${node.pattern.value}%`)
          : render(node.pattern, PREC.ATOM);
      const text = `${render(node.operand, PREC.CMP)} ${node.negated ? 'NOT LIKE' : 'LIKE'} ${pattern}`;
      return PREC.CMP < minPrec ? `(${text})` : text;
    }

    case 'isnull': {
      const text = `${render(node.operand, PREC.CMP)} ${node.negated ? 'IS NOT NULL' : 'IS NULL'}`;
      return PREC.CMP < minPrec ? `(${text})` : text;
    }

    default: {
      const never: never = node;
      throw new Error(`认不出来的表达式节点：${JSON.stringify(never)}`);
    }
  }
}

/** 把表达式渲染成 SQL 文本。 */
export function renderExpression(node: ExprNode): string {
  return render(node, PREC.OR);
}
