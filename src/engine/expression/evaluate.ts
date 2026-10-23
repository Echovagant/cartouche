/**
 * 表达式求值：一行记录 + 一个 AST → 一个值。
 *
 * 两条硬规矩（都是"错得让人看得懂"）：
 *  1. **数字列和文字不许悄悄比**。类型对不上就报错，并说清"这一列是数字，'abc' 不是数字"。
 *     悄悄按字符串比出来的结果，会被用户拿去改图 —— 那比直接失败糟得多。
 *  2. **列名不存在就点名**。错在哪一列必须写在错误里，不能只说"求值失败"。
 *
 * NULL 按 SQL 的三值逻辑走：任何含 NULL 的比较结果都是 NULL（未知），
 * AND/OR 有短路规则。这样 `字段 IS NULL` 与 `字段 = NULL` 的区别才成立。
 */
import { ExpressionError, type ExprNode, type ExprValue } from './types.ts';

/** 求值出来的一边：值 + 它是什么 + 它从哪来（报错时要说清楚）。 */
interface Side {
  readonly value: ExprValue;
  /** 「数字」「文字」「空值」「布尔值」 */
  readonly typeName: string;
  /** 「「POP2020」这一列」「常量 1000」这样的出处 */
  readonly origin: string;
}

function typeNameOf(v: ExprValue): string {
  if (v === null) return '空值';
  if (typeof v === 'number') return '数字';
  if (typeof v === 'string') return '文字';
  return '布尔值';
}

/** 可用的函数清单（报错时列给人看）。 */
export const SUPPORTED_FUNCTIONS: readonly string[] = [
  'UPPER',
  'LOWER',
  'TRIM',
  'LENGTH',
  'ROUND',
  'ABS',
  'COALESCE',
  'CONCAT',
];

/** 行里的列名 → 值。大小写不敏感是 SQL 标识符的惯例，先精确匹配再退化。 */
function lookupField(
  row: Readonly<Record<string, unknown>>,
  name: string,
): { value: ExprValue; actualName: string } {
  const record = row as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, name)) {
    return { value: normalizeValue(record[name]), actualName: name };
  }
  const keys = Object.keys(record);
  const lower = name.toLowerCase();
  const hits = keys.filter((k) => k.toLowerCase() === lower);
  if (hits.length === 1) {
    return { value: normalizeValue(record[hits[0]!]), actualName: hits[0]! };
  }
  if (hits.length > 1) {
    throw new ExpressionError(
      'missing-field',
      `「${name}」这一列在这个图层里有好几个同名的（${hits.join('、')}），说不清指的是哪一个`,
    );
  }
  const hint = keys.length === 0 ? '（这个图层一列都没有）' : `这一层的列有：${keys.slice(0, 12).join('、')}${keys.length > 12 ? ' 等' : ''}`;
  throw new ExpressionError('missing-field', `这个图层里没有「${name}」这一列（${hint}）`);
}

/** 属性表里的值统一成四种：数字、文字、布尔、空值。 */
function normalizeValue(raw: unknown): ExprValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' || typeof raw === 'boolean') return raw;
  // 别的类型（对象、数组）没有明确的语义，当成空值而不是硬转成字符串
  return null;
}

/** 空值参与运算时的类型名（用于报错文案）。 */
function sideOf(node: ExprNode, value: ExprValue, row: Readonly<Record<string, unknown>>): Side {
  const typeName = typeNameOf(value);
  if (node.kind === 'field') {
    return { value, typeName, origin: `「${node.name}」这一列` };
  }
  if (node.kind === 'literal') {
    const shown = value === null ? '空值' : typeof value === 'string' ? `'${value}'` : String(value);
    return { value, typeName, origin: `常量（${shown}）` };
  }
  void row;
  return { value, typeName, origin: '这一边的计算结果' };
}

function requireNumber(side: Side, what: string): number {
  if (typeof side.value === 'number') return side.value;
  throw new ExpressionError(
    'type',
    `${what}：${side.origin}是${side.typeName}，不是数字（数字才能参与算术）`,
  );
}

function requireString(side: Side, fn: string): string {
  if (typeof side.value === 'string') return side.value;
  throw new ExpressionError(
    'type',
    `${fn} 只能处理文字：${side.origin}是${side.typeName}，不是文字`,
  );
}

/** LIKE 的通配符 → 正则。`%` 任意长，`_` 恰好一个字符。 */
function likeToRegExp(pattern: string): RegExp {
  let out = '^';
  for (const ch of pattern) {
    if (ch === '%') out += '[\\s\\S]*';
    else if (ch === '_') out += '[\\s\\S]';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  out += '$';
  // 大小写不敏感：跟 ArcGIS Pro 的定义查询一致（用户对 "Beijing"/"beijing" 的预期）
  return new RegExp(out, 'i');
}

/** 四舍五入（远离零），用十进制移位避免 2.675 这类二进制误差。 */
export function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const d = Math.trunc(digits);
  if (d === 0) return Math.sign(value) * Math.round(Math.abs(value));
  try {
    const shifted = Number(`${value}e${d}`);
    if (!Number.isFinite(shifted)) return value;
    const rounded = Math.sign(shifted) * Math.round(Math.abs(shifted));
    return Number(`${rounded}e${-d}`);
  } catch {
    const factor = 10 ** d;
    return (Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor;
  }
}

/**
 * 求值。
 *
 * @param node 表达式树
 * @param row 一条记录的属性字典
 */
export function evaluate(node: ExprNode, row: Readonly<Record<string, unknown>>): unknown {
  return evalNode(node, row).value;
}

function evalNode(node: ExprNode, row: Readonly<Record<string, unknown>>): Side {
  switch (node.kind) {
    case 'literal':
      return sideOf(node, node.value, row);

    case 'field': {
      const found = lookupField(row, node.name);
      return sideOf(node, found.value, row);
    }

    case 'unary': {
      if (node.op === 'NOT') {
        const inner = evalNode(node.operand, row);
        if (inner.value === null) return { value: null, typeName: '空值', origin: inner.origin };
        if (typeof inner.value !== 'boolean') {
          throw new ExpressionError(
            'type',
            `NOT 只能用在"是/不是"这种判断上：${inner.origin}是${inner.typeName}`,
          );
        }
        return { value: !inner.value, typeName: '布尔值', origin: inner.origin };
      }
      const inner = evalNode(node.operand, row);
      if (inner.value === null) return { value: null, typeName: '空值', origin: inner.origin };
      const n = requireNumber(inner, '取负号');
      return { value: node.op === '-' ? -n : n, typeName: '数字', origin: inner.origin };
    }

    case 'binary':
      return evalBinary(node, row);

    case 'call':
      return evalCall(node, row);

    case 'in':
      return evalIn(node, row);

    case 'between':
      return evalBetween(node, row);

    case 'like':
      return evalLike(node, row);

    case 'isnull': {
      const inner = evalNode(node.operand, row);
      const isNull = inner.value === null;
      return {
        value: node.negated ? !isNull : isNull,
        typeName: '布尔值',
        origin: inner.origin,
      };
    }

    default: {
      const never: never = node;
      throw new ExpressionError('syntax', `认不出来的表达式节点：${JSON.stringify(never)}`);
    }
  }
}

function evalBinary(
  node: Extract<ExprNode, { kind: 'binary' }>,
  row: Readonly<Record<string, unknown>>,
): Side {
  const op = node.op;

  // 逻辑运算要短路：AND 的左边为假时，右边根本不求值
  // （否则 "不存在 = 1 AND 字段 IS NULL" 这种写法会在左边就把错误抛出来）
  if (op === 'AND' || op === 'OR') {
    const left = evalNode(node.left, row);
    if (left.value === null) {
      // 未知参与 AND/OR：先把右边算出来，再按三值逻辑收口
      //   未知 AND 假 = 假    未知 AND 真 = 未知
      //   未知 OR  真 = 真    未知 OR  假 = 未知
      const right = evalNode(node.right, row);
      if (right.value === null) return { value: null, typeName: '空值', origin: left.origin };
      if (typeof right.value !== 'boolean') {
        throw new ExpressionError('type', `AND / OR 只能用在"是/不是"这种判断上：${right.origin}是${right.typeName}`);
      }
      const decided = op === 'AND' ? right.value === false : right.value === true;
      return {
        value: decided ? right.value : null,
        typeName: decided ? '布尔值' : '空值',
        origin: left.origin,
      };
    }
    if (typeof left.value !== 'boolean') {
      throw new ExpressionError(
        'type',
        `AND / OR 只能用在"是/不是"这种判断上：${left.origin}是${left.typeName}`,
      );
    }
    if (op === 'AND' && left.value === false) {
      return { value: false, typeName: '布尔值', origin: left.origin };
    }
    if (op === 'OR' && left.value === true) {
      return { value: true, typeName: '布尔值', origin: left.origin };
    }
    const right = evalNode(node.right, row);
    if (right.value === null) return { value: null, typeName: '空值', origin: right.origin };
    if (typeof right.value !== 'boolean') {
      throw new ExpressionError('type', `AND / OR 只能用在"是/不是"这种判断上：${right.origin}是${right.typeName}`);
    }
    return { value: right.value, typeName: '布尔值', origin: right.origin };
  }

  const left = evalNode(node.left, row);
  const right = evalNode(node.right, row);

  if (op === '+' || op === '-' || op === '*' || op === '/') {
    if (left.value === null || right.value === null) {
      return { value: null, typeName: '空值', origin: left.origin };
    }
    const a = requireNumber(left, '算术运算');
    const b = requireNumber(right, '算术运算');
    switch (op) {
      case '+':
        return { value: a + b, typeName: '数字', origin: left.origin };
      case '-':
        return { value: a - b, typeName: '数字', origin: left.origin };
      case '*':
        return { value: a * b, typeName: '数字', origin: left.origin };
      case '/':
        if (b === 0) {
          throw new ExpressionError('value', '除数为 0，这个值算不出来（先看看分母那一列）');
        }
        return { value: a / b, typeName: '数字', origin: left.origin };
      default:
        break;
    }
  }

  // 比较
  if (left.value === null || right.value === null) {
    return { value: null, typeName: '空值', origin: left.origin };
  }
  const bothNumbers = typeof left.value === 'number' && typeof right.value === 'number';
  const bothStrings = typeof left.value === 'string' && typeof right.value === 'string';
  const bothBooleans = typeof left.value === 'boolean' && typeof right.value === 'boolean';

  if (!bothNumbers && !bothStrings && !bothBooleans) {
    throw new ExpressionError(
      'type',
      `两边的类型对不上：${left.origin}是${left.typeName}，${right.origin}是${right.typeName}` +
        '（数字和文字不能放在一起比 —— 要比就先把两边变成同一种类型）',
    );
  }

  let cmp = 0;
  if (bothNumbers) cmp = (left.value as number) < (right.value as number) ? -1 : (left.value as number) > (right.value as number) ? 1 : 0;
  else if (bothStrings) cmp = (left.value as string) < (right.value as string) ? -1 : (left.value as string) > (right.value as string) ? 1 : 0;
  else cmp = (left.value as boolean) === (right.value as boolean) ? 0 : 1;

  let result: boolean;
  switch (op) {
    case '=':
      result = cmp === 0;
      break;
    case '<>':
      result = cmp !== 0;
      break;
    case '<':
      result = cmp < 0;
      break;
    case '<=':
      result = cmp <= 0;
      break;
    case '>':
      result = cmp > 0;
      break;
    case '>=':
      result = cmp >= 0;
      break;
    default:
      throw new ExpressionError('syntax', `认不出来的运算符：${op}`);
  }
  return { value: result, typeName: '布尔值', origin: left.origin };
}

function evalCall(
  node: Extract<ExprNode, { kind: 'call' }>,
  row: Readonly<Record<string, unknown>>,
): Side {
  const name = node.name;
  const args = node.args.map((a) => evalNode(a, row));

  const arity = (min: number, max: number): void => {
    if (args.length < min || (max >= 0 && args.length > max)) {
      const range = max < 0 ? `至少 ${min} 个` : min === max ? `${min} 个` : `${min}~${max} 个`;
      throw new ExpressionError(
        'value',
        `函数 ${name} 要 ${range}参数，这里给了 ${args.length} 个`,
      );
    }
  };

  switch (name) {
    case 'UPPER': {
      arity(1, 1);
      const s = requireString(args[0]!, name);
      return { value: s.toUpperCase(), typeName: '文字', origin: args[0]!.origin };
    }
    case 'LOWER': {
      arity(1, 1);
      const s = requireString(args[0]!, name);
      return { value: s.toLowerCase(), typeName: '文字', origin: args[0]!.origin };
    }
    case 'TRIM': {
      arity(1, 1);
      const s = requireString(args[0]!, name);
      return { value: s.trim(), typeName: '文字', origin: args[0]!.origin };
    }
    case 'LENGTH': {
      arity(1, 1);
      const s = requireString(args[0]!, name);
      // 按字符数算，不是字节数：中文列名按字节算会多出一倍
      return { value: Array.from(s).length, typeName: '数字', origin: args[0]!.origin };
    }
    case 'ROUND': {
      arity(1, 2);
      const n = requireNumber(args[0]!, name);
      const digits = args.length === 2 ? requireNumber(args[1]!, name) : 0;
      return { value: roundTo(n, digits), typeName: '数字', origin: args[0]!.origin };
    }
    case 'ABS': {
      arity(1, 1);
      const n = requireNumber(args[0]!, name);
      return { value: Math.abs(n), typeName: '数字', origin: args[0]!.origin };
    }
    case 'COALESCE': {
      arity(1, -1);
      for (const a of args) {
        if (a.value !== null) return { value: a.value, typeName: a.typeName, origin: a.origin };
      }
      return { value: null, typeName: '空值', origin: args[0]!.origin };
    }
    case 'CONCAT': {
      arity(1, -1);
      // NULL 当空串：拼字段时最常遇到的就是某列为空，
      // 直接把整条结果变成 NULL 反而更没用。
      const joined = args.map((a) => (a.value === null ? '' : String(a.value))).join('');
      return { value: joined, typeName: '文字', origin: args[0]!.origin };
    }
    default:
      throw new ExpressionError(
        'unknown-function',
        `不认识这个函数：${name}（能用的是：${SUPPORTED_FUNCTIONS.join('、')}）`,
      );
  }
}

function evalIn(
  node: Extract<ExprNode, { kind: 'in' }>,
  row: Readonly<Record<string, unknown>>,
): Side {
  const operand = evalNode(node.operand, row);
  let sawNull = false;
  for (const item of node.list) {
    const other = evalNode(item, row);
    if (operand.value === null || other.value === null) {
      sawNull = true;
      continue;
    }
    const same =
      typeof operand.value === 'number' && typeof other.value === 'number'
        ? operand.value === other.value
        : typeof operand.value === 'string' && typeof other.value === 'string'
          ? operand.value === other.value
          : typeof operand.value === 'boolean' && typeof other.value === 'boolean'
            ? operand.value === other.value
            : (() => {
                throw new ExpressionError(
                  'type',
                  `IN 清单里的类型对不上：${operand.origin}是${operand.typeName}，${other.origin}是${other.typeName}`,
                );
              })();
    if (same) {
      return { value: !node.negated, typeName: '布尔值', origin: operand.origin };
    }
  }
  if (sawNull) return { value: null, typeName: '空值', origin: operand.origin };
  return { value: node.negated, typeName: '布尔值', origin: operand.origin };
}

function evalBetween(
  node: Extract<ExprNode, { kind: 'between' }>,
  row: Readonly<Record<string, unknown>>,
): Side {
  const operand = evalNode(node.operand, row);
  const low = evalNode(node.low, row);
  const high = evalNode(node.high, row);
  if (operand.value === null || low.value === null || high.value === null) {
    return { value: null, typeName: '空值', origin: operand.origin };
  }
  const check = (bound: Side): number => {
    if (typeof operand.value === 'number' && typeof bound.value === 'number') {
      return operand.value < bound.value ? -1 : operand.value > bound.value ? 1 : 0;
    }
    if (typeof operand.value === 'string' && typeof bound.value === 'string') {
      return operand.value < bound.value ? -1 : operand.value > bound.value ? 1 : 0;
    }
    throw new ExpressionError(
      'type',
      `BETWEEN 的两端类型对不上：${operand.origin}是${operand.typeName}，${bound.origin}是${bound.typeName}`,
    );
  };
  const c1 = check(low);
  const c2 = check(high);
  const inside = c1 >= 0 && c2 <= 0;
  return { value: node.negated ? !inside : inside, typeName: '布尔值', origin: operand.origin };
}

function evalLike(
  node: Extract<ExprNode, { kind: 'like' }>,
  row: Readonly<Record<string, unknown>>,
): Side {
  const operand = evalNode(node.operand, row);
  const patternSide = evalNode(node.pattern, row);
  if (operand.value === null || patternSide.value === null) {
    return { value: null, typeName: '空值', origin: operand.origin };
  }
  if (typeof operand.value !== 'string') {
    throw new ExpressionError(
      'type',
      `LIKE 只能匹配文字：${operand.origin}是${operand.typeName}`,
    );
  }
  if (typeof patternSide.value !== 'string') {
    throw new ExpressionError(
      'type',
      `LIKE 的模式必须是文字：${patternSide.origin}是${patternSide.typeName}`,
    );
  }
  const pattern = node.wrap === 'both' ? `%${patternSide.value}%` : patternSide.value;
  const matched = likeToRegExp(pattern).test(operand.value);
  return { value: node.negated ? !matched : matched, typeName: '布尔值', origin: operand.origin };
}
