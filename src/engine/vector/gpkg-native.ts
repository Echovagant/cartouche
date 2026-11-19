/**
 * GeoPackage 原生 SQL 的底座。
 *
 * 超大图层的写操作不必整层读进内存：GeoPackage 底层是 SQLite，
 * 字段、属性、要素都在表里，`ALTER TABLE` / `UPDATE` / `DELETE`
 * 能原地完成，内存只跟命中条数有关，不跟文件体积有关。
 *
 * 这里只放三件事：标识符/字面量的引用、SQL 的执行与查询、WAL 收口。
 * **判断条件与表达式的口径不在这里** —— 那部分见 sql-expression.ts，
 * 它负责把仓库自己的表达式树翻成与引擎语义一致的 SQLite 条件。
 */
import { tools } from '../gdal/runner.ts';
import { createBackup } from '../gdal/writeback.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { WorkspaceAdapter } from '../workspace/index.ts';
import { VectorError } from './types.ts';

/** 能在超大文件上走原生 SQL 的格式；其它返回 null */
export function nativeSqlKind(absPath: string): 'gpkg' | null {
  return /\.gpkg$/i.test(absPath) ? 'gpkg' : null;
}

/** SQL 标识符引用：双引号加倍 */
export function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** SQL 字符串字面量：单引号加倍 */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** GeoPackage 一层里的原生结构信息 */
export interface GpkgTableContext {
  readonly layerName: string;
  /** 主键列（GPKG 规范要求一层有一个整数主键） */
  readonly fidColumn: string;
  /** 几何列；非空间表为 null */
  readonly geometryColumn: string | null;
  /** 几何类型（POLYGON / LINESTRING / POINT / GEOMETRY …）；非空间表为 null */
  readonly geometryType: string | null;
}

/** 执行一条会改数据的 SQL；失败时带上 GDAL 的最后一行原因 */
export async function gpkgExec(
  loc: GdalLocation,
  absPath: string,
  sql: string,
): Promise<void> {
  const res = await tools(loc).ogrInfo(['-q', '-dialect', 'SQLite', '-sql', sql, absPath]);
  if (!res.ok) {
    throw new VectorError(
      `GeoPackage 原生 SQL 执行失败：${lastLine(res.stderr) || '未知原因'}`,
      res.stderr,
    );
  }
}

/** 执行一条查询，返回结果的属性行（不取几何） */
export async function gpkgQuery(
  loc: GdalLocation,
  absPath: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const res = await tools(loc).ogrInfo([
    '-json',
    '-features',
    '-dialect',
    'SQLite',
    '-sql',
    sql,
    absPath,
  ]);
  if (!res.ok) {
    throw new VectorError(
      `GeoPackage 查询失败：${lastLine(res.stderr) || '未知原因'}`,
      res.stderr,
    );
  }
  let parsed: {
    layers?: {
      features?: { properties?: Record<string, unknown>; fid?: unknown }[];
    }[];
  };
  try {
    parsed = JSON.parse(res.stdout) as typeof parsed;
  } catch {
    throw new VectorError('GeoPackage 查询返回的不是合法 JSON', res.stdout);
  }
  const features = parsed.layers?.[0]?.features ?? [];
  // GDAL 把主键放在 feature 的顶层 "fid" 里，不在 properties 里；
  // 统一收进 __fid，查询方不用再关心这个差异。
  return features.map((f) => ({ ...(f.properties ?? {}), __fid: f.fid }));
}

/** 数一行 COUNT 查询 */
export async function gpkgCount(
  loc: GdalLocation,
  absPath: string,
  layerName: string,
  whereSql?: string,
): Promise<number> {
  const where = whereSql && whereSql.trim() !== '' ? ` WHERE ${whereSql}` : '';
  const rows = await gpkgQuery(
    loc,
    absPath,
    `SELECT COUNT(*) AS n FROM ${quoteIdent(layerName)}${where}`,
  );
  const raw = rows[0] ? rows[0]['n'] : 0;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    throw new VectorError('没能数出这个图层的要素数（查询结果里没有 COUNT）');
  }
  return n;
}

/** 读一层的原生结构：主键列、几何列与几何类型 */
export async function gpkgTableContext(
  loc: GdalLocation,
  absPath: string,
  layerName: string,
): Promise<GpkgTableContext> {
  const pkRows = await gpkgQuery(
    loc,
    absPath,
    `SELECT name FROM pragma_table_info(${quoteLiteral(layerName)}) WHERE pk = 1`,
  );
  const fidColumn =
    typeof pkRows[0]?.['name'] === 'string' ? (pkRows[0]['name'] as string) : 'fid';

  const geoRows = await gpkgQuery(
    loc,
    absPath,
    'SELECT column_name, geometry_type_name FROM gpkg_geometry_columns ' +
      `WHERE table_name = ${quoteLiteral(layerName)}`,
  );
  const row = geoRows[0];
  const geometryColumn =
    row && typeof row['column_name'] === 'string' ? (row['column_name'] as string) : null;
  const geometryType =
    row && typeof row['geometry_type_name'] === 'string'
      ? (row['geometry_type_name'] as string)
      : null;
  return { layerName, fidColumn, geometryColumn, geometryType };
}

/**
 * 把 GPKG 的 -wal 并回主库。
 *
 * 备份只拷主库：-wal 里若还有没并回的页，备份就是一份缺数据的旧库。
 * 改完也并一次，让原文件保持"没有 -wal 也能读"的自包含状态。
 */
export async function gpkgCheckpoint(loc: GdalLocation, absPath: string): Promise<void> {
  await tools(loc).ogrInfo([
    '-sql',
    'PRAGMA wal_checkpoint(TRUNCATE)',
    '-dialect',
    'SQLITE',
    absPath,
  ]);
}

/** 把这一层的最后修改时间写成现在（GPKG 元数据表里的 last_change） */
export async function touchGpkgLastChange(
  loc: GdalLocation,
  absPath: string,
  layerName: string,
): Promise<void> {
  await tools(loc).ogrInfo([
    '-q',
    '-dialect',
    'SQLite',
    '-sql',
    'UPDATE gpkg_contents ' +
      `SET last_change = strftime('%Y-%m-%dT%H:%M:%fZ','now') ` +
      `WHERE table_name = ${quoteLiteral(layerName)}`,
    absPath,
  ]);
}

/**
 * 改 GPKG 之前的标准备份：先并 -wal，再拷主库；-wal 若还有内容就一起留。
 *
 * 只拷主库是有风险的：WAL 里可能还有没并回去的页，备份出来就是一份旧库。
 * checkpoint 之后正常情况下 -wal 已空；若仍有内容（别的连接还开着），
 * 把 -wal 一并拷到备份旁边，回退时才是完整的一套。
 *
 * @throws {VectorError} 备份失败（没有备份就不动手）
 */
export async function backupGpkg(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  targetRel: string,
  absPath: string,
  label: string,
): Promise<string> {
  await gpkgCheckpoint(loc, absPath);
  const backupPath = await createBackup(store, targetRel, label);
  if (!backupPath) {
    throw new VectorError('改之前没能建立备份，已停止（不会在没有备份的情况下改原文件）');
  }
  const walRel = `${targetRel}-wal`;
  try {
    if (await store.exists(walRel)) {
      await store.copy(walRel, `${backupPath}-wal`);
    }
  } catch {
    // -wal 拷不过去不阻塞主备份：主库已经 checkpoint 过，是一致的
  }
  return backupPath;
}

/** GDAL 报错的最后一行（最接近原因的那一行） */
function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop() ?? '';
}
