/**
 * 表达式解析：把记号流变成 AST。
 *
 * 优先级（低 → 高）：
 *   OR → AND → NOT → 比较（= <> < <= > >= / IN / BETWEEN / LIKE / IS NULL）→ 加减 → 乘除 → 一元负号 → 原子
 *
 * 比较运算**不可连用**：`a = b = c` 直接报错，不去猜用户想表达什么。
 *
 * 中文短语的落点：
 *  - 「不是」出现在**值的位置** = 一元 NOT；出现在**运算符的位置** = 不等于。
 *    这是中文里唯一真正有歧义的一处，靠"位置"而不是"词表"来判，才不会两边都猜。
 *  - 「包含」= LIKE，且模式自动前后补 %（"包含城"匹配的是"包含城"三个字）。
 *  - 「在 X 到 Y 之间」= BETWEEN X AND Y，「不在」= NOT BETWEEN。
 */
import { tokenize, type Token } from './lexer.ts';
import {
  ExpressionError,
  type BinaryOp,
  type ExprNode,
  type ExprValue,
  type LikeNode,
} from './types.ts';

/** 比较运算符集合（SQL 与中文短语共用）。 */
const CMP_OPS: ReadonlySet<string> = new Set(['=', '<>', '<', '<=', '>', '>=']);

/** 是不是「并且」类记号（AND 关键字或中文的「并且」「且」「和」「同时」）。 */
function isAndToken(t: Token): boolean {
  return (t.kind === 'keyword' && t.kw === 'AND') || (t.kind === 'cn' && t.sql === 'AND');
}

/** 是不是「或者」类记号。 */
function isOrToken(t: Token): boolean {
  return (t.kind === 'keyword' && t.kw === 'OR') || (t.kind === 'cn' && t.sql === 'OR');
}

class Parser {
  private pos = 0;
  private readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const t = this.peek();
    this.pos += 1;
    return t;
  }

  private atEnd(): boolean {
    return this.peek().kind === 'eof';
  }

  private atKeyword(kw: string): boolean {
    const t = this.peek();
    return t.kind === 'keyword' && t.kw === kw;
  }

  private atCn(cn: string): boolean {
    const t = this.peek();
    return t.kind === 'cn' && t.cn === cn;
  }

  private atOp(op: string): boolean {
    const t = this.peek();
    return t.kind === 'op' && t.op === op;
  }

  private atPunct(ch: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.op === ch;
  }

  private error(reason: string, token?: Token): ExpressionError {
    const t = token ?? this.peek();
    const near = this.tokens
      .map((x) => x.text)
      .join('')
      .slice(Math.max(0, t.start - 10), t.start + 10)
      .trim();
    return new ExpressionError(
      'syntax',
      `表达式这里读不懂（第 ${t.start + 1} 个字符附近：${near || '（空）'}）：${reason}`,
      `位置 ${t.start}`,
      t.start,
    );
  }

  /** 解析到底。 */
  parse(): ExprNode {
    const node = this.parseOr();
    if (!this.atEnd()) {
      throw this.error(`这里多出来一段：${this.peek().text}`);
    }
    return node;
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();
    while (isOrToken(this.peek())) {
      this.next();
      left = { kind: 'binary', op: 'OR', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): ExprNode {
    let left = this.parseNot();
    while (isAndToken(this.peek())) {
      this.next();
      left = { kind: 'binary', op: 'AND', left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): ExprNode {
    // 「不是」在值的位置是一元 NOT；在运算符的位置是不等于（见 parseComparison）
    if (this.atKeyword('NOT') || this.atCn('not-eq')) {
      this.next();
      return { kind: 'unary', op: 'NOT', operand: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): ExprNode {
    const left = this.parseAdditive();

    // SQL 比较运算符
    const t = this.peek();
    if (t.kind === 'op' && t.op !== undefined && CMP_OPS.has(t.op)) {
      this.next();
      const right = this.parseAdditive();
      return { kind: 'binary', op: t.op as BinaryOp, left, right };
    }

    // 中文比较短语（「等于」「大于」…）
    if (t.kind === 'cn' && t.cn === 'op' && t.sql !== undefined && CMP_OPS.has(t.sql)) {
      this.next();
      const right = this.parseAdditive();
      return { kind: 'binary', op: t.sql as BinaryOp, left, right };
    }

    // 「不是」在运算符的位置 = 不等于
    if (this.atCn('not-eq')) {
      this.next();
      const right = this.parseAdditive();
      return { kind: 'binary', op: '<>', left, right };
    }

    // NOT IN / NOT BETWEEN / NOT LIKE
    if (this.atKeyword('NOT')) {
      const notToken = this.next();
      if (this.atKeyword('IN')) {
        this.next();
        return this.parseInList(left, true);
      }
      if (this.atKeyword('BETWEEN')) {
        this.next();
        return this.parseBetweenBounds(left, true);
      }
      if (this.atKeyword('LIKE')) {
        this.next();
        return this.parseLikePattern(left, true, 'exact');
      }
      throw this.error('NOT 后面只能跟 IN、BETWEEN 或 LIKE', notToken);
    }

    if (this.atKeyword('IN')) {
      this.next();
      return this.parseInList(left, false);
    }

    if (this.atKeyword('BETWEEN')) {
      this.next();
      return this.parseBetweenBounds(left, false);
    }

    if (this.atKeyword('LIKE')) {
      this.next();
      return this.parseLikePattern(left, false, 'exact');
    }

    // 中文：「包含」「不包含」
    if (this.atCn('like')) {
      this.next();
      return this.parseLikePattern(left, false, 'both');
    }
    if (this.atCn('not-like')) {
      this.next();
      return this.parseLikePattern(left, true, 'both');
    }

    // 中文：「在 X 到 Y 之间」「不在 X 到 Y 之间」
    if (this.atCn('between')) {
      this.next();
      return this.parseChineseBetween(left, false);
    }
    if (this.atCn('not-between')) {
      this.next();
      return this.parseChineseBetween(left, true);
    }

    // IS NULL / IS NOT NULL
    if (this.atKeyword('IS')) {
      this.next();
      let negated = false;
      if (this.atKeyword('NOT')) {
        this.next();
        negated = true;
      }
      if (!this.atKeyword('NULL')) {
        throw this.error('IS 后面只能是 NULL（或 IS NOT NULL）');
      }
      this.next();
      return { kind: 'isnull', operand: left, negated };
    }

    // 中文：「为空」「不为空」
    if (this.atCn('is-null')) {
      this.next();
      return { kind: 'isnull', operand: left, negated: false };
    }
    if (this.atCn('is-not-null')) {
      this.next();
      return { kind: 'isnull', operand: left, negated: true };
    }

    return left;
  }

  private parseInList(operand: ExprNode, negated: boolean): ExprNode {
    if (!this.atPunct('(')) {
      throw this.error('IN 后面要跟一个括号里的清单，例如 IN (1, 2, 3)');
    }
    this.next();
    const list: ExprNode[] = [];
    if (!this.atPunct(')')) {
      for (;;) {
        list.push(this.parseOr());
        if (this.atPunct(',')) {
          this.next();
          continue;
        }
        break;
      }
    }
    if (!this.atPunct(')')) {
      throw this.error('IN 的清单没有收尾的括号');
    }
    this.next();
    if (list.length === 0) {
      throw this.error('IN 的清单是空的');
    }
    return { kind: 'in', operand, list, negated };
  }

  private parseBetweenBounds(operand: ExprNode, negated: boolean): ExprNode {
    const low = this.parseAdditive();
    if (!isAndToken(this.peek())) {
      throw this.error('BETWEEN 要写成「x BETWEEN a AND b」，中间是 AND');
    }
    this.next();
    const high = this.parseAdditive();
    return { kind: 'between', operand, low, high, negated };
  }

  /** 「在 X 到 Y 之间」：分隔词可以是「到」「至」或「和」，末尾必须是「之间」。 */
  private parseChineseBetween(operand: ExprNode, negated: boolean): ExprNode {
    const low = this.parseAdditive();
    if (this.atCn('sep') || isAndToken(this.peek())) {
      this.next();
    } else {
      throw this.error('「在……之间」中间要有分隔词，例如「在 1000 到 5000 之间」');
    }
    const high = this.parseAdditive();
    if (!this.atCn('between-end')) {
      throw this.error('「在……之间」后面要有「之间」两个字');
    }
    this.next();
    return { kind: 'between', operand, low, high, negated };
  }

  private parseLikePattern(operand: ExprNode, negated: boolean, wrap: LikeNode['wrap']): ExprNode {
    const pattern = this.parseAdditive();
    // 中文「包含」的模式必须是写死的文字：给一个列名的话，
    // "包含哪些"这件事就没有确定答案，宁可报错也不要猜。
    if (wrap === 'both' && pattern.kind !== 'literal') {
      throw this.error('「包含」后面要写一个文字，例如 名称 包含 \'城\'');
    }
    return { kind: 'like', operand, pattern, negated, wrap };
  }

  private parseAdditive(): ExprNode {
    let left = this.parseMultiplicative();
    while (this.atOp('+') || this.atOp('-')) {
      const op = this.next().op as BinaryOp;
      left = { kind: 'binary', op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): ExprNode {
    let left = this.parseUnary();
    while (this.atOp('*') || this.atOp('/')) {
      const op = this.next().op as BinaryOp;
      left = { kind: 'binary', op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    if (this.atOp('-')) {
      this.next();
      return { kind: 'unary', op: '-', operand: this.parseUnary() };
    }
    if (this.atOp('+')) {
      this.next();
      return { kind: 'unary', op: '+', operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const t = this.peek();

    if (t.kind === 'number') {
      this.next();
      return { kind: 'literal', value: t.num as number };
    }
    if (t.kind === 'string') {
      this.next();
      return { kind: 'literal', value: t.str as string };
    }
    if (t.kind === 'keyword' && (t.kw === 'TRUE' || t.kw === 'FALSE')) {
      this.next();
      return { kind: 'literal', value: t.kw === 'TRUE' };
    }
    if (t.kind === 'keyword' && t.kw === 'NULL') {
      this.next();
      return { kind: 'literal', value: null };
    }
    if (t.kind === 'ident') {
      this.next();
      const name = t.name ?? t.text;
      if (this.atPunct('(')) {
        return this.parseCall(name);
      }
      return { kind: 'field', name };
    }
    if (this.atPunct('(')) {
      this.next();
      const inner = this.parseOr();
      if (!this.atPunct(')')) {
        throw this.error('括号没有闭合');
      }
      this.next();
      return inner;
    }

    throw this.error(
      t.kind === 'eof' ? '表达式没写完' : `这里放不下一个值：${t.text || '（空）'}`,
    );
  }

  private parseCall(name: string): ExprNode {
    this.next(); // '('
    const args: ExprNode[] = [];
    if (!this.atPunct(')')) {
      for (;;) {
        args.push(this.parseOr());
        if (this.atPunct(',')) {
          this.next();
          continue;
        }
        break;
      }
    }
    if (!this.atPunct(')')) {
      throw this.error(`函数 ${name} 的括号没有闭合`);
    }
    this.next();
    return { kind: 'call', name: name.toUpperCase(), args };
  }
}

/**
 * 解析一段表达式。
 *
 * @throws {ExpressionError} code='syntax'：语法读不懂。
 */
export function parseExpression(src: string): ExprNode {
  return parseExpressionDetailed(src).node;
}

/**
 * 解析并把记号流一并带出来。
 *
 * 为什么需要记号流：人话翻译失败时要告诉用户"已经翻到这一步"，
 * 那段"已经翻出来的部分"就是从记号流里重写出来的。
 */
export function parseExpressionDetailed(src: string): {
  readonly node: ExprNode;
  readonly tokens: readonly Token[];
} {
  if (typeof src !== 'string' || src.trim() === '') {
    throw new ExpressionError('syntax', '表达式是空的');
  }
  const tokens = tokenize(src);
  return { node: new Parser(tokens).parse(), tokens };
}

/** 供渲染用的字面量文本。 */
export function literalText(value: ExprValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}
