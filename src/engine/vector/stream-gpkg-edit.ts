/**
 * 超大 GeoPackage 的原生写操作：加字段、改属性、删要素。
 *
 * 常规路径把整层要素读进内存再整层写回，GB 级文件会耗尽内存。
 * GeoPackage 底层是 SQLite，这三类操作都能用原生 SQL 原地完成：
 *
 *  - 加字段：`ALTER TABLE ADD COLUMN` + `UPDATE ... SET 新列 = 表达式`；
 *  - 改属性：`UPDATE ... SET 列 = 值 ... WHERE 条件`；
 *  - 删要素：`DELETE ... WHERE 条件`（keep=first/last 用主键定位要留的那条）。
 *
 * 每条路都遵守同一套底线：
 *  - 写盘之前先备份（-wal 先并回主库），失败可回退；
 *  - 写盘之前先做类型 / 空值参数 / 除数检查，不静默转换；
 *  - 条件与表达式由 sql-expression.ts 翻译，口径与引擎一致；
 *  - 写完重新探测，并用样例核对（普通路径是逐条核对，这里如实写明"抽样"）。
 */
import type { OpValueResult } from '../ops/executor.ts';
import { evaluate, type ExprNode } from '../expression/index.ts';
import {
  coerceForColumn,
} from '../feature/common.ts';
import { backupGpkg } from './gpkg-native.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { WorkspaceAdapter } from '../workspace/index.ts';
import { probeLayer, referencedFields } from './read.ts';
import type { StreamSetTarget } from './stream-types.ts';
import { VectorError, type LayerInfo } from './types.ts';
import {
  gpkgCheckpoint,
  gpkgCount,
  gpkgExec,
  gpkgQuery,
  gpkgTableContext,
  quoteIdent,
  touchGpkgLastChange,
  type GpkgTableContext,
} from './gpkg-native.ts';
import {
  compileAssignmentSql,
  compileNewColumnSql,
  compileWhereSql,
  makeSqlContext,
  sqlLiteral,
  type SqlCompileContext,
} from './sql-expression.ts';

/** 抽样的条数：预览与写后核对都看这几条 */
const SAMPLE_LIMIT = 3;

/* ── 公共底座 ────────────────────────────────────────────────── */

/** 改之前先并 -wal 再备份；没有备份就不动手 */
async function prepareWrite(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  targetRel: string,
  absPath: string,
  label: string,
): Promise<string> {
  return backupGpkg(loc, store, targetRel, absPath, label);
}

/** 写盘步骤统一收口：任何一步失败，消息里都要带上备份路径 */
async function runWriteSteps<T>(
  backupPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new VectorError(
      `${message}（改动可能已部分生效，备份在 ${backupPath}）`,
    );
  }
}

/** 把多个编译上下文里的检查项合起来（WHERE 与各个表达式各有一份） */
function mergeContexts(contexts: readonly SqlCompileContext[]): SqlCompileContext {
  const merged = makeSqlContext([], null);
  for (const ctx of contexts) {
    for (const [key, check] of ctx.fieldChecks) merged.fieldChecks.set(key, check);
    merged.nullArgChecks.push(...ctx.nullArgChecks);
    merged.divisors.push(...ctx.divisors);
  }
  return merged;
}

/** 拼 COUNT 的条件（空条件不参与） */
function whereParts(parts: readonly (string | null | undefined)[]): string {
  const list = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  return list.length > 0 ? list.join(' AND ') : '';
}

/**
 * 写盘前的三类检查。
 *
 * 它们对应普通路径会在逐条求值时遇到的错误：
 *  - 数字列里混进文字（SQL 会悄悄当 0）；
 *  - 文字列里混进数字（SQL 会悄悄转文字）；
 *  - 函数参数为空（普通路径在第一条上就抛错）；
 *  - 除数为 0（普通路径会抛错，SQLite 会返回空值）。
 */
async function runPreflights(
  loc: GdalLocation,
  absPath: string,
  table: GpkgTableContext,
  contexts: readonly SqlCompileContext[],
): Promise<void> {
  const merged = mergeContexts(contexts);

  for (const check of merged.fieldChecks.values()) {
    const bad =
      check.kind === 'number'
        ? `typeof(${check.sql}) NOT IN ('integer','real')`
        : `typeof(${check.sql}) <> 'text'`;
    const n = await gpkgCount(
      loc,
      absPath,
      table.layerName,
      whereParts([check.guard, `${check.sql} IS NOT NULL`, bad]),
    );
    if (n > 0) {
      throw new VectorError(
        `「${check.name}」这一列里有 ${n} 个值不是${check.kind === 'number' ? '数字' : '文字'}。` +
          '超大文件走数据库原生计算，不做静默转换；请先修数据，或把文件拆小后用普通路径处理。',
      );
    }
  }

  const seenNull = new Set<string>();
  for (const check of merged.nullArgChecks) {
    const key = `${check.guard}\u0000${check.sql}`;
    if (seenNull.has(key)) continue;
    seenNull.add(key);
    const n = await gpkgCount(
      loc,
      absPath,
      table.layerName,
      whereParts([check.guard, `${check.sql} IS NULL`]),
    );
    if (n > 0) {
      throw new VectorError(
        `函数 ${check.fn} 的参数里有 ${n} 个空值；普通路径会在这些行上报错，所以这次没有写盘。` +
          '请先用 COALESCE 补一个默认值，或把文件拆小后再处理。',
      );
    }
  }

  const seenDiv = new Set<string>();
  for (const divisor of merged.divisors) {
    const key = `${divisor.guard}\u0000${divisor.sql}`;
    if (seenDiv.has(key)) continue;
    seenDiv.add(key);
    const n = await gpkgCount(
      loc,
      absPath,
      table.layerName,
      whereParts([
        divisor.guard,
        `${divisor.sql} IS NOT NULL`,
        `${divisor.sql} = 0`,
      ]),
    );
    if (n > 0) {
      throw new VectorError(
        `除数在 ${n} 条要素上是 0，这个值算不出来（先看看分母那一列）。`,
      );
    }
  }
}

/** 一条抽样行：主键 + 原始列 + SQL 算出来的表达式值 */
interface SampleRow {
  readonly fid: number;
  readonly properties: Record<string, unknown>;
  readonly sqlValues: readonly unknown[];
}

/** 取几条命中行，同时取 SQL 算出来的表达式值（用于写前口径核对） */
async function fetchSamples(
  loc: GdalLocation,
  absPath: string,
  table: GpkgTableContext,
  whereSql: string | null,
  columns: readonly string[],
  exprSqls: readonly string[],
): Promise<SampleRow[]> {
  const select: string[] = [quoteIdent(table.fidColumn)];
  for (const col of columns) select.push(quoteIdent(col));
  exprSqls.forEach((sql, i) => select.push(`(${sql}) AS ${quoteIdent(`__v${i}`)}`));
  const where = whereSql && whereSql !== 'NULL' ? ` WHERE ${whereSql}` : '';
  const sql =
    `SELECT ${select.join(', ')} FROM ${quoteIdent(table.layerName)}${where} ` +
    `ORDER BY ${quoteIdent(table.fidColumn)} LIMIT ${SAMPLE_LIMIT}`;
  const rows = await gpkgQuery(loc, absPath, sql);
  return rows.map((row) => {
    const properties: Record<string, unknown> = {};
    const sqlValues: unknown[] = [];
    for (const [key, value] of Object.entries(row)) {
      if (key === '__fid') continue;
      if (/^__v\d+$/.test(key)) {
        sqlValues[Number(key.slice(3))] = value;
      } else {
        properties[key] = value;
      }
    }
    return {
      fid: Number(row['__fid']),
      properties,
      sqlValues,
    };
  });
}

/** 数字按相对误差比（数据库与 JS 的浮点舍入可能差最后几位） */
function sameNumber(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * scale;
}

/** 抽样核对：SQL 算出来的值与 JS 逐条算出来的值是否一致 */
function sameSampleValue(want: unknown, got: unknown): boolean {
  const normalize = (v: unknown): string | number | boolean | null => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
    return String(v);
  };
  const w = normalize(want);
  const g = normalize(got);
  if (w === null || g === null) return w === g;
  if (typeof w === 'number' && typeof g === 'number') return sameNumber(w, g);
  if (typeof w === 'boolean' || typeof g === 'boolean') {
    const wb = typeof w === 'boolean' ? w : w === 1;
    const gb = typeof g === 'boolean' ? g : g === 1;
    return wb === gb;
  }
  return String(w) === String(g);
}

/* ── 加字段 ──────────────────────────────────────────────────── */

export interface StreamAddFieldInput {
  readonly targetRel: string;
  readonly absPath: string;
  readonly info: LayerInfo;
  readonly fieldName: string;
  readonly exprNode: ExprNode;
  readonly whereNode: ExprNode | null;
  /** 表达式/条件是否用到 AREA 伪列（普通路径已经判定过） */
  readonly areaPseudo: boolean;
  /** 面积换算：坐标单位 → 米 */
  readonly metersPerUnit: number;
  readonly dryRun: boolean;
}

/** 原生加字段（会写盘；dryRun 时只数不写） */
export async function gpkgStreamAddField(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  input: StreamAddFieldInput,
): Promise<OpValueResult> {
  const table = await gpkgTableContext(loc, input.absPath, input.info.layerName);
  const areaSql = input.areaPseudo
    ? areaSqlFor(table, input.metersPerUnit)
    : null;

  const whereCtx = makeSqlContext(input.info.fields, areaSql);
  const whereSql = input.whereNode ? compileWhereSql(input.whereNode, whereCtx) : null;

  const exprCtx = makeSqlContext(input.info.fields, areaSql);
  const compiled = compileNewColumnSql(
    input.exprNode,
    exprCtx,
    input.fieldName,
    whereSql ?? '1=1',
  );

  await runPreflights(loc, input.absPath, table, [exprCtx, whereCtx]);

  const total = await gpkgCount(loc, input.absPath, table.layerName);
  const updated = await gpkgCount(loc, input.absPath, table.layerName, whereSql ?? undefined);

  const streamNote = '超大图层用数据库原生计算，不整层重写';
  if (input.dryRun) {
    const notes = ['预演：没有写盘', streamNote];
    if (input.areaPseudo) notes.push('AREA 按平方米');
    return {
      kind: 'value',
      summary:
        `将加字段「${input.fieldName}」：${updated} 条要素会赋值（共 ${total} 条）` +
        `（${notes.join('；')}）`,
      data: {
        target: input.targetRel,
        fieldName: input.fieldName,
        requestedName: input.fieldName,
        updated,
        total,
        columnType: compiled.columnType,
        dryRun: true,
        streamed: true,
      },
    };
  }

  const backupPath = await prepareWrite(loc, store, input.targetRel, input.absPath, 'addfield');
  await runWriteSteps(backupPath, async () => {
    await gpkgExec(
      loc,
      input.absPath,
      `ALTER TABLE ${quoteIdent(table.layerName)} ` +
        `ADD COLUMN ${quoteIdent(input.fieldName)} ${compiled.columnType}`,
    );
    const whereClause = whereSql ? ` WHERE ${whereSql}` : '';
    await gpkgExec(
      loc,
      input.absPath,
      `UPDATE ${quoteIdent(table.layerName)} ` +
        `SET ${quoteIdent(input.fieldName)} = ${compiled.sql}${whereClause}`,
    );
    await touchGpkgLastChange(loc, input.absPath, table.layerName);
    await gpkgCheckpoint(loc, input.absPath);
  });

  // ── 写完核对：列在不在、样例值对不对 ─────────────────────────
  const after = await probeLayer(loc, input.absPath);
  const written = after.fields.find(
    (f) => f.name.toLowerCase() === input.fieldName.toLowerCase(),
  );
  if (!written) {
    throw new VectorError(
      `写完之后没有找到「${input.fieldName}」这一列（文件里现在有：` +
        `${after.fields.map((f) => f.name).join('、') || '（一列都没有）'}）。备份在 ${backupPath}`,
    );
  }
  const checkRows = await fetchSamples(
    loc,
    input.absPath,
    table,
    whereSql,
    [],
    [compiled.sql],
  );
  for (const row of checkRows) {
    const gotRow = await gpkgQuery(
      loc,
      input.absPath,
      `SELECT ${quoteIdent(written.name)} AS ${quoteIdent('__got')} ` +
        `FROM ${quoteIdent(table.layerName)} ` +
        `WHERE ${quoteIdent(table.fidColumn)} = ${row.fid}`,
    );
    const got = gotRow[0]?.__got ?? null;
    const want = row.sqlValues[0] ?? null;
    if (!sameSampleValue(want, got)) {
      throw new VectorError(
        `写完之后抽样核对对不上（fid=${row.fid}：算出来是 ${JSON.stringify(want)}，` +
          `文件里是 ${JSON.stringify(got)}）。备份在 ${backupPath}`,
      );
    }
  }
  const afterCount = await gpkgCount(loc, input.absPath, table.layerName);
  if (whereSql) {
    // 条件之外的行必须保持空值；SQLite 的 WHERE 本身可靠，这里再数一遍
    const leaked = await gpkgCount(
      loc,
      input.absPath,
      table.layerName,
      `(${whereSql}) IS NOT TRUE AND ${quoteIdent(written.name)} IS NOT NULL`,
    );
    if (leaked > 0) {
      throw new VectorError(
        `写完之后发现 ${leaked} 条不符合条件的要素也被赋了值。备份在 ${backupPath}`,
      );
    }
  }

  const caveats: string[] = [];
  if (updated === 0) caveats.push('没有任何要素符合条件，这一列全是空值');
  if (input.areaPseudo) caveats.push('「AREA」是要素面积，单位平方米');
  if (compiled.resultKind === 'bool') caveats.push('判断结果按 1 / 0 存进整数列');
  if (compiled.resultKind === 'number') caveats.push('新列按浮点数（REAL）存');
  caveats.push(
    checkRows.length > 0
      ? `抽样核对了 ${checkRows.length} 条，不是逐条核对`
      : '没有可核对的样例（这一列没有命中任何要素）',
  );

  return {
    kind: 'value',
    summary:
      `已加字段「${written.name}」：${updated} 条要素赋了值（共 ${afterCount} 条）` +
      `（${streamNote}）` +
      (caveats.length > 0 ? `（${caveats.join('；')}）` : ''),
    data: {
      target: input.targetRel,
      fieldName: written.name,
      requestedName: input.fieldName,
      updated,
      total: afterCount,
      columnType: compiled.columnType,
      backupPath,
      streamed: true,
    },
  };
}

/** AREA 伪列的 SQL：ST_Area(几何列) × 单位换算² */
function areaSqlFor(table: GpkgTableContext, metersPerUnit: number): string {
  if (!table.geometryColumn) {
    throw new VectorError('这个图层没有几何列，算不了 AREA。');
  }
  const type = (table.geometryType ?? '').toUpperCase();
  const polygon = type.includes('POLYGON') || type.includes('SURFACE');
  if (!polygon) {
    throw new VectorError(
      `这一层的几何类型是 ${table.geometryType ?? '未知'}，不是面要素，没有面积可算` +
        '（AREA 只对面要素有意义）。',
    );
  }
  const factor = Number(metersPerUnit);
  return `ST_Area(${quoteIdent(table.geometryColumn)}) * ${factor} * ${factor}`;
}

/* ── 改属性 ──────────────────────────────────────────────────── */

export interface StreamSetAttributesInput {
  readonly targetRel: string;
  readonly absPath: string;
  readonly info: LayerInfo;
  readonly whereSource: string;
  readonly whereNode: ExprNode;
  readonly targets: readonly StreamSetTarget[];
  readonly dryRun: boolean;
}

/** 原生批量改属性（会写盘；dryRun 时只算不写） */
export async function gpkgStreamSetAttributes(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  input: StreamSetAttributesInput,
): Promise<OpValueResult> {
  const table = await gpkgTableContext(loc, input.absPath, input.info.layerName);
  const whereCtx = makeSqlContext(input.info.fields, null);
  const whereSql = compileWhereSql(input.whereNode, whereCtx);

  const exprContexts: SqlCompileContext[] = [];
  interface Assignment {
    readonly target: StreamSetTarget;
    readonly sql: string;
    readonly expression: boolean;
    /** 表达式在抽样 SQL 里的下标（字面值没有） */
    readonly exprIndex?: number;
  }
  const assignments: Assignment[] = [];
  const exprSqls: string[] = [];
  for (const target of input.targets) {
    if (target.value.kind === 'literal') {
      const coerced = coerceForColumn(target.value.value, target.kind, target.name);
      assignments.push({ target, sql: sqlLiteral(coerced), expression: false });
      continue;
    }
    const refs = referencedFields(target.value.node);
    const clash = input.targets.find(
      (other) =>
        other !== target &&
        refs.some((name) => name.toLowerCase() === other.name.toLowerCase()),
    );
    if (clash) {
      throw new VectorError(
        `超大文件里，一个表达式不能引用同一次要改的其它列（「${target.name}」引用了「${clash.name}」）；` +
          '请拆成两次操作。',
      );
    }
    const ctx = makeSqlContext(input.info.fields, null);
    const sql = compileAssignmentSql(
      target.value.node,
      ctx,
      target.kind,
      target.name,
      whereSql,
    );
    exprContexts.push(ctx);
    const exprIndex = exprSqls.length;
    exprSqls.push(sql);
    assignments.push({ target, sql, expression: true, exprIndex });
  }

  await runPreflights(loc, input.absPath, table, [whereCtx, ...exprContexts]);

  const total = await gpkgCount(loc, input.absPath, table.layerName);
  const hits = await gpkgCount(loc, input.absPath, table.layerName, whereSql);
  if (hits === 0) {
    throw new VectorError(
      `条件没有命中任何要素（0 条命中）：「${input.whereSource}」。` +
        `这一层一共 ${total} 条要素。` +
        `可能是条件太严，也可能是字段名写错了。`,
    );
  }

  // ── 抽样：按引擎的口径逐条算一遍（预览卡与写后核对都用它） ──
  const refNames: string[] = [];
  for (const name of referencedFields(input.whereNode)) refNames.push(name);
  for (const target of input.targets) {
    if (target.value.kind !== 'expression') continue;
    for (const name of referencedFields(target.value.node)) refNames.push(name);
  }
  const columns: string[] = [];
  for (const name of refNames) {
    const real = input.info.fields.find(
      (f) => f.name.toLowerCase() === name.toLowerCase(),
    );
    if (real && !columns.includes(real.name)) columns.push(real.name);
  }
  const samples = await fetchSamples(
    loc,
    input.absPath,
    table,
    whereSql,
    columns,
    exprSqls,
  );

  const evaluated: Array<{
    fid: number;
    values: Record<string, string | number | boolean | null>;
  }> = [];
  for (const sample of samples) {
    const props: Record<string, unknown> = { ...sample.properties };
    const values: Record<string, string | number | boolean | null> = {};
    for (const target of input.targets) {
      const raw =
        target.value.kind === 'literal'
          ? target.value.value
          : evaluate(target.value.node, props);
      const value = coerceForColumn(raw, target.kind, target.name);
      props[target.name] = value;
      values[target.name] = value;
    }
    evaluated.push({ fid: sample.fid, values });
  }

  // 写盘之前核对：SQL 算出来的值与 JS 算出来的值必须一致
  for (const assignment of assignments) {
    if (assignment.exprIndex === undefined) continue;
    for (let i = 0; i < samples.length; i += 1) {
      const sqlValue = samples[i]!.sqlValues[assignment.exprIndex] ?? null;
      const jsValue = evaluated[i]?.values[assignment.target.name] ?? null;
      if (!sameSampleValue(jsValue, sqlValue)) {
        throw new VectorError(
          `「${assignment.target.name}」的表达式在数据库里的算法与引擎口径对不上` +
            `（抽样第 ${i + 1} 条：引擎算 ${JSON.stringify(jsValue)}，数据库算 ${JSON.stringify(sqlValue)}）。` +
            '已停止，没有写盘。这个写法暂时只能对小文件用。',
        );
      }
    }
  }

  const fields = input.targets.map((t) => t.name);
  if (input.dryRun) {
    return {
      kind: 'value',
      summary:
        `将改 ${hits} 条要素的 ${input.targets.length} 个字段（${fields.join('、')}）` +
        `（共 ${total} 条，预演：没有写盘；超大图层用数据库原生 SQL）`,
      data: {
        target: input.targetRel,
        where: input.whereSource,
        updated: hits,
        total,
        fields,
        values: Object.fromEntries(
          input.targets.map((t) => [
            t.name,
            t.value.kind === 'literal'
              ? coerceForColumn(t.value.value, t.kind, t.name)
              : evaluated[0]?.values[t.name] ?? null,
          ]),
        ),
        samples: evaluated.slice(0, SAMPLE_LIMIT),
        dryRun: true,
        streamed: true,
      },
    };
  }

  const backupPath = await prepareWrite(loc, store, input.targetRel, input.absPath, 'setattrs');
  const setSql = assignments
    .map((a) => `${quoteIdent(a.target.name)} = ${a.sql}`)
    .join(', ');
  await runWriteSteps(backupPath, async () => {
    await gpkgExec(
      loc,
      input.absPath,
      `UPDATE ${quoteIdent(table.layerName)} SET ${setSql} WHERE ${whereSql}`,
    );
    await touchGpkgLastChange(loc, input.absPath, table.layerName);
    await gpkgCheckpoint(loc, input.absPath);
  });

  // ── 写后核对：条数不变，抽样值对得上 ─────────────────────────
  const afterTotal = await gpkgCount(loc, input.absPath, table.layerName);
  if (afterTotal !== total) {
    throw new VectorError(
      `改完之后要素数不对：原来 ${total} 条，现在 ${afterTotal} 条。备份在 ${backupPath}`,
    );
  }
  if (evaluated.length > 0) {
    const ids = evaluated.map((e) => e.fid).join(', ');
    const cols = fields.map((f) => quoteIdent(f)).join(', ');
    const rows = await gpkgQuery(
      loc,
      input.absPath,
      `SELECT ${quoteIdent(table.fidColumn)} AS ${quoteIdent('__fid')}, ${cols} ` +
        `FROM ${quoteIdent(table.layerName)} WHERE ${quoteIdent(table.fidColumn)} IN (${ids})`,
    );
    for (const row of rows) {
      const fid = Number(row[table.fidColumn] ?? row['__fid']);
      const want = evaluated.find((e) => e.fid === fid);
      if (!want) continue;
      for (const name of fields) {
        const got = row[name] ?? null;
        if (!sameSampleValue(want.values[name], got)) {
          throw new VectorError(
            `写完之后抽样核对对不上（fid=${fid} 的「${name}」：要写 ` +
              `${JSON.stringify(want.values[name])}，文件里是 ${JSON.stringify(got)}）。备份在 ${backupPath}`,
          );
        }
      }
    }
  }

  const caveats: string[] = [];
  const rounded = assignments.reduce((count, a) => {
    if (
      a.target.value.kind === 'literal' &&
      a.target.kind === 'integer' &&
      typeof a.target.value.value === 'number' &&
      Number.isFinite(a.target.value.value) &&
      Math.round(a.target.value.value) !== a.target.value.value
    ) {
      return count + hits;
    }
    if (a.expression && a.target.kind === 'integer') {
      caveats.push(`「${a.target.name}」是整数列，小数按四舍五入写入`);
    }
    return count;
  }, 0);
  if (rounded > 0) caveats.push(`${rounded} 处小数被四舍五入成了整数（这一列是整数列）`);
  caveats.push(
    evaluated.length > 0
      ? `抽样核对了 ${evaluated.length} 条，不是逐条核对`
      : '没有可核对的样例',
  );

  return {
    kind: 'value',
    summary:
      `已改 ${hits} 条要素的 ${input.targets.length} 个字段（${fields.join('、')}）` +
      `（共 ${afterTotal} 条）` +
      (caveats.length > 0 ? `（${caveats.join('；')}）` : ''),
    data: {
      target: input.targetRel,
      where: input.whereSource,
      updated: hits,
      total: afterTotal,
      fields,
      values: Object.fromEntries(
        input.targets.map((t) => [
          t.name,
          t.value.kind === 'literal'
            ? coerceForColumn(t.value.value, t.kind, t.name)
            : evaluated[0]?.values[t.name] ?? null,
        ]),
      ),
      backupPath,
      ...(rounded > 0 ? { rounded } : {}),
      streamed: true,
    },
  };
}

/* ── 删要素 ──────────────────────────────────────────────────── */

export interface StreamDeleteInput {
  readonly targetRel: string;
  readonly absPath: string;
  readonly info: LayerInfo;
  readonly whereSource: string;
  readonly whereNode: ExprNode;
  readonly keep: string;
  readonly dryRun: boolean;
}

/** 原生按条件删要素（会写盘；dryRun 时只数不写） */
export async function gpkgStreamDelete(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  input: StreamDeleteInput,
): Promise<OpValueResult> {
  const table = await gpkgTableContext(loc, input.absPath, input.info.layerName);
  const whereCtx = makeSqlContext(input.info.fields, null);
  const whereSql = compileWhereSql(input.whereNode, whereCtx);
  await runPreflights(loc, input.absPath, table, [whereCtx]);

  const total = await gpkgCount(loc, input.absPath, table.layerName);
  const matched = await gpkgCount(loc, input.absPath, table.layerName, whereSql);
  if (matched === 0) {
    throw new VectorError(
      `条件没有命中任何要素（0 条命中）：「${input.whereSource}」。` +
        `这一层一共 ${total} 条要素，一条都没删。` +
        `可能是条件太严，也可能是字段名写错了。`,
    );
  }

  let deleted = matched;
  let kept: { readonly fid: number; readonly reason: string } | null = null;
  let keepFid: number | null = null;
  if (input.keep === 'first' || input.keep === 'last') {
    const order = input.keep === 'first' ? 'ASC' : 'DESC';
    const rows = await gpkgQuery(
      loc,
      input.absPath,
      `SELECT ${quoteIdent(table.fidColumn)} AS ${quoteIdent('__fid')} ` +
        `FROM ${quoteIdent(table.layerName)} WHERE ${whereSql} ` +
        `ORDER BY ${quoteIdent(table.fidColumn)} ${order} LIMIT 1`,
    );
    const raw = rows[0]?.['__fid'];
    const fid = Number(raw);
    if (!Number.isFinite(fid)) {
      throw new VectorError('没能找到要保留的那一条要素（主键读不出来），这次没有删。');
    }
    keepFid = fid;
    deleted = matched - 1;
    kept = {
      fid,
      reason:
        input.keep === 'first'
          ? `keep=first：保留第一条（fid=${fid}）`
          : `keep=last：保留最后一条（fid=${fid}）`,
    };
    if (deleted === 0) {
      throw new VectorError(
        `条件命中 ${matched} 条，但按 keep=${input.keep} 的规则要留下 1 条 —— 实际一条也删不掉。`,
      );
    }
  } else if (input.keep === 'largest') {
    throw new VectorError(
      '超大文件暂不支持 keep=largest（要逐条算面积来比大小，等于把几何全过一遍）。' +
        '请改用 keep=first / keep=last，或先把范围拆小再删。',
    );
  }

  if (deleted === total) {
    throw new VectorError(
      `这个条件会删掉图层里的全部 ${total} 条要素（等于清空图层）。` +
        '引擎不写空的属性表（字段定义会一起丢），所以这一步停下了。' +
        '想留一部分就加 keep（first / last），想清空请直接新建一个空图层。',
    );
  }

  const remaining = total - deleted;
  if (input.dryRun) {
    return {
      kind: 'value',
      summary:
        `将删掉 ${deleted} 条要素（命中 ${matched} 条，共 ${total} 条）` +
        (kept ? `；${kept.reason}` : '') +
        '（预演：没有写盘；超大图层用数据库原生删除）',
      data: {
        target: input.targetRel,
        where: input.whereSource,
        keep: input.keep,
        matched,
        deleted,
        remaining,
        total,
        ...(kept ? { kept } : {}),
        dryRun: true,
        streamed: true,
      },
    };
  }

  const backupPath = await prepareWrite(loc, store, input.targetRel, input.absPath, 'delete');
  const keepClause =
    keepFid !== null ? ` AND ${quoteIdent(table.fidColumn)} <> ${keepFid}` : '';
  await runWriteSteps(backupPath, async () => {
    await gpkgExec(
      loc,
      input.absPath,
      `DELETE FROM ${quoteIdent(table.layerName)} WHERE ${whereSql}${keepClause}`,
    );
    await touchGpkgLastChange(loc, input.absPath, table.layerName);
    await gpkgCheckpoint(loc, input.absPath);
  });

  const afterTotal = await gpkgCount(loc, input.absPath, table.layerName);
  if (afterTotal !== remaining) {
    throw new VectorError(
      `删完之后要素数不对：应该剩 ${remaining} 条，实际 ${afterTotal} 条。备份在 ${backupPath}`,
    );
  }

  return {
    kind: 'value',
    summary:
      `已删掉 ${deleted} 条要素（命中 ${matched} 条，共 ${total} 条）` +
      (kept ? `；${kept.reason}` : '') +
      `，剩下 ${afterTotal} 条（超大图层用数据库原生删除）`,
    data: {
      target: input.targetRel,
      where: input.whereSource,
      keep: input.keep,
      matched,
      deleted,
      remaining: afterTotal,
      total,
      ...(kept ? { kept } : {}),
      backupPath,
      streamed: true,
    },
  };
}
