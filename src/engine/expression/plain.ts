/**
 * 人话 → SQL。
 *
 * 这个模块只做一件事：**把人写的条件翻成引擎认得的 SQL，翻不了就明说翻不了。**
 *
 * 为什么不能"翻不了就猜一个"：
 * 属性查询与计算字段的结果会被用户拿去改图。猜错一次，用户拿着错的结果去改数据，
 * 那种错误比"没听懂"糟得多 —— "没听懂"用户会来问，猜错了用户不会。
 *
 * 所以这里的规矩是：
 *  - 认识的中文关键词照译（见 lexer.ts 的短语表）；
 *  - 不认识的**不猜**：整句报错，并给出"已经翻到这一步"的中间结果，让用户能看出卡在哪；
 *  - 同一个词有两种意思时（只有「不是」一个），按**它在句中的位置**判，不靠上下文猜。
 */
import { containsChineseKeyword, rewriteTokens, tokenize, type Token } from './lexer.ts';
import { parseExpressionDetailed } from './parser.ts';
import { renderExpression } from './render.ts';
import { ExpressionError, PlainChineseError } from './types.ts';

/** 出错位置之前的记号（用来拼"已经翻到这一步"）。 */
function tokensBefore(tokens: readonly Token[], position: number): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    if (t.kind === 'eof') break;
    if (t.start >= position) break;
    out.push(t);
  }
  return out;
}

/** 从错误里摘出"为什么"，别把位置重复说一遍。 */
function reasonOf(err: unknown): string {
  if (err instanceof ExpressionError) {
    const marker = '）：';
    const idx = err.message.indexOf(marker);
    return idx >= 0 ? err.message.slice(idx + marker.length) : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * 把一句人话翻成 SQL。
 *
 * @throws {PlainChineseError} 翻不了的时候。错误里带着原话、已翻出的部分与卡住的位置。
 */
export function translatePlainChinese(text: string): string {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new PlainChineseError(String(text ?? ''), '', 0, '条件是空的');
  }

  let tokens: readonly Token[] = [];
  try {
    const parsed = parseExpressionDetailed(text);
    tokens = parsed.tokens;
    return renderExpression(parsed.node);
  } catch (err) {
    throw plainChineseFailure(text, err, tokens);
  }
}

/**
 * 把"读不懂"包装成人话错误。
 *
 * 单独拆出来是因为还有一条路径也会读不懂：一句**没有中文关键词**的人话
 * （例如「人口 超出 500」——「超出」不在词表里）。那种情况先当 SQL 解析，
 * 解析失败后再转成同一种错误口径，用户看到的提示才不会一会儿一种说法。
 */
export function plainChineseFailure(
  text: string,
  err: unknown,
  knownTokens?: readonly Token[],
): PlainChineseError {
  const position =
    err instanceof ExpressionError && err.position !== undefined ? err.position : 0;
  let tokens: readonly Token[] = knownTokens ?? [];
  if (tokens.length === 0) {
    try {
      tokens = tokenize(text);
    } catch {
      // 词法阶段就失败了：没有记号流可翻，"已翻出的部分"只能是空的
      tokens = [];
    }
  }
  const partial = rewriteTokens(tokensBefore(tokens, position));
  return new PlainChineseError(text, partial, position, reasonOf(err));
}

/**
 * 判断一段文字是不是"人话"。
 *
 * 判定依据是**有没有中文关键词**，不是"有没有汉字"——
 * 「人口 > 1000」全是汉字，但它就是 SQL（列名恰好是中文）。
 */
export function looksLikePlainChinese(text: string): boolean {
  return containsChineseKeyword(text);
}

/**
 * 这段文字里有没有汉字。
 *
 * 用途：一段带汉字的文字读不成 SQL 时，多半是人话（用词不在词表里），
 * 这时应该按"人话没看懂"来报错，而不是甩一句干巴巴的语法错误。
 */
export function containsCjkText(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf)
    ) {
      return true;
    }
  }
  return false;
}
