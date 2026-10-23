/**
 * 表达式的抽象语法树与错误类型。
 *
 * 为什么把 AST 与求值器分开：属性查询（vector.query）与计算字段（vector.addField）
 * 是两个用途，但**判定条件必须用同一套规则** —— 一边把 `POP2020 > 'abc'` 当成字符串比，
 * 另一边当成数字比，用户看到的结论就会自相矛盾。所以这里只定义"形状"，
 * 语法怎么解析、值怎么算，分别由 parser.ts 与 evaluate.ts 负责。
 */

/** 表达式能产出的值。属性表里的值只有这几种，NULL 单独算一种。 */
export type ExprValue = string | number | boolean | null;

/** 二元运算符。 */
export type BinaryOp =
  | '+' | '-' | '*' | '/'
  | '=' | '<>' | '<' | '<=' | '>' | '>='
  | 'AND' | 'OR';

/** 字面量：数字、字符串、布尔、空值。 */
export interface LiteralNode {
  readonly kind: 'literal';
  readonly value: ExprValue;
}

/** 字段引用。`name` 是属性表里的列名原文（不含方括号）。 */
export interface FieldNode {
  readonly kind: 'field';
  readonly name: string;
}

/** 一元运算：取负、取正、逻辑非。 */
export interface UnaryNode {
  readonly kind: 'unary';
  readonly op: '-' | '+' | 'NOT';
  readonly operand: ExprNode;
}

/** 二元运算。 */
export interface BinaryNode {
  readonly kind: 'binary';
  readonly op: BinaryOp;
  readonly left: ExprNode;
  readonly right: ExprNode;
}

/** 函数调用。 */
export interface CallNode {
  readonly kind: 'call';
  readonly name: string;
  readonly args: readonly ExprNode[];
}

/** IN / NOT IN。 */
export interface InNode {
  readonly kind: 'in';
  readonly operand: ExprNode;
  readonly list: readonly ExprNode[];
  readonly negated: boolean;
}

/** BETWEEN / NOT BETWEEN（两端都含）。 */
export interface BetweenNode {
  readonly kind: 'between';
  readonly operand: ExprNode;
  readonly low: ExprNode;
  readonly high: ExprNode;
  readonly negated: boolean;
}

/**
 * LIKE / NOT LIKE。
 *
 * `wrap` 记的是"匹配模式要不要自己加通配符"：
 *  - `exact`：模式原样用（SQL 里写 `NAME LIKE 'a%'`）
 *  - `both`：模式前后各补一个 `%`（人话里的「包含」）
 * 两种写法在求值时等价，但分开记才能把"人话"原样翻回给人看。
 */
export interface LikeNode {
  readonly kind: 'like';
  readonly operand: ExprNode;
  readonly pattern: ExprNode;
  readonly negated: boolean;
  readonly wrap: 'exact' | 'both';
}

/** IS NULL / IS NOT NULL。 */
export interface IsNullNode {
  readonly kind: 'isnull';
  readonly operand: ExprNode;
  readonly negated: boolean;
}

export type ExprNode =
  | LiteralNode
  | FieldNode
  | UnaryNode
  | BinaryNode
  | CallNode
  | InNode
  | BetweenNode
  | LikeNode
  | IsNullNode;

/** 表达式报错的分类。上层按分类决定"是人话没听懂"还是"数据不对"。 */
export type ExpressionErrorCode =
  /** 语法读不懂 */
  | 'syntax'
  /** 类型对不上（数字列比文字、函数参数类型不对…） */
  | 'type'
  /** 记录里没有这个字段 */
  | 'missing-field'
  /** 不认识的函数 */
  | 'unknown-function'
  /** 值算不出来（除零等） */
  | 'value';

export class ExpressionError extends Error {
  readonly code: ExpressionErrorCode;
  /** 出错位置的补充说明（列名、字面量…），给人看的上下文 */
  readonly detail?: string;
  /** 出错位置（字符下标）；语法错误才有 */
  readonly position?: number;

  constructor(code: ExpressionErrorCode, message: string, detail?: string, position?: number) {
    super(message);
    this.name = 'ExpressionError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
    if (position !== undefined) this.position = position;
  }
}

/**
 * 人话翻不过来的错误。
 *
 * 为什么要单独一类：翻不了的时候必须**明确说翻不了**，并且把已经翻出来的部分给人看。
 * 猜一个意思相近的表达式继续跑，用户就会拿着错的结果去改图 —— 那比"没听懂"糟得多。
 */
export class PlainChineseError extends Error {
  /** 用户原话 */
  readonly original: string;
  /** 已经翻出来的那一段（可能不完整，不能直接拿去当条件用） */
  readonly partial: string;
  /** 出错位置（字符下标） */
  readonly position: number;
  /** 为什么翻不了 */
  readonly reason: string;

  constructor(original: string, partial: string, position: number, reason: string) {
    super(
      `这句人话我没看懂：${original}\n` +
        `翻到这里就卡住了：${partial || '（一个字都没翻出来）'}\n` +
        `卡住的位置：第 ${position + 1} 个字符\n` +
        `原因：${reason}\n` +
        '请把条件改写成我能认的样子（字段名用 [列 名] 这种写法，中文关键词用「大于」「并且」「包含」等）。',
    );
    this.name = 'PlainChineseError';
    this.original = original;
    this.partial = partial;
    this.position = position;
    this.reason = reason;
  }
}
