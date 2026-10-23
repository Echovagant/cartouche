/**
 * 表达式词法分析：把一段文本切成记号。
 *
 * 为什么一个词法器要同时认 SQL 与中文：
 * 用户写的条件里常常是混着的 ——「人口 大于 1000 AND 名称 LIKE '%城%'」。
 * 如果中文与 SQL 各走一套词法，中英混写就会在两套规则之间反复横跳，
 * 翻出来的条件不再是用户写的那句话。与其猜，不如一个词法器把两种写法都认了，
 * 让解析器按同一套优先级去解释。
 *
 * 中文关键词的识别规则（重要，改动前先想清楚）：
 *  1. **最长匹配优先**：「不等于」要盖过「等于」，「不为空」要盖过「不为」。
 *  2. 中文没有词边界，所以关键词会切碎含关键字的字段名（字段名「和平」里的「和」）。
 *     这是刻意的取舍：宁可让用户写 `[和平]`，也不能把「和平」当成两个记号去猜。
 *     方括号里的内容原样取用，不参与关键词匹配。
 *  3. 英文关键字带**词边界**：`notebook` 是一个字段名，不是 `NOT` + `ebook`。
 */
import { ExpressionError } from './types.ts';

export type TokenKind =
  | 'number'
  | 'string'
  | 'ident'
  | 'op'
  | 'punct'
  | 'keyword'
  | 'cn'
  | 'eof';

/** 中文短语承担的语义。 */
export type CnKind =
  /** 比较运算符短语（「等于」「大于」…），sql 里直接是运算符文本 */
  | 'op'
  /** 「不是」：既能是二元「不等于」，也能是一元「非」——由解析器按位置决定 */
  | 'not-eq'
  /** 「为空」「是空的」 */
  | 'is-null'
  /** 「不为空」「不是空的」 */
  | 'is-not-null'
  /** 「包含」 */
  | 'like'
  /** 「不包含」 */
  | 'not-like'
  /** 「在」（「在 X 到 Y 之间」） */
  | 'between'
  /** 「不在」 */
  | 'not-between'
  /** 「之间」 */
  | 'between-end'
  /** 「到」「至」（区间里的连接词） */
  | 'sep';

export interface Token {
  readonly kind: TokenKind;
  /** 原始文本（拼回 SQL 时用） */
  readonly text: string;
  /** 在源串中的起止下标 */
  readonly start: number;
  readonly end: number;
  /** 数字值 */
  readonly num?: number;
  /** 字符串值 */
  readonly str?: string;
  /** 运算符文本 */
  readonly op?: string;
  /** 标识符的列名原文（方括号里的内容或裸标识符） */
  readonly name?: string;
  /** 关键字（大写规范化） */
  readonly kw?: string;
  /** 中文短语的语义 */
  readonly cn?: CnKind;
  /** 中文短语对应的 SQL 写法 */
  readonly sql?: string;
}

/** 英文关键字表。全部大写匹配。 */
const KEYWORDS: Readonly<Record<string, string>> = {
  AND: 'AND',
  OR: 'OR',
  NOT: 'NOT',
  IN: 'IN',
  BETWEEN: 'BETWEEN',
  LIKE: 'LIKE',
  IS: 'IS',
  NULL: 'NULL',
  TRUE: 'TRUE',
  FALSE: 'FALSE',
};

/**
 * 中文短语表。
 *
 * 顺序无关（匹配时按长度从长到短试），但同一位置能同时匹配多条时，
 * 这里靠"更长的一定更具体"来收敛 —— 例如「不是空的」必须赢过「不是」。
 *
 * 为什么没有「和」「或」之外的连接词别名：多认一个词就多一次猜错的机会，
 * 认不准就报错让人改，比替人做主安全。
 */
const CN_PHRASES: readonly { readonly phrase: string; readonly cn: CnKind; readonly sql: string }[] = [
  { phrase: '不是空的', cn: 'is-not-null', sql: 'IS NOT NULL' },
  { phrase: '不为空', cn: 'is-not-null', sql: 'IS NOT NULL' },
  { phrase: '是空的', cn: 'is-null', sql: 'IS NULL' },
  { phrase: '为空', cn: 'is-null', sql: 'IS NULL' },
  { phrase: '不包含', cn: 'not-like', sql: 'NOT LIKE' },
  { phrase: '包含', cn: 'like', sql: 'LIKE' },
  { phrase: '不等于', cn: 'op', sql: '<>' },
  { phrase: '大于等于', cn: 'op', sql: '>=' },
  { phrase: '小于等于', cn: 'op', sql: '<=' },
  { phrase: '不低于', cn: 'op', sql: '>=' },
  { phrase: '不高于', cn: 'op', sql: '<=' },
  { phrase: '不小于', cn: 'op', sql: '>=' },
  { phrase: '不大于', cn: 'op', sql: '<=' },
  { phrase: '大于', cn: 'op', sql: '>' },
  { phrase: '小于', cn: 'op', sql: '<' },
  { phrase: '超过', cn: 'op', sql: '>' },
  { phrase: '低于', cn: 'op', sql: '<' },
  { phrase: '等于', cn: 'op', sql: '=' },
  { phrase: '是', cn: 'op', sql: '=' },
  { phrase: '不是', cn: 'not-eq', sql: '<>' },
  { phrase: '不在', cn: 'not-between', sql: 'NOT BETWEEN' },
  { phrase: '在', cn: 'between', sql: 'BETWEEN' },
  { phrase: '之间', cn: 'between-end', sql: '' },
  { phrase: '到', cn: 'sep', sql: '' },
  { phrase: '至', cn: 'sep', sql: '' },
  { phrase: '并且', cn: 'op', sql: 'AND' },
  { phrase: '同时', cn: 'op', sql: 'AND' },
  { phrase: '且', cn: 'op', sql: 'AND' },
  { phrase: '和', cn: 'op', sql: 'AND' },
  { phrase: '或者', cn: 'op', sql: 'OR' },
  { phrase: '或', cn: 'op', sql: 'OR' },
];

/** 按长度降序排好的中文短语表（最长匹配优先）。 */
const CN_BY_LENGTH: readonly (typeof CN_PHRASES)[number][] = [...CN_PHRASES].sort(
  (a, b) => b.phrase.length - a.phrase.length,
);

/** 是否是 CJK 汉字（扩展 A 也算）。 */
export function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf)
  );
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch) || isCjk(ch);
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch) || isCjk(ch);
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * 匹配英文关键字。
 *
 * 为什么要词边界：`notebook` 是一个字段名，如果只按前缀认关键字，
 * 它会被切成 `NOT` + `ebook`，条件直接读不懂。
 */
function matchKeyword(src: string, i: number): { kw: string; len: number } | null {
  for (const name of Object.keys(KEYWORDS)) {
    if (src.length < i + name.length) continue;
    const slice = src.slice(i, i + name.length);
    if (slice.toUpperCase() !== name) continue;
    const next = src[i + name.length];
    // 词边界：后面不能再接标识符字符
    if (next !== undefined && /[A-Za-z0-9_]/.test(next)) continue;
    return { kw: KEYWORDS[name]!, len: name.length };
  }
  return null;
}

/** 匹配中文短语（最长优先）。 */
function matchCnPhrase(src: string, i: number): { cn: CnKind; sql: string; len: number } | null {
  for (const entry of CN_BY_LENGTH) {
    if (!src.startsWith(entry.phrase, i)) continue;
    return { cn: entry.cn, sql: entry.sql, len: entry.phrase.length };
  }
  return null;
}

/** 多字符运算符（长的先试）。 */
const OPERATORS: readonly string[] = ['<>', '!=', '<=', '>=', '=', '<', '>', '+', '-', '*', '/'];

function syntaxError(src: string, pos: number, reason: string): ExpressionError {
  const near = src.slice(Math.max(0, pos - 10), Math.min(src.length, pos + 10));
  return new ExpressionError(
    'syntax',
    `表达式这里读不懂（第 ${pos + 1} 个字符附近：${near.trim() || '（空）'}）：${reason}`,
    `位置 ${pos}`,
    pos,
  );
}

/**
 * 切词。
 *
 * @throws {ExpressionError} code='syntax'：遇到认不出来的字符。
 */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;

    if (isSpace(ch)) {
      i += 1;
      continue;
    }

    // 字符串：'…' "…" 以及中文用户常打的全角引号
    if (ch === "'" || ch === '"' || ch === '“' || ch === '‘') {
      const start = i;
      const close = ch === '“' ? '”' : ch === '‘' ? '’' : ch;
      i += 1;
      let value = '';
      for (;;) {
        if (i >= src.length) throw syntaxError(src, start, '字符串没有收尾的引号');
        const c = src[i]!;
        if (c === close) {
          // SQL 风格的 '' 转义：'it''s' → it's
          if (src[i + 1] === close) {
            value += close;
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
      tokens.push({ kind: 'string', text: src.slice(start, i), start, end: i, str: value });
      continue;
    }

    // 方括号字段名：[列 名]
    if (ch === '[') {
      const start = i;
      const end = src.indexOf(']', i + 1);
      if (end < 0) throw syntaxError(src, start, '方括号没有闭合');
      const name = src.slice(i + 1, end);
      if (name.trim() === '') throw syntaxError(src, start, '方括号里没有列名');
      i = end + 1;
      tokens.push({ kind: 'ident', text: src.slice(start, i), start, end: i, name });
      continue;
    }

    // 数字
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const start = i;
      while (i < src.length && /[0-9]/.test(src[i]!)) i += 1;
      if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        i += 1;
        while (i < src.length && /[0-9]/.test(src[i]!)) i += 1;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        const save = i;
        i += 1;
        if (src[i] === '+' || src[i] === '-') i += 1;
        if (/[0-9]/.test(src[i] ?? '')) {
          while (i < src.length && /[0-9]/.test(src[i]!)) i += 1;
        } else {
          i = save;
        }
      }
      const text = src.slice(start, i);
      const num = Number(text);
      if (!Number.isFinite(num)) throw syntaxError(src, start, `数字 ${text} 认不出来`);
      tokens.push({ kind: 'number', text, start, end: i, num });
      continue;
    }

    // 标识符 / 关键字 / 中文短语
    if (isIdentStart(ch)) {
      const kw = matchKeyword(src, i);
      if (kw) {
        tokens.push({
          kind: 'keyword',
          text: src.slice(i, i + kw.len),
          start: i,
          end: i + kw.len,
          kw: kw.kw,
        });
        i += kw.len;
        continue;
      }
      const cn = matchCnPhrase(src, i);
      if (cn) {
        tokens.push({
          kind: 'cn',
          text: src.slice(i, i + cn.len),
          start: i,
          end: i + cn.len,
          cn: cn.cn,
          sql: cn.sql,
        });
        i += cn.len;
        continue;
      }
      // 标识符：遇到关键词边界就断开（中文关键词会切碎字段名，
      // 这是刻意取舍 —— 用 [方括号] 写完整列名即可）
      const start = i;
      while (i < src.length) {
        const c = src[i]!;
        if (!isIdentChar(c)) break;
        if (matchCnPhrase(src, i)) break;
        if (matchKeyword(src, i)) break;
        i += 1;
      }
      const text = src.slice(start, i);
      tokens.push({ kind: 'ident', text, start, end: i, name: text });
      continue;
    }

    // 括号与逗号
    if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ kind: 'punct', text: ch, start: i, end: i + 1, op: ch });
      i += 1;
      continue;
    }

    // 运算符
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      tokens.push({ kind: 'op', text: op, start: i, end: i + op.length, op: op === '!=' ? '<>' : op });
      i += op.length;
      continue;
    }

    throw syntaxError(src, i, `认不出来的字符「${ch}」`);
  }

  tokens.push({ kind: 'eof', text: '', start: src.length, end: src.length });
  return tokens;
}

/**
 * 这段文本里有没有中文关键词。
 *
 * 用途：判断用户写的是「人话」还是「SQL」。
 * 判定依据是**关键词**而不是「有没有汉字」——
 * 「人口 > 1000」里全是汉字，但它就是 SQL（列名恰好是中文）。
 */
export function containsChineseKeyword(src: string): boolean {
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (!isCjk(ch)) continue;
    const cn = matchCnPhrase(src, i);
    if (cn) return true;
  }
  return false;
}

/**
 * 把记号流按"中文片段"翻成 SQL 片段。
 *
 * 只在**报错时**用：给用户看"已经翻到这一步"，
 * 所以它不保证结构完整（区间写法翻不完整），只保证不编造内容。
 */
export function rewriteTokens(tokens: readonly Token[]): string {
  const parts: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'eof') break;
    if (t.kind === 'cn') {
      parts.push(t.sql ?? '');
    } else {
      parts.push(t.text);
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
