/**
 * DBF（Shapefile 属性表）的头部解析与字段值编解码。
 *
 * 超大 Shapefile 的属性编辑不该把整层读成 GeoJSON：DBF 是定长记录，
 * 可以按块读、按块写，内存只跟一块的大小有关。这个文件只负责"格式本身"：
 * 头、字段描述符、一条记录的字段值；具体改哪条、改成什么由调用方决定。
 *
 * 设计口径：
 *  - 字段名可能与 GDAL 读到的名字有编码差异，**属性字典的键一律用 GDAL 的列名**
 *    （按列顺序对应），这样表达式引擎与普通路径完全同一套名字；
 *  - 没改的字段在重写时**原样拷字节**，不做解码再编码 —— 避免把旧的乱码字节洗掉；
 *  - 写进去的文字按文件编码编码；装不下就明确报错或按字符边界截断并回报。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import {
  decodeText,
  encodeText,
  encodingFromLdid,
  normalizeEncoding,
  readCpgEncoding,
  type SupportedEncoding,
} from './encoding.ts';
import { VectorError, type LayerField } from './types.ts';

/** DBF 里的一个字段 */
export interface DbfField {
  readonly name: string;
  /** C / N / F / D / L … */
  readonly type: string;
  readonly length: number;
  readonly decimals: number;
  /** 在一条记录里的起始位置（已跳过 1 字节的删除标记） */
  readonly offset: number;
}

/** DBF 头 */
export interface DbfHeader {
  readonly version: number;
  readonly recordCount: number;
  readonly headerLength: number;
  readonly recordLength: number;
  readonly fields: readonly DbfField[];
  readonly encoding: SupportedEncoding;
  readonly languageDriver: number;
}

/** 形状文件的 .dbf 路径 */
export function dbfPathOf(shpAbs: string): string {
  return shpAbs.replace(/\.shp$/i, '.dbf');
}

/** 这个路径是不是 Shapefile 主文件（.shp） */
export function isShapefilePath(absPath: string): boolean {
  return /\.shp$/i.test(absPath);
}

/** 读 DBF 头与字段描述符；文件损坏 / 长度对不上时明确报错 */
export function readDbfHeader(shpAbs: string, dbfAbs = dbfPathOf(shpAbs)): DbfHeader {
  let fd: number;
  try {
    fd = openSync(dbfAbs, 'r');
  } catch (err) {
    throw new VectorError(`打不开属性表 ${dbfAbs}：${(err as Error).message}`);
  }
  try {
    const head = Buffer.alloc(32);
    readSync(fd, head, 0, 32, 0);
    const version = head[0]!;
    const recordCount = head.readUInt32LE(4);
    const headerLength = head.readUInt16LE(8);
    const recordLength = head.readUInt16LE(10);
    const languageDriver = head[29]!;
    if (headerLength < 33 || recordLength < 1) {
      throw new VectorError(
        `这个 .dbf 的头无法解析（头长 ${headerLength}，记录长 ${recordLength}），不改它。`,
      );
    }
    const fieldCount = Math.floor((headerLength - 33) / 32);
    if (fieldCount < 0) throw new VectorError('这个 .dbf 的字段数算不出来，不改它。');
    const descriptors = Buffer.alloc(fieldCount * 32);
    readSync(fd, descriptors, 0, descriptors.length, 32);

    const encoding =
      normalizeEncoding(readCpgEncoding(shpAbs)) ?? encodingFromLdid(languageDriver);
    const fields: DbfField[] = [];
    let cursor = 1;
    for (let i = 0; i < fieldCount; i += 1) {
      const raw = descriptors.subarray(i * 32, i * 32 + 32);
      const nul = raw.subarray(0, 11).indexOf(0);
      const nameBytes = raw.subarray(0, nul < 0 ? 11 : nul);
      const name = decodeText(nameBytes, encoding, false) ?? '';
      const type = String.fromCharCode(raw[11]!);
      const length = raw[16]!;
      const decimals = raw[17]!;
      fields.push({ name, type, length, decimals, offset: cursor });
      cursor += length;
    }
    if (cursor !== recordLength) {
      throw new VectorError(
        `这个 .dbf 的记录长度与字段总长对不上（头里写 ${recordLength}，字段加起来 ${cursor}）；` +
          '为了不改错列，已停止。',
      );
    }
    const size = statSync(dbfAbs).size;
    const needed = headerLength + recordCount * recordLength;
    if (size < needed) {
      throw new VectorError(
        `这个 .dbf 的长度不够（应有 ${needed} 字节，实际 ${size} 字节），可能损坏；不改它。`,
      );
    }
    return { version, recordCount, headerLength, recordLength, fields, encoding, languageDriver };
  } finally {
    closeSync(fd);
  }
}

/** 一条记录的删除标记 */
export const RECORD_ACTIVE = 0x20;
export const RECORD_DELETED = 0x2a;

/** 记录是否有效（没被标记删除） */
export function isActiveRecord(record: Buffer): boolean {
  return record[0] !== RECORD_DELETED;
}

/**
 * 数有效记录（没被标记删除）。
 *
 * ⚠️ GDAL 的 `ogrinfo -so` 报的 Feature Count 是**头里的记录数**，
 * 包含已删除的记录；判断"删完之后还剩几条"必须自己数删除标记。
 */
export function countActiveRecords(header: DbfHeader, dbfAbs: string): number {
  if (header.recordCount === 0) return 0;
  const fd = openSync(dbfAbs, 'r');
  try {
    const perChunk = Math.max(1, Math.floor((1 << 20) / header.recordLength));
    let index = 0;
    let offset = header.headerLength;
    let active = 0;
    while (index < header.recordCount) {
      const count = Math.min(perChunk, header.recordCount - index);
      const chunk = Buffer.alloc(count * header.recordLength);
      const got = readSync(fd, chunk, 0, chunk.length, offset);
      if (got !== chunk.length) {
        throw new VectorError(`数删除标记时读到第 ${index + 1} 条记录就提前结束了，文件可能损坏。`);
      }
      for (let i = 0; i < count; i += 1) {
        if (chunk[i * header.recordLength] !== RECORD_DELETED) active += 1;
      }
      index += count;
      offset += chunk.length;
    }
    return active;
  } finally {
    closeSync(fd);
  }
}

/** 解析一条记录的字段值；键用 GDAL 的列名（按列顺序） */
export function decodeDbfRecord(
  record: Buffer,
  header: DbfHeader,
  infoFields: readonly LayerField[],
): Record<string, unknown> {
  if (infoFields.length !== header.fields.length) {
    throw new VectorError(
      `这个 .dbf 的列数（${header.fields.length}）与 GDAL 读到的列数（${infoFields.length}）对不上；` +
        '为了不改错列，已停止。请先用兼容性体检看一下这个文件。',
    );
  }
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < header.fields.length; i += 1) {
    const field = header.fields[i]!;
    properties[infoFields[i]!.name] = decodeDbfValue(field, record, header.encoding);
  }
  return properties;
}

/** 解析一个字段的值 */
export function decodeDbfValue(
  field: DbfField,
  record: Buffer,
  encoding: SupportedEncoding,
): string | number | boolean | null {
  const bytes = record.subarray(field.offset, field.offset + field.length);
  const type = field.type.toUpperCase();
  if (type === 'C') {
    const text = decodeText(bytes, encoding, false) ?? '';
    return text.replace(/\u0000+$/g, '').replace(/ +$/g, '');
  }
  if (type === 'N' || type === 'F') {
    const text = bytes.toString('latin1').trim();
    if (text === '') return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }
  if (type === 'D') {
    const text = bytes.toString('latin1').trim();
    if (!/^\d{8}$/.test(text)) return null;
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  if (type === 'L') {
    const ch = String.fromCharCode(bytes[0] ?? 0x3f).toUpperCase();
    if (ch === 'T' || ch === 'Y') return true;
    if (ch === 'F' || ch === 'N') return false;
    return null;
  }
  // 二进制 / 备注等类型不参与表达式；复制记录时原样保留
  return null;
}

/** 编码一个字段值的结果 */
export interface EncodedDbfValue {
  readonly bytes: Buffer;
  /** 文字超过字段宽度，被按字符边界截断 */
  readonly truncated: boolean;
  /** 数字按字段的小数位被四舍五入 */
  readonly rounded: boolean;
}

/** 空值在 DBF 里的写法：文字/数字/日期填空格，逻辑型填 '?' */
function blankBytes(field: DbfField): Buffer {
  const bytes = Buffer.alloc(field.length, 0x20);
  if (field.type.toUpperCase() === 'L' && field.length > 0) bytes[0] = 0x3f;
  return bytes;
}

/**
 * 把一个值编码成字段宽度的字节。
 *
 * @throws {VectorError} 类型不对、数字放不下、日期格式不对、编码装不下。
 */
export function encodeDbfValue(
  field: DbfField,
  value: unknown,
  encoding: SupportedEncoding,
  label = '',
): EncodedDbfValue {
  const where = label ? `（${label}）` : '';
  if (value === null || value === undefined) {
    return { bytes: blankBytes(field), truncated: false, rounded: false };
  }
  const type = field.type.toUpperCase();

  if (type === 'C') {
    const text = typeof value === 'string' ? value : String(value);
    const encoded = encodeText(text, encoding);
    if (encoded.length <= field.length) {
      const bytes = Buffer.alloc(field.length, 0x20);
      encoded.copy(bytes);
      return { bytes, truncated: false, rounded: false };
    }
    // 按字符边界截断：多字节编码不能切半个字
    let used = 0;
    let out = '';
    for (const ch of text) {
      const size = encodeText(ch, encoding).length;
      if (used + size > field.length) break;
      out += ch;
      used += size;
    }
    const bytes = Buffer.alloc(field.length, 0x20);
    encodeText(out, encoding).copy(bytes);
    return { bytes, truncated: true, rounded: false };
  }

  if (type === 'N' || type === 'F') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new VectorError(
        `「${field.name}」这一列是数字列，写不进 ${JSON.stringify(value)}${where}`,
      );
    }
    const decimals = field.decimals;
    const text =
      decimals > 0
        ? value.toFixed(decimals)
        : String(Math.round(value));
    if (text.length > field.length) {
      throw new VectorError(
        `「${field.name}」这一列宽度是 ${field.length}，数字 ${text} 放不下${where}；` +
          '请先把这一列的宽度改大，或换一个更小的值。',
      );
    }
    const bytes = Buffer.alloc(field.length, 0x20);
    bytes.write(text, field.length - text.length, 'latin1');
    const rounded =
      decimals > 0 ? Number(text) !== value : Math.round(value) !== value;
    return { bytes, truncated: false, rounded };
  }

  if (type === 'D') {
    if (typeof value !== 'string') {
      throw new VectorError(
        `「${field.name}」这一列是日期列，要写成日期文字${where}`,
      );
    }
    const digits = value.replace(/[-/]/g, '');
    if (!/^\d{8}$/.test(digits)) {
      throw new VectorError(
        `「${field.name}」这一列是日期列，写不进「${value}」${where}（要 YYYYMMDD 或 YYYY-MM-DD）`,
      );
    }
    const bytes = Buffer.alloc(field.length, 0x20);
    bytes.write(digits.slice(0, field.length), 0, 'latin1');
    return { bytes, truncated: false, rounded: false };
  }

  if (type === 'L') {
    let ch = '?';
    if (typeof value === 'boolean') ch = value ? 'T' : 'F';
    else if (typeof value === 'number') ch = value === 0 ? 'F' : 'T';
    else if (typeof value === 'string') {
      const up = value.trim().toUpperCase();
      if (up === 'T' || up === 'Y' || up === 'TRUE' || up === '1') ch = 'T';
      else if (up === 'F' || up === 'N' || up === 'FALSE' || up === '0') ch = 'F';
      else {
        throw new VectorError(
          `「${field.name}」这一列是逻辑列，写不进「${value}」${where}`,
        );
      }
    } else {
      throw new VectorError(
        `「${field.name}」这一列是逻辑列，写不进 ${JSON.stringify(value)}${where}`,
      );
    }
    const bytes = Buffer.alloc(field.length, 0x20);
    bytes[0] = ch.charCodeAt(0);
    return { bytes, truncated: false, rounded: false };
  }

  throw new VectorError(
    `「${field.name}」这一列的类型（${field.type}）暂不支持在超大 Shapefile 里修改；` +
      '请先把它转成文字 / 数字列，或把文件拆小后用普通路径处理。',
  );
}

/** 把一段字节写进记录里的目标字段位置（原地覆盖） */
export function writeFieldBytes(record: Buffer, field: DbfField, bytes: Buffer): void {
  bytes.copy(record, field.offset, 0, field.length);
}
