/**
 * 超大矢量字段改名的流式实现（GeoPackage / Shapefile）。
 *
 * 常规路径是「整层读进内存 → 改 → 整层写回」，GB 级数据会耗尽内存。
 * 这两种格式各有一条不读全量的路：
 *
 *  - **GeoPackage**：字段名就是 SQLite 表的列名，`ALTER TABLE … RENAME COLUMN`
 *    由 SQLite 原地改元数据，秒级完成。改前先备份，改后重新探测核对。
 *  - **Shapefile**：字段名在 `.dbf` 头部每个 32 字节的描述符里（前 11 字节），
 *    直接改这几十个字节即可，不碰记录区。改前备份 `.dbf`，改后重新探测核对。
 *
 * 其它格式没有这样的原地入口，仍由调用方按体积拒绝。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, closeSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import { createBackup } from '../gdal/writeback.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { WorkspaceAdapter } from '../workspace/index.ts';
import { tools } from '../gdal/runner.ts';
import { VectorError } from './types.ts';
import { probeLayer } from './read.ts';
import { normalizeEncoding, readCpgEncoding, type SupportedEncoding } from './encoding.ts';
import { backupGpkg, gpkgCheckpoint, quoteIdent, quoteLiteral } from './gpkg-native.ts';

export type StreamRenameKind = 'gpkg' | 'shp';

/** Shapefile 字段名上限（字节） */
export const DBF_NAME_BYTES = 10;

/** 能在超大体量下走流式改名的格式；其它返回 null */
export function streamRenameKind(absPath: string): StreamRenameKind | null {
  if (/\.gpkg$/i.test(absPath)) return 'gpkg';
  if (/\.shp$/i.test(absPath)) return 'shp';
  return null;
}

/** 一条改名（from 是文件里真实的旧列名） */
export interface StreamRenamePlan {
  readonly from: string;
  readonly requestedTo: string;
}

export interface StreamRenameResult {
  /** 与 plans 顺序一致的实际列名（Shapefile 可能被截断） */
  readonly actualTo: readonly string[];
  readonly backupPath: string | null;
  /** 附带说明（例如 GPKG 元数据表没能同步） */
  readonly note?: string;
}

/**
 * 执行改名（会写盘）。
 *
 * @throws {VectorError} 备份失败、DDL 失败、改完核对不上。
 */
export async function executeStreamRename(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  targetRel: string,
  absPath: string,
  layerName: string,
  plans: readonly StreamRenamePlan[],
): Promise<StreamRenameResult> {
  const kind = streamRenameKind(absPath);
  if (!kind) throw new VectorError(`这个格式不支持流式改名：${absPath}`);
  if (kind === 'gpkg') {
    return renameGpkg(loc, store, targetRel, absPath, layerName, plans);
  }
  return renameShapefile(loc, store, targetRel, absPath, plans);
}

async function renameGpkg(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  targetRel: string,
  absPath: string,
  layerName: string,
  plans: readonly StreamRenamePlan[],
): Promise<StreamRenameResult> {
  const gdal = tools(loc);
  const backupPath = await backupGpkg(loc, store, targetRel, absPath, 'rename');
  // 两段式改列：先把每个旧列名改成临时名，再改成目标名。
  // 一段式会在接力/互换改名（A→B、B→A）上撞名 —— 目标名此刻还被另一个列占着。
  // 临时名带随机后缀，不会与文件里原有的列撞车。
  const temps = plans.map(
    (_plan, i) => `__cartouche_tmp_${i}_${randomBytes(2).toString('hex')}`,
  );
  for (const [i, plan] of plans.entries()) {
    const sql =
      `ALTER TABLE ${quoteIdent(layerName)} ` +
      `RENAME COLUMN ${quoteIdent(plan.from)} TO ${quoteIdent(temps[i]!)}`;
    const res = await gdal.ogrInfo(['-sql', sql, '-dialect', 'SQLITE', absPath]);
    if (!res.ok) {
      throw new VectorError(
        `改字段名失败（准备第 ${i + 1} 个字段；此前已改的字段不会自动回退，备份在 ${backupPath}）：` +
          (res.stderr.trim().split(/\r?\n/).pop() ?? '未知原因'),
      );
    }
  }
  for (const [i, plan] of plans.entries()) {
    const sql =
      `ALTER TABLE ${quoteIdent(layerName)} ` +
      `RENAME COLUMN ${quoteIdent(temps[i]!)} TO ${quoteIdent(plan.requestedTo)}`;
    const res = await gdal.ogrInfo(['-sql', sql, '-dialect', 'SQLITE', absPath]);
    if (!res.ok) {
      throw new VectorError(
        `改字段名失败（第 ${i + 1} 个字段的最终名字；备份在 ${backupPath}）：` +
          (res.stderr.trim().split(/\r?\n/).pop() ?? '未知原因'),
      );
    }
  }

  // GPKG 的可选元数据表：有就同步列名，没有就算了（不影响读取）
  let note: string | undefined;
  for (const plan of plans) {
    const metaSql =
      'UPDATE "gpkg_data_columns" SET "column_name" = ' +
      `${quoteLiteral(plan.requestedTo)} WHERE "table_name" = ${quoteLiteral(layerName)} ` +
      `AND "column_name" = ${quoteLiteral(plan.from)}`;
    const meta = await gdal.ogrInfo(['-sql', metaSql, '-dialect', 'SQLITE', absPath]);
    if (!meta.ok && !/no such table/i.test(meta.stderr)) {
      note = 'gpkg_data_columns 元数据没能同步（字段本身已改名）';
    }
  }

  await gpkgCheckpoint(loc, absPath);
  const actualTo = await verifyRenamed(
    loc,
    absPath,
    plans.map((p) => p.requestedTo),
    backupPath,
  );
  return { actualTo, backupPath, ...(note ? { note } : {}) };
}

/* ── Shapefile：字段名所在的 .dbf 头 ─────────────────────────── */

/** GBK 反查表（字符 → 双字节）；首次用到时才建，一次解码约 1ms */
let gbkEncodeMapCache: Map<string, readonly [number, number]> | null = null;

function gbkEncodeMap(): Map<string, readonly [number, number]> {
  if (gbkEncodeMapCache) return gbkEncodeMapCache;
  const leads: number[] = [];
  for (let b = 0x81; b <= 0xfe; b += 1) leads.push(b);
  const trails: number[] = [];
  for (let b = 0x40; b <= 0xfe; b += 1) if (b !== 0x7f) trails.push(b);
  const bytes = Buffer.alloc(leads.length * trails.length * 2);
  let i = 0;
  for (const lead of leads) {
    for (const trail of trails) {
      bytes[i] = lead;
      bytes[i + 1] = trail;
      i += 2;
    }
  }
  // 一段连续的 GBK 双字节序列：每个双字节恰好解出一个 BMP 字符
  const text = new TextDecoder('gbk').decode(bytes);
  const map = new Map<string, readonly [number, number]>();
  if (text.length === leads.length * trails.length) {
    let p = 0;
    for (const ch of text) {
      if (ch !== '\uFFFD' && !map.has(ch)) map.set(ch, [bytes[p]!, bytes[p + 1]!]);
      p += 2;
    }
  }
  gbkEncodeMapCache = map;
  return map;
}

/** 按文件编码把字段名写成字节（字段名必须能在这个编码里表示） */
function encodeFieldName(name: string, encoding: SupportedEncoding): Buffer {
  if (encoding === 'UTF-8') return Buffer.from(name, 'utf8');
  if (encoding === 'LATIN1') {
    for (const ch of name) {
      if ((ch.codePointAt(0) ?? 0) > 0xff) {
        throw new VectorError(`「${ch}」不能在 LATIN1 编码的字段名里表示`);
      }
    }
    return Buffer.from(name, 'latin1');
  }
  const map = gbkEncodeMap();
  const out: number[] = [];
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) out.push(code);
    else if (ch === '€') out.push(0x80);
    else {
      const pair = map.get(ch);
      if (!pair) throw new VectorError(`「${ch}」不能在 GBK 编码的字段名里表示`);
      out.push(pair[0], pair[1]);
    }
  }
  return Buffer.from(out);
}

/** 严格解码字段名；解不开返回 null */
function decodeFieldName(bytes: Buffer, encoding: SupportedEncoding): string | null {
  const label = encoding === 'GBK' ? 'gbk' : encoding === 'LATIN1' ? 'latin1' : 'utf-8';
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** .cpg 缺失时按 DBF 头的语言驱动字节（第 29 字节）猜编码 */
function encodingFromLdid(head: Buffer): SupportedEncoding {
  const ldid = head.length > 29 ? head[29]! : 0;
  if (ldid === 0x4d || ldid === 0x7a) return 'GBK';
  if (ldid === 0x03 || ldid === 0x57 || ldid === 0x58 || ldid === 0x59) return 'LATIN1';
  return 'UTF-8';
}

/**
 * 认字段名的编码：先看 .cpg，再看 LDID；最后用真实字节验证一遍。
 *
 * 为什么要验证：.cpg 写错、LDID 空着都是现实里存在的。若认出来的编码
 * 解不开任何一个字段名，就换一种能全部解开的编码 —— 都解不开说明不是
 * 文本名（或文件损坏），报错退出，绝不硬写。
 */
function pickNameEncoding(
  shpAbs: string,
  head: Buffer,
  rawNames: readonly Buffer[],
): { encoding: SupportedEncoding; names: readonly string[] } {
  const preferred = normalizeEncoding(readCpgEncoding(shpAbs)) ?? encodingFromLdid(head);
  const order: SupportedEncoding[] = [preferred];
  for (const enc of ['UTF-8', 'GBK', 'LATIN1'] as const) {
    if (!order.includes(enc)) order.push(enc);
  }
  for (const encoding of order) {
    const names = rawNames.map((raw) => decodeFieldName(raw, encoding));
    if (names.every((n): n is string => n !== null)) {
      return { encoding, names };
    }
  }
  throw new VectorError('这个 Shapefile 的字段名解不开（既不是 UTF-8，也不是 GBK / LATIN1）');
}

/** 按文件编码截断到 10 字节（不切坏多字节字符） */
function truncateFieldName(name: string, encoding: SupportedEncoding): string {
  let used = 0;
  let out = '';
  for (const ch of name) {
    const size = encodeFieldName(ch, encoding).length;
    if (used + size > DBF_NAME_BYTES) break;
    out += ch;
    used += size;
  }
  return out;
}

async function renameShapefile(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  targetRel: string,
  absPath: string,
  plans: readonly StreamRenamePlan[],
): Promise<StreamRenameResult> {
  const dbfRel = targetRel.replace(/\.shp$/i, '.dbf');
  const dbfAbs = absPath.replace(/\.shp$/i, '.dbf');
  if (!existsSync(dbfAbs)) {
    throw new VectorError('这个 Shapefile 没有 .dbf 属性表，改不了字段名');
  }
  const backupPath = await createBackup(store, dbfRel, 'rename');
  if (!backupPath) {
    throw new VectorError('改名之前没能建立 .dbf 备份，已停止（不会在没有备份的情况下改原文件）');
  }

  const fd = openSync(dbfAbs, 'r+');
  let expectedNames: string[] = [];
  try {
    const head = Buffer.alloc(32);
    readSync(fd, head, 0, 32, 0);
    const headerLength = head.readUInt16LE(8);
    const fieldCount = Math.floor((headerLength - 33) / 32);
    if (!(fieldCount > 0)) {
      throw new VectorError(`这个 Shapefile 的 .dbf 头无法解析（字段数 ${fieldCount}）`);
    }
    const descriptors = Buffer.alloc(fieldCount * 32);
    readSync(fd, descriptors, 0, descriptors.length, 32);

    const rawNames: Buffer[] = [];
    for (let i = 0; i < fieldCount; i += 1) {
      const raw = descriptors.subarray(i * 32, i * 32 + 11);
      const nul = raw.indexOf(0);
      rawNames.push(raw.subarray(0, nul < 0 ? 11 : nul));
    }
    const { encoding, names } = pickNameEncoding(absPath, head, rawNames);

    const finalNames = [...names];
    for (const plan of plans) {
      const index = names.findIndex((n) => n.toLowerCase() === plan.from.toLowerCase());
      if (index < 0) {
        throw new VectorError(
          `在 .dbf 头里找不到字段「${plan.from}」（属性表里现在有：${names.join('、') || '（一列都没有）'}；` +
            `已保留备份 ${backupPath}，原文件未改动）`,
        );
      }
      // 与 GDAL 写回同口径：超过 10 字节就截断，实际列名以截断后的为准
      const expected = truncateFieldName(plan.requestedTo, encoding);
      expectedNames.push(expected);
      finalNames[index] = expected;
      // 11 字节的槽要整体覆盖：旧名字更长时，残留字节会被当成名字的一部分
      const slot = Buffer.alloc(11);
      encodeFieldName(expected, encoding).copy(slot);
      slot.copy(descriptors, index * 32);
    }

    // 截断之后可能才撞名（两个长名字被截成同一个）—— 必须写盘之前挡住
    const seen = new Map<string, string>();
    for (const name of finalNames) {
      const key = name.toLowerCase();
      const prev = seen.get(key);
      if (prev !== undefined) {
        throw new VectorError(
          `改名之后会有两列同名：「${prev}」与「${name}」（Shapefile 字段名最多 ${DBF_NAME_BYTES} 字节，` +
            `超长的会被截断）。已保留备份 ${backupPath}，原文件未改动。`,
        );
      }
      seen.set(key, name);
    }

    writeSync(fd, descriptors, 0, descriptors.length, 32);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  const actualTo = await verifyRenamed(loc, absPath, expectedNames, backupPath);
  return { actualTo, backupPath };
}

/** 改完重新探测：新列必须真的在，返回值按 plans 顺序给出实际列名 */
async function verifyRenamed(
  loc: GdalLocation,
  absPath: string,
  expectedNames: readonly string[],
  backupPath: string,
): Promise<readonly string[]> {
  const after = await probeLayer(loc, absPath);
  const names = after.fields.map((f) => f.name);
  return expectedNames.map((expected) => {
    const actual = names.find((n) => n.toLowerCase() === expected.toLowerCase());
    if (!actual) {
      throw new VectorError(
        `改完之后没有找到「${expected}」这一列（现在有：${names.join('、') || '（一列都没有）'}；` +
          `改之前的状态在 ${backupPath}）`,
      );
    }
    return actual;
  });
}
