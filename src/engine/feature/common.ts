/**
 * feature.* 三个 op 共用的底子：参数读取、列名定位、条件编译、值能不能写。
 *
 * 为什么单独一个文件：这三个 op 的骨架完全一样 ——
 * 读参数 → 探图层 → 编译条件 → 读要素 → 筛 → 改 → 写回 → 写后校验。
 * 骨架里最容易出错的是「用户说的列名 / 条件 / 值」与「文件里真实的列」对不上。
 * 抄三遍就会抄出三套口径：同一个错列名，在批量改属性里报一种话，在删除里报另一种话，
 * 用户看到的提示互相矛盾，反而更不知道该改哪里。这里定一份，三个 op 共用。
 *
 * 条件一律用仓库自己的表达式引擎算（toSql → parseExpression → matchesWhere），
 * 不交给 GDAL 的 `-where`：GDAL 通用 SQL 没有 UPPER/LOWER/TRIM/LENGTH/ROUND/ABS/COALESCE，
 * 而且会把文字悄悄当数字比 —— 与本项目「类型对不上必须报错」的口径相反。
 * 详细原因见 vector/read.ts 顶部的注释。
 */
import { parseExpression, toSql, type ExprNode } from '../expression/index.ts';
import { ExpressionError } from '../expression/types.ts';
import { matchesWhere, referencedFields } from '../vector/read.ts';
import { VectorError, type FeatureRecord, type LayerField } from '../vector/types.ts';

/** 读一个字符串参数；不给或给空串都算没给。 */
export function readString(
  params: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * 读一个必填的字符串参数。
 *
 * 缺参数时要说清「这个参数是干什么的」，而不只是「缺少参数 xxx」——
 * 前者用户能自己改，后者要回头翻文档。
 */
export function requireString(
  params: Readonly<Record<string, unknown>>,
  key: string,
  what: string,
): string {
  const v = readString(params, key);
  if (v === undefined) {
    throw new VectorError(`缺少参数 ${key}（${what}）`);
  }
  return v;
}

/** 读一个字符串数组参数；元素必须是非空字符串。 */
export function readStringArray(
  params: Readonly<Record<string, unknown>>,
  key: string,
): string[] | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new VectorError(`参数 ${key} 必须是数组`);
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || x.trim() === '') {
      throw new VectorError(`参数 ${key} 里只能放非空字符串`);
    }
    out.push(x);
  }
  return out;
}

/** 这一层有哪些列（写给人看的错误消息用）。 */
export function fieldNamesHint(fields: readonly LayerField[]): string {
  const names = fields.map((f) => f.name);
  if (names.length === 0) return '（这一层一列都没有）';
  const head = names.slice(0, 12).join('、');
  return names.length > 12 ? `${head} 等 ${names.length} 列` : head;
}

/** 列名定位的结果。 */
export interface ResolvedField {
  /** 文件里真实存在的列名（写回时用它，不是用户写的那一个）。 */
  readonly name: string;
  /** 用户写的列名原文（报错与报告里要说清"你写的是这个"）。 */
  readonly requested: string;
  /** 与请求名不一致时要交代一句（大小写不同 / Shapefile 截断）。 */
  readonly caveat?: string;
}

/**
 * `actual` 是不是 `requested` 被 Shapefile 截断后的样子。
 *
 * Shapefile 的列名上限是 **10 字节**。GDAL 截断时不会把一个多字节字符劈开，
 * 所以截断后的名字可能是 10 字节（ASCII）或更少（中文等，10 字节装不下一个整字）。
 *
 * 判定口径（不能简化成"实际名是请求名的前缀"）：
 * 候选列名必须是请求名的前缀，**并且**再往后加一个字符就超过 10 字节了。
 * 少了后半句，"NAMELONGX" 会命中 "NAME" —— 于是往错的列上写值，
 * 那比报错糟得多（会静默改错用户的字段）。
 */
export function isTruncatedName(actual: string, requested: string): boolean {
  if (actual === '' || requested.length <= actual.length) return false;
  if (!requested.toLowerCase().startsWith(actual.toLowerCase())) return false;
  const next = requested[actual.length];
  if (next === undefined) return false;
  return Buffer.byteLength(actual, 'utf8') + Buffer.byteLength(next, 'utf8') > 10;
}

/**
 * 把用户写的列名定位到图层里真实存在的列。
 *
 * 三级匹配，顺序不能换：
 *  1. 完全相同 —— 直接用。
 *  2. 只差大小写 —— SQL 标识符的惯例是大小写不敏感，用它，但要交代一句。
 *  3. 请求名是某一列的截断名（见 {@link isTruncatedName}）—— 用户手里的表结构
 *     可能是截断前的全名，这里认下来（并说明被截断成了什么），
 *     免得用户以为"这列不存在"。
 *
 * 找不到就返回 null，由调用方报错（错误消息里要列出这一层真有的列）。
 */
export function resolveFieldName(
  requested: string,
  fields: readonly LayerField[],
): ResolvedField | null {
  const exact = fields.find((f) => f.name === requested);
  if (exact) return { name: exact.name, requested };

  const ci = fields.find((f) => f.name.toLowerCase() === requested.toLowerCase());
  if (ci) {
    return {
      name: ci.name,
      requested,
      caveat: `列名大小写与图层里的「${ci.name}」不同，已按图层里的名字处理`,
    };
  }

  const truncated = fields.filter((f) => isTruncatedName(f.name, requested));
  if (truncated.length === 1) {
    const hit = truncated[0]!;
    return {
      name: hit.name,
      requested,
      caveat: `Shapefile 的列名被截断成「${hit.name}」，已按它处理`,
    };
  }
  return null;
}

/**
 * 编译条件，并把「条件里用到的列不存在」提前报出来。
 *
 * 为什么要提前：条件是逐条要素求值的，等到第 37 条要素才炸，
 * 用户看到的是「条件算不出来」，而不是「这一层没有『POP2020』这一列」。
 */
export function compileWhere(where: string, fields: readonly LayerField[]): ExprNode {
  const node = parseExpression(toSql(where));
  const missing = referencedFields(node).filter(
    (name) => !fields.some((f) => f.name.toLowerCase() === name.toLowerCase()),
  );
  if (missing.length > 0) {
    throw new VectorError(
      `条件里用到的列在这个图层里不存在：${missing.join('、')}（这一层的列有：${fieldNamesHint(fields)}）`,
    );
  }
  return node;
}

/**
 * 条件命中了哪些要素（返回下标）。
 *
 * 求值出错时补上「第几条要素」：条件里的类型错（比如数字列跟文字比大小）
 * 是整条条件的问题，但指出是哪一条要素出错，用户才查得动。
 */
export function matchIndexes(
  features: readonly FeatureRecord[],
  whereNode: ExprNode,
): number[] {
  const hits: number[] = [];
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i]!;
    let hit: boolean;
    try {
      hit = matchesWhere(whereNode, f.properties);
    } catch (err) {
      if (err instanceof ExpressionError) {
        throw new VectorError(`第 ${i + 1} 条要素上条件算不出来：${err.message}`, '', err);
      }
      throw err;
    }
    if (hit) hits.push(i);
  }
  return hits;
}

/** 这一列是什么类型的（够用即可，不追求覆盖 GDAL 的全部类型名）。 */
export type ColumnKind = 'integer' | 'real' | 'string' | 'date' | 'other';

/** 从 GDAL 的字段类型名判断列的类别。 */
export function columnKindOf(type: string): ColumnKind {
  const t = type.toLowerCase();
  if (t.includes('integer') || t === 'int' || t === 'int64') return 'integer';
  if (
    t.includes('real') || t.includes('float') || t.includes('double') ||
    t.includes('decimal') || t.includes('numeric')
  ) {
    return 'real';
  }
  if (t.includes('string') || t.includes('char') || t.includes('text')) return 'string';
  if (t.includes('date') || t.includes('time')) return 'date';
  return 'other';
}

/**
 * 这个值能不能写进这一列，写进去是什么样。
 *
 * 为什么按列的类型拦：GDAL 会"尽力而为"——把文字写进数字列可能变成 0，
 * 把数字写进文字列会变成 "5"。用户回头看到的是一张被悄悄改过的表，
 * 而报告里写的是"已改成 5"。这种"报告与文件对不上"是最难查的一类问题。
 *
 * 文字列收数字/布尔（转成文字）；数字列不收文字；日期列只收文字。
 */
export function coerceForColumn(
  value: unknown,
  kind: ColumnKind,
  column: string,
): string | number | boolean | null {
  if (value === null || value === undefined) return null;

  if (kind === 'integer' || kind === 'real') {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new VectorError(`「${column}」这一列是数字列，写不进 ${value}（不是有限数字）`);
      }
      // ⚠️ 整数列里的小数要在这里就取整，不能留给 GDAL：
      //    GDAL 是**按值推断列类型**的 —— 一列里出现小数，整层重写时这一列
      //    就从整数列变成小数列（用户只想改几个值，结果列的格式也变了）。
      //    自己取整，列类型就稳住了，取整这件事也在报告里说清楚。
      return kind === 'integer' ? Math.round(value) : value;
    }
    throw new VectorError(
      `「${column}」这一列是数字列，写不进${describeValue(value)}` +
        `（要往数字列写文字，先把这一列改成文字列）`,
    );
  }

  if (kind === 'date') {
    if (typeof value === 'string') return value;
    throw new VectorError(
      `「${column}」这一列是日期列，要写成日期文字，写不进${describeValue(value)}`,
    );
  }

  if (kind === 'string') {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    throw new VectorError(`「${column}」这一列是文字列，写不进${describeValue(value)}`);
  }

  // 类型认不准的列（少见）：只挡明显写不进去的东西
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new VectorError(`「${column}」这一列写不进 ${value}（不是有限数字）`);
    }
    return value;
  }
  throw new VectorError(
    `「${column}」这一列写不进${describeValue(value)}（只支持文字、数字、布尔、空值）`,
  );
}

/** 值的中文说法（写进错误消息里）。 */
export function describeValue(value: unknown): string {
  if (value === null || value === undefined) return '空值';
  if (typeof value === 'string') return `文字「${value}」`;
  if (typeof value === 'number') return `数字 ${value}`;
  if (typeof value === 'boolean') return `布尔值 ${value}`;
  return JSON.stringify(value);
}

/**
 * 两个值算不算一样（数字按数值比，其余按字符串比）。
 *
 * 空值与空串算一样：属性表里"这一格没填"有时读回来是 null、有时是空串，
 * 两者在用户眼里是同一件事。
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined || b === '';
  if (b === null || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return String(a) === String(b);
}

/**
 * 写回之后有没有哪一列的类型变了。
 *
 * 为什么会变：Shapefile 的列类型是**按值推断**的 ——
 * 整层都是整数就写成整数列，出现小数就写成小数列。
 * 写回是"把整层重写一遍"，所以删掉几条要素、或者把一列的值全改成整数，
 * 这一列的类型就会跟着变。用户以为只是改了几个值，结果列的格式也变了。
 *
 * 这不是 bug（是格式的规则），但必须说出来 —— 不说就是"报告与文件对不上"。
 */
export function columnTypeChanges(
  before: readonly LayerField[],
  after: readonly LayerField[],
): string[] {
  const notes: string[] = [];
  for (const b of before) {
    const a = after.find((f) => f.name.toLowerCase() === b.name.toLowerCase());
    if (!a) {
      notes.push(`「${b.name}」这一列写回之后不见了`);
      continue;
    }
    if (a.type.toLowerCase() !== b.type.toLowerCase()) {
      notes.push(
        `「${b.name}」这一列的类型从 ${b.type} 变成了 ${a.type}` +
          `（Shapefile 的列类型按值推断）`,
      );
    }
  }
  return notes;
}
