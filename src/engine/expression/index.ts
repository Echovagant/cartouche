/**
 * 表达式引擎的出口。
 *
 * 两个入口，一个求值器：
 *  - `parseExpression` / `evaluate`：SQL 入口（也认中文关键词，因为词法器是同一个）
 *  - `translatePlainChinese`：人话入口，翻成 SQL
 *  - `evaluateExpression`：两个入口合一的便捷写法（人话会自动先翻译）
 *
 * 为什么值得单独造一个引擎而不是直接用 GDAL 的 SQL：
 *  1. GDAL 的通用 SQL 方言**没有** UPPER/LOWER/TRIM/LENGTH/ROUND/ABS/COALESCE
 *     （实测 GDAL 3.13：Undefined function 'UPPER' used），人话条件里这些很常见；
 *  2. GDAL 的 SQL 会**悄悄把文字当数字比**，而本项目要求类型对不上必须报错；
 *  3. 人话那一层根本不是 GDAL 认识的东西。
 */
export { parseExpression, parseExpressionDetailed, literalText } from './parser.ts';
export { evaluate, roundTo, SUPPORTED_FUNCTIONS } from './evaluate.ts';
export { renderExpression, quoteField } from './render.ts';
export {
  translatePlainChinese,
  looksLikePlainChinese,
  containsCjkText,
  plainChineseFailure,
} from './plain.ts';
export { tokenize, containsChineseKeyword } from './lexer.ts';
export type { Token, TokenKind, CnKind } from './lexer.ts';
export {
  ExpressionError,
  PlainChineseError,
} from './types.ts';
export type {
  ExprNode,
  ExprValue,
  BinaryOp,
  LiteralNode,
  FieldNode,
  UnaryNode,
  BinaryNode,
  CallNode,
  InNode,
  BetweenNode,
  LikeNode,
  IsNullNode,
  ExpressionErrorCode,
} from './types.ts';

import { parseExpression } from './parser.ts';
import { evaluate } from './evaluate.ts';
import {
  containsCjkText,
  looksLikePlainChinese,
  plainChineseFailure,
  translatePlainChinese,
} from './plain.ts';

/**
 * 求值一行记录上的表达式。
 *
 * 人话会先翻译再解析；翻不了时抛的是 {@link PlainChineseError}（说清"没看懂"），
 * 而不是一条干巴巴的语法错误。
 */
export function evaluateExpression(
  src: string,
  row: Readonly<Record<string, unknown>>,
): unknown {
  return evaluate(parseExpression(toSql(src)), row);
}

/**
 * 把用户写的条件统一成 SQL 文本。
 *
 * 三条路径：
 *  1. 认得出中文关键词 → 当人话翻译（翻不了就报"没看懂"）；
 *  2. 直接当 SQL 读；
 *  3. 当 SQL 读不了、但文字里有汉字 → 多半是人话用词不在词表里，
 *     仍按"没看懂"报错（并说清卡在哪），免得用户去猜引擎到底认哪些词。
 */
export function toSql(src: string): string {
  if (looksLikePlainChinese(src)) return translatePlainChinese(src);
  try {
    parseExpression(src);
    return src;
  } catch (err) {
    if (containsCjkText(src)) throw plainChineseFailure(src, err);
    throw err;
  }
}
