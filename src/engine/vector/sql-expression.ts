/**
 * 把仓库自己的表达式树翻成 SQLite 条件 / 值表达式。
 *
 * 为什么不能直接把用户写的条件塞给 GDAL：见 feature/common.ts 顶部 ——
 * GDAL 的 SQL 会悄悄把文字当数字比，本项目要求类型对不上必须报错。
 * 超大图层又必须交给数据库算（整层读进内存会耗尽内存），所以这里做一个
 * **口径对齐**的翻译层：
 *
 *  - 静态检查按图层声明的列类型做（数字列 vs 文字列先挡住）；
 *  - 运行时再套 `typeof(...)` 守卫，类型不对的行按空值处理（不静默转成 0/''）；
 *  - 发现的列类型异常由调用方在写盘前 COUNT 一遍，有异常就报错退出；
 *  - 除法强制转成浮点（SQLite 的 `5 / 2` 是整数除法，和引擎的 2.5 不一样）；
 *  - 除法分母为 0、函数参数为空值，也在写盘前数一遍，和普通路径一样报错。
 *
 * 支持的范围与限制写在各分支的注释里。超出范围的写法会明确报错，
 * 不会退化成一条"看着能跑"的 SQL。
 */
import { columnKindOf } from '../feature/common.ts';
import type { ExprNode } from '../expression/index.ts';
import { VectorError, type LayerField } from './types.ts';
import { quoteIdent, quoteLiteral } from './gpkg-native.ts';

/** 翻译结果的类型（静态推断，用来提前挡住类型对不上的写法） */
export type SqlKind = 'number' | 'text' | 'bool' | 'null' | 'unknown';

/** 引用到的真实列：写盘前要数一遍有没有类型异常的行 */
export interface SqlFieldCheck {
  readonly name: string;
  readonly sql: string;
  readonly kind: 'number' | 'text';
}

/** 函数参数为空值的检查（普通路径会在第一条空值上抛错，这里提前数清楚） */
export interface SqlNullCheck {
  readonly fn: string;
  readonly sql: string;
}

/** 一次编译的上下文：列定义、AREA 伪列、检查项收集 */
export interface SqlCompileContext {
  readonly fields: readonly LayerField[];
  /** AREA 伪列的 SQL（已含平方米换算）；不启用时为 null */
  readonly areaSql: string | null;
  /** 是否允许函数调用；超大文件的 WHERE 里不允许（避免与逐行求值的短路口径打架） */
  readonly allowFunctions: boolean;
  readonly fieldChecks: Map<string, SqlFieldCheck>;
  readonly nullArgChecks: SqlNullCheck[];
  /** 除法分母的 SQL（写盘前检查 0） */
  readonly divisors: string[];
}

/** 值表达式 */
interface SqlValue {
  readonly sql: string;
  readonly kind: SqlKind;
  /** 报错时怎么称呼这一边（「POP2020」这一列 / 常量（5）） */
  readonly origin: string;
  /** 这一边的结果会不会是空值（字面量能确定，其余按"会"处理） */
  readonly nullable: boolean;
}

/** 建一个编译上下文 */
export function makeSqlContext(
  fields: readonly LayerField[],
  areaSql: string | null,
  allowFunctions: boolean,
): SqlCompileContext {
  return {
    fields,
    areaSql,
    allowFunctions,
    fieldChecks: new Map(),
    nullArgChecks: [],
    divisors: [],
  };
}

/** 字段类型的中文说法 */
function kindName(kind: SqlKind): string {
  switch (kind) {
    case 'number':
      return '数字';
    case 'text':
      return '文字';
    case 'bool':
      return '布尔值';
    case 'null':
      return '空值';
    default:
      return '类型说不准的值';
  }
}

/** 运行时类型守卫：类型不对（或为空）时结果为 NULL，交给三值逻辑收口 */
function guardOf(v: SqlValue): string {
  if (v.kind === 'number') return `typeof(${v.sql}) IN ('integer','real')`;
  if (v.kind === 'text') return `typeof(${v.sql}) = 'text'`;
  if (v.kind === 'bool') return `typeof(${v.sql}) = 'integer'`;
  return '1';
}

/** 守卫成立才求值；否则给 NULL（保持引擎的"空值传播"） */
function caseWhen(guards: readonly string[], thenSql: string): string {
  return `(CASE WHEN ${guards.join(' AND ')} THEN ${thenSql} ELSE NULL END)`;
}

function typeMismatch(left: SqlValue, right: SqlValue): VectorError {
  return new VectorError(
    `两边的类型对不上：${left.origin}是${kindName(left.kind)}，${right.origin}是${kindName(right.kind)}` +
      '（数字和文字不能放在一起比 —— 要比就先把两边变成同一种类型）',
  );
}

/** 数值字面量的 SQL；非有限数在这里就拒绝 */
function numberSql(value: number): string {
  if (!Number.isFinite(value)) {
    throw new VectorError(`表达式里有不是有限数字的值：${value}`);
  }
  return String(value);
}

/** 引用一个真实列，并记下类型检查 */
function fieldValue(node: Extract<ExprNode, { kind: 'field' }>, ctx: SqlCompileContext): SqlValue {
  const real = ctx.fields.find((f) => f.name.toLowerCase() === node.name.toLowerCase());
  if (!real) {
    if (ctx.areaSql !== null && node.name.toUpperCase() === 'AREA') {
      return {
        sql: `(${ctx.areaSql})`,
        kind: 'number',
        origin: '「AREA」面积',
        nullable: true,
      };
    }
    throw new VectorError(`这一层没有「${node.name}」这一列`);
  }
  const kind = columnKindOf(real.type);
  const sql = quoteIdent(real.name);
  if (kind === 'integer' || kind === 'real') {
    ctx.fieldChecks.set(real.name.toLowerCase(), {
      name: real.name,
      sql,
      kind: 'number',
    });
    return { sql, kind: 'number', origin: `「${real.name}」这一列`, nullable: true };
  }
  if (kind === 'string' || kind === 'date') {
    ctx.fieldChecks.set(real.name.toLowerCase(), {
      name: real.name,
      sql,
      kind: 'text',
    });
    return { sql, kind: 'text', origin: `「${real.name}」这一列`, nullable: true };
  }
  throw new VectorError(
    `「${real.name}」这一列的类型（${real.type}）在超大文件里暂不支持参与表达式或条件；` +
      '请先把它转成文字 / 数字（vector.addField 或字段计算），或把文件拆小后再处理。',
  );
}

/** 编译一个值节点 */
function compileValue(node: ExprNode, ctx: SqlCompileContext): SqlValue {
  switch (node.kind) {
    case 'literal': {
      const value = node.value;
      if (value === null) {
        return { sql: 'NULL', kind: 'null', origin: '空值', nullable: true };
      }
      if (typeof value === 'number') {
        return {
          sql: numberSql(value),
          kind: 'number',
          origin: `常量（${value}）`,
          nullable: false,
        };
      }
      if (typeof value === 'string') {
        return {
          sql: quoteLiteral(value),
          kind: 'text',
          origin: `常量（'${value}'）`,
          nullable: false,
        };
      }
      return {
        sql: value ? '1' : '0',
        kind: 'bool',
        origin: `常量（${value ? 'TRUE' : 'FALSE'}）`,
        nullable: false,
      };
    }

    case 'field':
      return fieldValue(node, ctx);

    case 'unary': {
      if (node.op === 'NOT') {
        const inner = compileValue(node.operand, ctx);
        if (inner.kind !== 'bool' && inner.kind !== 'null') {
          throw new VectorError(
            `NOT 只能用在"是/不是"这种判断上：${inner.origin}是${kindName(inner.kind)}`,
          );
        }
        if (inner.kind === 'null') {
          return { sql: 'NULL', kind: 'null', origin: inner.origin, nullable: true };
        }
        return {
          sql: `(NOT (${inner.sql}))`,
          kind: 'bool',
          origin: inner.origin,
          nullable: true,
        };
      }
      const inner = compileValue(node.operand, ctx);
      if (inner.kind === 'null') {
        return { sql: 'NULL', kind: 'null', origin: inner.origin, nullable: true };
      }
      if (inner.kind !== 'number') {
        throw new VectorError(
          `取${node.op === '-' ? '负' : '正'}号只能用在数字上：${inner.origin}是${kindName(inner.kind)}`,
        );
      }
      return {
        sql: caseWhen([guardOf(inner)], `(${node.op}${inner.sql})`),
        kind: 'number',
        origin: inner.origin,
        nullable: true,
      };
    }

    case 'binary':
      return compileBinary(node, ctx);

    case 'call':
      return compileCall(node, ctx);

    case 'in':
      return compileIn(node, ctx);

    case 'between':
      return compileBetween(node, ctx);

    case 'like':
      return compileLike(node, ctx);

    case 'isnull': {
      const inner = compileValue(node.operand, ctx);
      return {
        sql: `((${inner.sql}) IS ${node.negated ? 'NOT ' : ''}NULL)`,
        kind: 'bool',
        origin: inner.origin,
        nullable: false,
      };
    }

    default: {
      const never: never = node;
      throw new VectorError(`认不出来的表达式节点：${JSON.stringify(never)}`);
    }
  }
}

/** 二元运算 */
function compileBinary(
  node: Extract<ExprNode, { kind: 'binary' }>,
  ctx: SqlCompileContext,
): SqlValue {
  const op = node.op;
  if (op === 'AND' || op === 'OR') {
    const left = compileValue(node.left, ctx);
    const right = compileValue(node.right, ctx);
    for (const side of [left, right]) {
      if (side.kind !== 'bool' && side.kind !== 'null') {
        throw new VectorError(
          `AND / OR 只能用在"是/不是"这种判断上：${side.origin}是${kindName(side.kind)}`,
        );
      }
    }
    if (left.kind === 'null' || right.kind === 'null') {
      // 与引擎一致：另一边若能否定结果，仍要按三值逻辑收口；交给 SQL 的 AND/OR 即可
    }
    return {
      sql: `((${left.sql}) ${op} (${right.sql}))`,
      kind: 'bool',
      origin: left.origin,
      nullable: true,
    };
  }

  const left = compileValue(node.left, ctx);
  const right = compileValue(node.right, ctx);
  if (op === '+' || op === '-' || op === '*' || op === '/') {
    if (left.kind === 'null' || right.kind === 'null') {
      return { sql: 'NULL', kind: 'null', origin: left.origin, nullable: true };
    }
    if (left.kind !== 'number' || right.kind !== 'number') {
      throw new VectorError(
        `算术运算只能用数字：${left.origin}是${kindName(left.kind)}，${right.origin}是${kindName(right.kind)}`,
      );
    }
    if (op === '/') {
      // SQLite 的整数相除会截断；强制转成浮点，和引擎的除法一致
      ctx.divisors.push(right.sql);
    }
    const body =
      op === '/'
        ? `(CAST(${left.sql} AS REAL) / (${right.sql}))`
        : `((${left.sql}) ${op} (${right.sql}))`;
    return {
      sql: caseWhen([guardOf(left), guardOf(right)], body),
      kind: 'number',
      origin: left.origin,
      nullable: true,
    };
  }

  // 比较
  if (left.kind === 'null' || right.kind === 'null') {
    return { sql: 'NULL', kind: 'null', origin: left.origin, nullable: true };
  }
  if (left.kind !== right.kind) throw typeMismatch(left, right);
  if (left.kind !== 'number' && left.kind !== 'text' && left.kind !== 'bool') {
    throw new VectorError(
      `两边的类型说不准，不能放在一起比：${left.origin} 与 ${right.origin}`,
    );
  }
  return {
    sql: caseWhen(
      [guardOf(left), guardOf(right)],
      `(${left.sql}) ${op} (${right.sql})`,
    ),
    kind: 'bool',
    origin: left.origin,
    nullable: true,
  };
}

/** 函数调用 */
function compileCall(
  node: Extract<ExprNode, { kind: 'call' }>,
  ctx: SqlCompileContext,
): SqlValue {
  if (!ctx.allowFunctions) {
    throw new VectorError(
      `超大文件的条件里暂不支持函数 ${node.name}（逐行求值与数据库短路顺序可能不一致）。` +
        '请把条件改写成不带动函数的比较，或把文件拆小后再处理。',
    );
  }
  const name = node.name;
  const args = node.args.map((arg) => compileValue(arg, ctx));
  const arity = (min: number, max: number): void => {
    if (args.length < min || (max >= 0 && args.length > max)) {
      const range = max < 0 ? `至少 ${min} 个` : min === max ? `${min} 个` : `${min}~${max} 个`;
      throw new VectorError(`函数 ${name} 要 ${range}参数，这里给了 ${args.length} 个`);
    }
  };
  const requireText = (arg: SqlValue): string => {
    if (arg.kind === 'null') {
      throw new VectorError(`函数 ${name} 的参数是空值（空值不能直接参与函数计算）`);
    }
    if (arg.kind !== 'text') {
      throw new VectorError(
        `${name} 只能处理文字：${arg.origin}是${kindName(arg.kind)}，不是文字`,
      );
    }
    if (arg.nullable) ctx.nullArgChecks.push({ fn: name, sql: arg.sql });
    return arg.sql;
  };
  const requireNumber = (arg: SqlValue): string => {
    if (arg.kind === 'null') {
      throw new VectorError(`函数 ${name} 的参数是空值（空值不能直接参与函数计算）`);
    }
    if (arg.kind !== 'number') {
      throw new VectorError(
        `${name} 只能处理数字：${arg.origin}是${kindName(arg.kind)}，不是数字`,
      );
    }
    if (arg.nullable) ctx.nullArgChecks.push({ fn: name, sql: arg.sql });
    return arg.sql;
  };

  switch (name) {
    case 'UPPER':
    case 'LOWER':
    case 'TRIM': {
      arity(1, 1);
      const sql = requireText(args[0]!);
      return {
        sql: caseWhen(["typeof(" + sql + ") = 'text'"], `${name}(${sql})`),
        kind: 'text',
        origin: args[0]!.origin,
        nullable: true,
      };
    }
    case 'LENGTH': {
      arity(1, 1);
      const sql = requireText(args[0]!);
      return {
        sql: caseWhen(["typeof(" + sql + ") = 'text'"], `length(${sql})`),
        kind: 'number',
        origin: args[0]!.origin,
        nullable: true,
      };
    }
    case 'ROUND': {
      arity(1, 2);
      const value = requireNumber(args[0]!);
      const digits = args.length === 2 ? requireNumber(args[1]!) : '0';
      return {
        sql: caseWhen(
          [`typeof(${value}) IN ('integer','real')`, `typeof(${digits}) IN ('integer','real')`],
          `round(${value}, ${digits})`,
        ),
        kind: 'number',
        origin: args[0]!.origin,
        nullable: true,
      };
    }
    case 'ABS': {
      arity(1, 1);
      const value = requireNumber(args[0]!);
      return {
        sql: caseWhen([`typeof(${value}) IN ('integer','real')`], `abs(${value})`),
        kind: 'number',
        origin: args[0]!.origin,
        nullable: true,
      };
    }
    case 'COALESCE': {
      arity(1, -1);
      const kinds = args.map((a) => a.kind).filter((k) => k !== 'null');
      const distinct = [...new Set(kinds)];
      const kind: SqlKind =
        distinct.length === 0 ? 'null' : distinct.length === 1 ? distinct[0]! : 'unknown';
      if (kind === 'null') {
        return { sql: 'NULL', kind: 'null', origin: 'COALESCE()', nullable: true };
      }
      if (kind === 'unknown') {
        throw new VectorError(
          'COALESCE 的几个参数类型不一致（数字与文字混在一起），超大文件里说不准要写进哪一列。' +
            '请先用类型一致的参数。',
        );
      }
      return {
        sql: `COALESCE(${args.map((a) => a.sql).join(', ')})`,
        kind,
        origin: args[0]!.origin,
        nullable: args.every((a) => a.nullable),
      };
    }
    case 'CONCAT': {
      arity(1, -1);
      // 数字转文字的位数格式在 JS 与 SQLite 里不完全一致（例如 5.0 → '5' / '5.0'）。
      // 为了避免静默写进不同的字符串，超大文件里只接文字参数。
      const parts = args.map((arg, i) => {
        if (arg.kind === 'null') return "''";
        if (arg.kind !== 'text') {
          throw new VectorError(
            `超大文件里 CONCAT 只接文字参数：第 ${i + 1} 个参数是${kindName(arg.kind)}。` +
              '请先把数字转成文字列，或把文件拆小后再处理。',
          );
        }
        return `COALESCE(${arg.sql}, '')`;
      });
      return {
        sql: `(${parts.join(' || ')})`,
        kind: 'text',
        origin: args[0]!.origin,
        nullable: false,
      };
    }
    default:
      throw new VectorError(`不认识这个函数：${name}`);
  }
}

/** IN / NOT IN */
function compileIn(
  node: Extract<ExprNode, { kind: 'in' }>,
  ctx: SqlCompileContext,
): SqlValue {
  const operand = compileValue(node.operand, ctx);
  if (operand.kind === 'null') {
    return { sql: 'NULL', kind: 'null', origin: operand.origin, nullable: true };
  }
  const items = node.list.map((item) => compileValue(item, ctx));
  for (const item of items) {
    if (item.kind === 'null') continue;
    if (item.kind !== operand.kind) throw typeMismatch(operand, item);
  }
  const guards = [guardOf(operand)];
  for (const item of items) {
    if (item.kind !== 'null') guards.push(guardOf(item));
  }
  const list = items.map((i) => i.sql).join(', ');
  return {
    sql: caseWhen(guards, `(${operand.sql}) ${node.negated ? 'NOT ' : ''}IN (${list})`),
    kind: 'bool',
    origin: operand.origin,
    nullable: true,
  };
}

/** BETWEEN / NOT BETWEEN */
function compileBetween(
  node: Extract<ExprNode, { kind: 'between' }>,
  ctx: SqlCompileContext,
): SqlValue {
  const operand = compileValue(node.operand, ctx);
  const low = compileValue(node.low, ctx);
  const high = compileValue(node.high, ctx);
  if (operand.kind === 'null' || low.kind === 'null' || high.kind === 'null') {
    return { sql: 'NULL', kind: 'null', origin: operand.origin, nullable: true };
  }
  if (low.kind !== operand.kind) throw typeMismatch(operand, low);
  if (high.kind !== operand.kind) throw typeMismatch(operand, high);
  if (operand.kind !== 'number' && operand.kind !== 'text') {
    throw new VectorError(`BETWEEN 只能用数字或文字：${operand.origin}是${kindName(operand.kind)}`);
  }
  return {
    sql: caseWhen(
      [guardOf(operand), guardOf(low), guardOf(high)],
      `(${operand.sql}) ${node.negated ? 'NOT ' : ''}BETWEEN (${low.sql}) AND (${high.sql})`,
    ),
    kind: 'bool',
    origin: operand.origin,
    nullable: true,
  };
}

/** LIKE / NOT LIKE */
function compileLike(
  node: Extract<ExprNode, { kind: 'like' }>,
  ctx: SqlCompileContext,
): SqlValue {
  const operand = compileValue(node.operand, ctx);
  const pattern = compileValue(node.pattern, ctx);
  if (operand.kind === 'null' || pattern.kind === 'null') {
    return { sql: 'NULL', kind: 'null', origin: operand.origin, nullable: true };
  }
  if (operand.kind !== 'text') {
    throw new VectorError(
      `LIKE 只能匹配文字：${operand.origin}是${kindName(operand.kind)}`,
    );
  }
  if (pattern.kind !== 'text') {
    throw new VectorError(
      `LIKE 的模式必须是文字：${pattern.origin}是${kindName(pattern.kind)}`,
    );
  }
  const patternSql =
    node.wrap === 'both' ? `('%' || (${pattern.sql}) || '%')` : `(${pattern.sql})`;
  return {
    sql: caseWhen(
      [guardOf(operand), guardOf(pattern)],
      `(${operand.sql}) ${node.negated ? 'NOT ' : ''}LIKE ${patternSql}`,
    ),
    kind: 'bool',
    origin: operand.origin,
    nullable: true,
  };
}

/** 编译一个条件（WHERE）：必须是能分出真假的表达式 */
export function compileWhereSql(node: ExprNode, ctx: SqlCompileContext): string {
  const value = compileValue(node, ctx);
  if (value.kind !== 'bool' && value.kind !== 'null') {
    throw new VectorError(
      `条件要能分出真假（写成「大于」「并且」这类判断），不能只是一个值：算出来是${kindName(value.kind)}`,
    );
  }
  return value.kind === 'null' ? 'NULL' : value.sql;
}

/**
 * 编译一个要写进某一列的值表达式。
 *
 * 按目标列的类别做与普通路径一致的收口：
 *  - 整数列：四舍五入（用 floor(x + 0.5)，和 JS 的 Math.round 一致）；
 *  - 小数列：转成浮点；
 *  - 文字 / 日期列：只接文字结果（数字转文字的位数口径两边不同，不静默硬转）。
 */
export function compileAssignmentSql(
  node: ExprNode,
  ctx: SqlCompileContext,
  targetKind: ReturnType<typeof columnKindOf>,
  column: string,
): string {
  const value = compileValue(node, ctx);
  if (value.kind === 'null') return 'NULL';
  if (targetKind === 'integer') {
    if (value.kind !== 'number') {
      throw new VectorError(
        `「${column}」这一列是数字列，表达式算出来是${kindName(value.kind)}，写不进去`,
      );
    }
    return `CAST(floor((${value.sql}) + 0.5) AS INTEGER)`;
  }
  if (targetKind === 'real') {
    if (value.kind !== 'number') {
      throw new VectorError(
        `「${column}」这一列是数字列，表达式算出来是${kindName(value.kind)}，写不进去`,
      );
    }
    return `CAST((${value.sql}) AS REAL)`;
  }
  if (targetKind === 'string' || targetKind === 'date') {
    if (value.kind !== 'text') {
      throw new VectorError(
        `「${column}」这一列是文字列，表达式算出来是${kindName(value.kind)}；` +
          '超大文件里不做数字转文字的自动转换（位数格式两边不一致），请先把表达式改成文字结果。',
      );
    }
    return value.sql;
  }
  throw new VectorError(
    `「${column}」这一列的类型在超大文件里暂不支持用表达式赋值；请改用字面值，或把文件拆小后再处理。`,
  );
}

/** 编译一个要写进新列的值表达式，并给出新列的 SQLite 类型 */
export function compileNewColumnSql(
  node: ExprNode,
  ctx: SqlCompileContext,
  column: string,
): { sql: string; columnType: 'REAL' | 'TEXT' | 'INTEGER'; resultKind: SqlKind } {
  const value = compileValue(node, ctx);
  if (value.kind === 'number') {
    return { sql: `CAST((${value.sql}) AS REAL)`, columnType: 'REAL', resultKind: 'number' };
  }
  if (value.kind === 'text') {
    return { sql: value.sql, columnType: 'TEXT', resultKind: 'text' };
  }
  if (value.kind === 'bool') {
    return { sql: `CAST((${value.sql}) AS INTEGER)`, columnType: 'INTEGER', resultKind: 'bool' };
  }
  if (value.kind === 'null') {
    throw new VectorError(
      `表达式「${column}」算出来全是空值，定不下这一列该是什么类型（超大文件需要先确定列类型）。`,
    );
  }
  throw new VectorError(
    '表达式的类型定不下来（混合了数字与文字），超大文件里没法决定新列的类型。请改用类型一致的表达式。',
  );
}

/** 把一个已经收口好的字面值变成 SQL 字面量 */
export function sqlLiteral(value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return numberSql(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return quoteLiteral(value);
}
