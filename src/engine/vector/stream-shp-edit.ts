/**
 * 超大 Shapefile 的流式编辑：改属性、加字段、删要素。
 *
 * Shapefile 的几何在 .shp、属性在 .dbf。这三类操作**只动属性表**：
 *  - 改属性 / 加字段：按块读 .dbf、按块写一份新 .dbf，未改的字段字节原样拷过去；
 *  - 删要素：按 DBF 的删除标记（0x2A）原地标记，GDAL / ArcGIS 不再显示。
 *
 * 与普通路径的口径：
 *  - 条件与表达式仍然由仓库自己的表达式引擎逐条求值（函数全部可用），
 *    所以不会出现"小文件能跑、大文件换了一套 SQL 语义"；
 *  - 只处理有效记录（已被标记删除的记录原样保留）；
 *  - 改写完成后重新探测要素数与列，并抽样核对写进去的字段字节。
 *
 * 已知限制（都会明确报错）：
 *  - AREA 这类需要读几何的表达式（要 .shp，不在属性表里）；
 *  - delete 的 keep=largest（要逐条算面积）；
 *  - 不支持的类型（二进制 / 备注等）不参与修改。
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import type { OpValueResult } from '../ops/executor.ts';
import { evaluate, type ExprNode } from '../expression/index.ts';
import { coerceForColumn } from '../feature/common.ts';
import { createBackup, replaceFileAtomically } from '../gdal/writeback.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { WorkspaceAdapter } from '../workspace/index.ts';
import { matchesWhere, probeLayer } from './read.ts';
import { VectorError, type LayerInfo } from './types.ts';
import {
  dbfPathOf,
  countActiveRecords,
  decodeDbfRecord,
  encodeDbfValue,
  isActiveRecord,
  readDbfHeader,
  RECORD_DELETED,
  writeFieldBytes,
  type DbfField,
  type DbfHeader,
} from './dbf.ts';
import { encodeText, type SupportedEncoding } from './encoding.ts';
import type { StreamSetTarget } from './stream-types.ts';

/** 每次读 / 写的块大小：1 MB，内存与文件体积无关 */
const CHUNK_BYTES = 1 << 20;
/** 抽样核对的条数 */
const SAMPLE_LIMIT = 3;
/** DBF 字段名的字节上限（描述符里 11 字节，留一个 NUL） */
const DBF_NAME_BYTES = 10;

interface ShpContext {
  readonly targetRel: string;
  readonly shpAbs: string;
  readonly dbfRel: string;
  readonly dbfAbs: string;
  readonly header: DbfHeader;
  readonly info: LayerInfo;
}

function shpContext(targetRel: string, shpAbs: string, info: LayerInfo): ShpContext {
  const dbfRel = targetRel.replace(/\.shp$/i, '.dbf');
  const dbfAbs = dbfPathOf(shpAbs);
  const header = readDbfHeader(shpAbs, dbfAbs);
  if (header.fields.length !== info.fields.length) {
    throw new VectorError(
      `这个 .dbf 的列数（${header.fields.length}）与 GDAL 读到的列数（${info.fields.length}）对不上；` +
        '为了不改错列，已停止。请先用兼容性体检看一下这个文件。',
    );
  }
  return { targetRel, shpAbs, dbfRel, dbfAbs, header, info };
}

/** 一条记录在什么位置 */
interface RecordRef {
  readonly buffer: Buffer;
  readonly index: number;
}

/** 按块遍历记录；record 是块里的子视图，回调内可以直接改（块的副本） */
function forEachRecord(
  ctx: ShpContext,
  onRecord: (record: RecordRef) => void,
): void {
  const { header, dbfAbs } = ctx;
  if (header.recordCount === 0) return;
  const perChunk = Math.max(1, Math.floor(CHUNK_BYTES / header.recordLength));
  const fd = openSync(dbfAbs, 'r');
  try {
    let index = 0;
    let offset = header.headerLength;
    while (index < header.recordCount) {
      const count = Math.min(perChunk, header.recordCount - index);
      const chunk = Buffer.alloc(count * header.recordLength);
      const got = readSync(fd, chunk, 0, chunk.length, offset);
      if (got !== chunk.length) {
        throw new VectorError(`这个 .dbf 在读取第 ${index + 1} 条记录时提前结束，可能损坏。`);
      }
      for (let i = 0; i < count; i += 1) {
        onRecord({
          buffer: chunk.subarray(i * header.recordLength, (i + 1) * header.recordLength),
          index: index + i,
        });
      }
      index += count;
      offset += chunk.length;
    }
  } finally {
    closeSync(fd);
  }
}

/** 读第 index 条记录（0 起） */
function readRecordAt(ctx: ShpContext, index: number): Buffer {
  const fd = openSync(ctx.dbfAbs, 'r');
  try {
    const record = Buffer.alloc(ctx.header.recordLength);
    const got = readSync(
      fd,
      record,
      0,
      record.length,
      ctx.header.headerLength + index * ctx.header.recordLength,
    );
    if (got !== record.length) {
      throw new VectorError(`读第 ${index + 1} 条记录时提前结束，文件可能损坏。`);
    }
    return record;
  } finally {
    closeSync(fd);
  }
}

/** 读原始头（含字段描述符与 0x0D 终止符） */
function readRawHeader(ctx: ShpContext): Buffer {
  const fd = openSync(ctx.dbfAbs, 'r');
  try {
    const raw = Buffer.alloc(ctx.header.headerLength);
    readSync(fd, raw, 0, raw.length, 0);
    return raw;
  } finally {
    closeSync(fd);
  }
}

/** 把"最后修改日期"写成今天 */
function touchHeaderDate(bytes: Buffer): void {
  const now = new Date();
  bytes[1] = now.getFullYear() - 1900;
  bytes[2] = now.getMonth() + 1;
  bytes[3] = now.getDate();
}

/** 带缓冲的写入：按块落盘，避免每条记录一次系统调用 */
function createWriter(fd: number): {
  push: (bytes: Buffer) => void;
  flush: () => void;
} {
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let used = 0;
  const flush = (): void => {
    if (used > 0) {
      writeSync(fd, buffer, 0, used);
      used = 0;
    }
  };
  return {
    push(bytes: Buffer): void {
      if (bytes.length >= buffer.length) {
        flush();
        writeSync(fd, bytes);
        return;
      }
      if (used + bytes.length > buffer.length) flush();
      bytes.copy(buffer, used);
      used += bytes.length;
    },
    flush,
  };
}

/** 条件求值：错误里补上记录号 */
function hitAt(node: ExprNode, properties: Record<string, unknown>, index: number): boolean {
  try {
    return matchesWhere(node, properties);
  } catch (err) {
    throw new VectorError(
      `第 ${index + 1} 条记录的属性上条件算不出来：${(err as Error).message}`,
      '',
      err,
    );
  }
}

/** 表达式求值：错误里补上记录号 */
function evalAt(node: ExprNode, properties: Record<string, unknown>, index: number): unknown {
  try {
    return evaluate(node, properties);
  } catch (err) {
    throw new VectorError(
      `第 ${index + 1} 条记录的表达式算不出来：${(err as Error).message}`,
      '',
      err,
    );
  }
}

/** 把新名字按文件编码截到 10 字节（不切坏多字节字符） */
function truncateDbfName(name: string, encoding: SupportedEncoding): string {
  const encoded = encodeText(name, encoding);
  if (encoded.length <= DBF_NAME_BYTES) return name;
  let used = 0;
  let out = '';
  for (const ch of name) {
    const size = encodeText(ch, encoding).length;
    if (used + size > DBF_NAME_BYTES) break;
    out += ch;
    used += size;
  }
  return out;
}

/** 检查新字段名与已有列是否撞名（改完之后的大小写不敏感） */
function assertNoNameClash(ctx: ShpContext, name: string): void {
  const clash = ctx.info.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (clash) {
    throw new VectorError(`这一层已经有「${clash.name}」这一列了，换一个名字。`);
  }
}

/** 抽样核对：记录的字段字节必须与写之前算出来的一致 */
function verifySampleBytes(
  ctx: ShpContext,
  samples: readonly { index: number; field: DbfField; bytes: Buffer }[],
): void {
  for (const sample of samples) {
    const record = readRecordAt(ctx, sample.index);
    const got = record.subarray(
      sample.field.offset,
      sample.field.offset + sample.field.length,
    );
    if (!got.equals(sample.bytes)) {
      throw new VectorError(
        `写完之后抽样核对对不上（第 ${sample.index + 1} 条记录的「${sample.field.name}」）。` +
          '备份就在 .dbf 旁边，可用它恢复。',
      );
    }
  }
}

/* ── 改属性 ──────────────────────────────────────────────────── */

export interface ShpSetAttributesInput {
  readonly targetRel: string;
  readonly absPath: string;
  readonly info: LayerInfo;
  readonly whereSource: string;
  readonly whereNode: ExprNode;
  readonly targets: readonly StreamSetTarget[];
  readonly dryRun: boolean;
}

/** 原生流式改属性 */
export async function shpStreamSetAttributes(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  input: ShpSetAttributesInput,
): Promise<OpValueResult> {
  const ctx = shpContext(input.targetRel, input.absPath, input.info);

  // 目标字段必须在 DBF 里找得到，且类型能写
  const targets = input.targets.map((target) => {
    const index = ctx.info.fields.findIndex(
      (f) => f.name.toLowerCase() === target.name.toLowerCase(),
    );
    if (index < 0) {
      throw new VectorError(`.dbf 里找不到「${target.name}」这一列，已停止。`);
    }
    const field = ctx.header.fields[index]!;
    if (!['C', 'N', 'F', 'D', 'L'].includes(field.type.toUpperCase())) {
      throw new VectorError(
        `「${target.name}」这一列的类型（${field.type}）暂不支持在超大 Shapefile 里修改。`,
      );
    }
    return { target, field };
  });

  let total = 0;
  let hits = 0;
  let truncated = 0;
  let rounded = 0;
  const samples: Array<{
    index: number;
    values: Record<string, string | number | boolean | null>;
    bytes: Array<{ field: DbfField; bytes: Buffer }>;
  }> = [];

  const tempRel = `${ctx.dbfRel}.tmp-${randomBytes(3).toString('hex')}`;
  const tempAbs = store.resolve(tempRel);
  let fd = -1;
  let writer: ReturnType<typeof createWriter> | null = null;
  if (!input.dryRun) {
    fd = openSync(tempAbs, 'w');
    const header = readRawHeader(ctx);
    touchHeaderDate(header);
    writer = createWriter(fd);
    writer.push(header);
  }

  try {
    forEachRecord(ctx, ({ buffer: record, index }) => {
      if (!isActiveRecord(record)) {
        if (writer) writer.push(record);
        return;
      }
      total += 1;
      const properties = decodeDbfRecord(record, ctx.header, ctx.info.fields);
      if (!hitAt(input.whereNode, properties, index)) {
        if (writer) writer.push(record);
        return;
      }
      hits += 1;
      const values: Record<string, string | number | boolean | null> = {};
      const bytesForSample: Array<{ field: DbfField; bytes: Buffer }> = [];
      for (const { target, field } of targets) {
        const raw =
          target.value.kind === 'literal'
            ? target.value.value
            : evalAt(target.value.node, properties, index);
        const value = coerceForColumn(raw, target.kind, target.name);
        if (typeof raw === 'number' && typeof value === 'number' && raw !== value) {
          rounded += 1;
        }
        const encoded = encodeDbfValue(
          field,
          value,
          ctx.header.encoding,
          `第 ${index + 1} 条记录`,
        );
        if (encoded.truncated) truncated += 1;
        if (encoded.rounded) rounded += 1;
        writeFieldBytes(record, field, encoded.bytes);
        values[target.name] = value;
        // 后面的表达式能看到前面刚改的值（与普通路径一致）
        properties[target.name] = value;
        if (samples.length < SAMPLE_LIMIT) {
          bytesForSample.push({ field, bytes: Buffer.from(encoded.bytes) });
        }
      }
      if (samples.length < SAMPLE_LIMIT) samples.push({ index, values, bytes: bytesForSample });
      if (writer) writer.push(record);
    });

    if (hits === 0) {
      throw new VectorError(
        `条件没有命中任何要素（0 条命中）：「${input.whereSource}」。` +
          `这一层一共 ${total} 条要素。` +
          '可能是条件太严，也可能是字段名写错了。',
      );
    }

    const fields = input.targets.map((t) => t.name);
    const valuesOfFirst = Object.fromEntries(
      input.targets.map((t) => [t.name, samples[0]?.values[t.name] ?? null]),
    );

    if (input.dryRun) {
      return {
        kind: 'value',
        summary:
          `将改 ${hits} 条要素的 ${input.targets.length} 个字段（${fields.join('、')}）` +
          `（共 ${total} 条，预演：没有写盘；超大 Shapefile 按 DBF 流式改写）`,
        data: {
          target: input.targetRel,
          where: input.whereSource,
          updated: hits,
          total,
          fields,
          values: valuesOfFirst,
          samples: samples.map((s) => ({ featureIndex: s.index + 1, values: s.values })),
          dryRun: true,
          streamed: true,
        },
      };
    }

    writer!.push(Buffer.from([0x1a]));
    writer!.flush();
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;

    const replaced = await replaceFileAtomically(store, {
      target: ctx.dbfRel,
      tempPath: tempRel,
      backup: true,
      label: 'setattrs',
    });

    // 写完核对：要素数不变、字段还在、抽样字节一致
    const after = await probeLayer(loc, ctx.shpAbs);
    for (const name of fields) {
      if (!after.fields.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
        throw new VectorError(
          `改完之后找不到「${name}」这一列。备份在 ${replaced.backupPath ?? '（没有）'}`,
        );
      }
    }
    const afterHeader = readDbfHeader(ctx.shpAbs, ctx.dbfAbs);
    const afterActive = countActiveRecords(afterHeader, ctx.dbfAbs);
    if (afterActive !== total) {
      throw new VectorError(
        `改完之后要素数不对：原来 ${total} 条，现在 ${afterActive} 条。` +
          `备份在 ${replaced.backupPath ?? '（没有）'}`,
      );
    }
    const afterCtx: ShpContext = { ...ctx, header: afterHeader };
    const checks: Array<{ index: number; field: DbfField; bytes: Buffer }> = [];
    for (const sample of samples) {
      for (const item of sample.bytes) {
        const field = afterHeader.fields.find(
          (f) => f.name.toLowerCase() === item.field.name.toLowerCase(),
        );
        if (field) checks.push({ index: sample.index, field, bytes: item.bytes });
      }
    }
    // info.fields 的顺序与 DBF 一致，改用新头的字段对象做核对
    verifySampleBytes({ ...afterCtx, info: after }, checks);

    const caveats: string[] = [];
    if (truncated > 0) caveats.push(`${truncated} 处文字超过字段宽度，已按字符边界截断`);
    if (rounded > 0) caveats.push(`${rounded} 处数字按字段小数位四舍五入`);
    caveats.push('超大 Shapefile 按 DBF 流式改写，未改的字段原样拷贝');
    caveats.push(`抽样核对了 ${samples.length} 条，不是逐条核对`);

    return {
      kind: 'value',
      summary:
        `已改 ${hits} 条要素的 ${input.targets.length} 个字段（${fields.join('、')}）` +
        `（共 ${total} 条）` +
        (caveats.length > 0 ? `（${caveats.join('；')}）` : ''),
      data: {
        target: input.targetRel,
        where: input.whereSource,
        updated: hits,
        total,
        fields,
        values: valuesOfFirst,
        backupPath: replaced.backupPath,
        ...(truncated > 0 ? { truncated } : {}),
        ...(rounded > 0 ? { rounded } : {}),
        streamed: true,
      },
    };
  } catch (err) {
    if (fd >= 0) closeSync(fd);
    try {
      await store.remove(tempRel);
    } catch {
      /* 临时文件清不掉不影响结果 */
    }
    throw err;
  }
}

/* ── 加字段 ──────────────────────────────────────────────────── */

export interface ShpAddFieldInput {
  readonly targetRel: string;
  readonly absPath: string;
  readonly info: LayerInfo;
  readonly fieldName: string;
  readonly exprNode: ExprNode;
  readonly whereNode: ExprNode | null;
  readonly dryRun: boolean;
}

interface AddStats {
  total: number;
  hits: number;
  anyText: boolean;
  anyReal: boolean;
  anyInteger: boolean;
  anyBool: boolean;
  maxTextBytes: number;
  samples: Array<{ index: number; value: unknown }>;
}

/** 原生流式加字段 */
export async function shpStreamAddField(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  input: ShpAddFieldInput,
): Promise<OpValueResult> {
  const ctx = shpContext(input.targetRel, input.absPath, input.info);
  const stats: AddStats = {
    total: 0,
    hits: 0,
    anyText: false,
    anyReal: false,
    anyInteger: false,
    anyBool: false,
    maxTextBytes: 0,
    samples: [],
  };

  // 第一遍：统计命中数、值类型与最大文字宽度（不改文件）
  forEachRecord(ctx, ({ buffer: record, index }) => {
    if (!isActiveRecord(record)) return;
    stats.total += 1;
    const properties = decodeDbfRecord(record, ctx.header, ctx.info.fields);
    if (input.whereNode && !hitAt(input.whereNode, properties, index)) return;
    stats.hits += 1;
    const value = evalAt(input.exprNode, properties, index);
    trackNewValue(stats, value, index, ctx.header.encoding);
    if (stats.samples.length < SAMPLE_LIMIT) {
      stats.samples.push({ index, value });
    }
  });

  const name = truncateDbfName(input.fieldName, ctx.header.encoding);
  if (name === '') {
    throw new VectorError(
      `「${input.fieldName}」按 ${ctx.header.encoding} 编码后放不进字段名（最多 ${DBF_NAME_BYTES} 字节）。`,
    );
  }
  assertNoNameClash(ctx, name);
  const plan = planNewField(stats);
  const field: DbfField = {
    name,
    type: plan.type,
    length: plan.length,
    decimals: plan.decimals,
    offset: ctx.header.recordLength,
  };

  const newHeaderLength = ctx.header.headerLength + 32;
  const newRecordLength = ctx.header.recordLength + field.length;
  if (newHeaderLength > 0xffff || newRecordLength > 0xffff) {
    throw new VectorError(
      '再加一列会让 .dbf 的头或记录长度超过 65535 字节；这个格式放不下了，请先拆分或转 GeoPackage。',
    );
  }

  if (input.dryRun) {
    return {
      kind: 'value',
      summary:
        `将加字段「${name}」：${stats.hits} 条要素会赋值（共 ${stats.total} 条）` +
        '（预演：没有写盘；超大 Shapefile 按 DBF 流式改写）',
      data: {
        target: input.targetRel,
        fieldName: name,
        requestedName: input.fieldName,
        updated: stats.hits,
        total: stats.total,
        columnType: plan.label,
        dryRun: true,
        streamed: true,
      },
    };
  }

  const tempRel = `${ctx.dbfRel}.tmp-${randomBytes(3).toString('hex')}`;
  const tempAbs = store.resolve(tempRel);
  let fd = openSync(tempAbs, 'w');
  let writer: ReturnType<typeof createWriter> | null = null;
  try {
    const header = readRawHeader(ctx);
    const newHeader = Buffer.alloc(newHeaderLength);
    header.copy(newHeader, 0, 0, ctx.header.headerLength - 1);
    const descriptor = Buffer.alloc(32);
    encodeText(name, ctx.header.encoding).copy(descriptor, 0, 0, 11);
    descriptor[11] = plan.type.charCodeAt(0);
    descriptor[16] = plan.length;
    descriptor[17] = plan.decimals;
    descriptor.copy(newHeader, ctx.header.headerLength - 1);
    newHeader[ctx.header.headerLength - 1 + 32] = 0x0d;
    newHeader.writeUInt16LE(newHeaderLength, 8);
    newHeader.writeUInt16LE(newRecordLength, 10);
    touchHeaderDate(newHeader);
    writer = createWriter(fd);
    writer.push(newHeader);

    let truncated = 0;
    let rounded = 0;
    const expected = new Map<number, Buffer>();
    const sampleIndexes = new Set(stats.samples.map((s) => s.index));

    forEachRecord(ctx, ({ buffer: record, index }) => {
      const out = Buffer.alloc(newRecordLength);
      record.copy(out, 0);
      let value: unknown = null;
      if (isActiveRecord(record)) {
        const properties = decodeDbfRecord(record, ctx.header, ctx.info.fields);
        const hit = input.whereNode ? hitAt(input.whereNode, properties, index) : true;
        if (hit) value = evalAt(input.exprNode, properties, index);
      }
      const encoded = encodeDbfValue(
        field,
        value,
        ctx.header.encoding,
        `第 ${index + 1} 条记录`,
      );
      if (encoded.truncated) truncated += 1;
      if (encoded.rounded) rounded += 1;
      writeFieldBytes(out, field, encoded.bytes);
      if (sampleIndexes.has(index)) expected.set(index, Buffer.from(encoded.bytes));
      writer!.push(out);
    });

    writer.push(Buffer.from([0x1a]));
    writer.flush();
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;

    const replaced = await replaceFileAtomically(store, {
      target: ctx.dbfRel,
      tempPath: tempRel,
      backup: true,
      label: 'addfield',
    });

    // 写完核对：列在、要素数不变、抽样字节一致
    const after = await probeLayer(loc, ctx.shpAbs);
    const written = after.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (!written) {
      throw new VectorError(
        `写完之后没有找到「${name}」这一列。备份在 ${replaced.backupPath ?? '（没有）'}`,
      );
    }
    const afterHeader = readDbfHeader(ctx.shpAbs, ctx.dbfAbs);
    const afterActive = countActiveRecords(afterHeader, ctx.dbfAbs);
    if (afterActive !== stats.total) {
      throw new VectorError(
        `写完之后要素数不对：应该还是 ${stats.total} 条，实际 ${afterActive} 条。` +
          `备份在 ${replaced.backupPath ?? '（没有）'}`,
      );
    }
    const newField = afterHeader.fields[afterHeader.fields.length - 1]!;
    for (const [index, bytes] of expected) {
      const record = readRecordAt({ ...ctx, header: afterHeader }, index);
      const got = record.subarray(newField.offset, newField.offset + newField.length);
      if (!got.equals(bytes)) {
        throw new VectorError(
          `写完之后抽样核对对不上（第 ${index + 1} 条记录的新列）。` +
            `备份在 ${replaced.backupPath ?? '（没有）'}`,
        );
      }
    }

    const caveats: string[] = [];
    if (stats.hits === 0) caveats.push('没有任何要素符合条件，这一列全是空值');
    if (truncated > 0) caveats.push(`${truncated} 处文字超过字段宽度，已按字符边界截断`);
    if (rounded > 0) caveats.push(`${rounded} 处数字按字段小数位四舍五入`);
    if (name !== input.fieldName) {
      caveats.push(`Shapefile 的列名最多 ${DBF_NAME_BYTES} 字节，实际写成了「${name}」`);
    }
    caveats.push('超大 Shapefile 按 DBF 流式改写，未改的字段原样拷贝');
    caveats.push(`抽样核对了 ${expected.size} 条，不是逐条核对`);

    return {
      kind: 'value',
      summary:
        `已加字段「${name}」：${stats.hits} 条要素赋了值（共 ${stats.total} 条）` +
        (caveats.length > 0 ? `（${caveats.join('；')}）` : ''),
      data: {
        target: input.targetRel,
        fieldName: name,
        requestedName: input.fieldName,
        updated: stats.hits,
        total: stats.total,
        columnType: plan.label,
        backupPath: replaced.backupPath,
        ...(truncated > 0 ? { truncated } : {}),
        ...(rounded > 0 ? { rounded } : {}),
        streamed: true,
      },
    };
  } catch (err) {
    if (fd >= 0) closeSync(fd);
    try {
      await store.remove(tempRel);
    } catch {
      /* 临时文件清不掉不影响结果 */
    }
    throw err;
  }
}

/** 统计新列的值类型 */
function trackNewValue(
  stats: AddStats,
  value: unknown,
  index: number,
  encoding: SupportedEncoding,
): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new VectorError(`第 ${index + 1} 条记录算出来的不是有限数字：${value}`);
    }
    if (Number.isInteger(value)) stats.anyInteger = true;
    else stats.anyReal = true;
  } else if (typeof value === 'boolean') {
    stats.anyBool = true;
  } else if (typeof value === 'string') {
    stats.anyText = true;
    const bytes = encodeText(value, encoding).length;
    if (bytes > stats.maxTextBytes) stats.maxTextBytes = bytes;
  } else {
    throw new VectorError(`第 ${index + 1} 条记录算出来的值写不进属性表：${JSON.stringify(value)}`);
  }
}

/** 新列的类型计划 */
function planNewField(stats: AddStats): {
  type: string;
  length: number;
  decimals: number;
  label: string;
} {
  const mixedNumbers = stats.anyBool && (stats.anyInteger || stats.anyReal);
  if (stats.anyText || mixedNumbers) {
    // 纯文字：按最长值定宽；混了数字/布尔：用最大宽度，写的时候转成文字
    const pureText = stats.anyText && !stats.anyInteger && !stats.anyReal && !stats.anyBool;
    const length = pureText ? Math.min(254, Math.max(1, stats.maxTextBytes)) : 254;
    return { type: 'C', length, decimals: 0, label: `C(${length})` };
  }
  if (stats.anyReal) return { type: 'N', length: 20, decimals: 6, label: 'N(20,6)' };
  if (stats.anyInteger) return { type: 'N', length: 20, decimals: 0, label: 'N(20,0)' };
  if (stats.anyBool) return { type: 'L', length: 1, decimals: 0, label: 'L' };
  return { type: 'C', length: 1, decimals: 0, label: 'C(1)' };
}

/* ── 删要素 ──────────────────────────────────────────────────── */

export interface ShpDeleteInput {
  readonly targetRel: string;
  readonly absPath: string;
  readonly info: LayerInfo;
  readonly whereSource: string;
  readonly whereNode: ExprNode;
  readonly keep: string;
  readonly dryRun: boolean;
}

/** 原生流式删要素：按 DBF 删除标记 */
export async function shpStreamDelete(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  input: ShpDeleteInput,
): Promise<OpValueResult> {
  void loc;
  const ctx = shpContext(input.targetRel, input.absPath, input.info);
  if (input.keep === 'largest') {
    throw new VectorError(
      '超大 Shapefile 暂不支持 keep=largest（要读几何逐条算面积）。' +
        '请改用 keep=first / keep=last，或先把范围拆小再删。',
    );
  }

  let total = 0;
  let matched = 0;
  let firstHitIndex: number | null = null;
  let lastHitIndex: number | null = null;
  let firstHitOrdinal: number | null = null;
  let lastHitOrdinal: number | null = null;
  forEachRecord(ctx, ({ buffer: record, index }) => {
    if (!isActiveRecord(record)) return;
    total += 1;
    const properties = decodeDbfRecord(record, ctx.header, ctx.info.fields);
    if (!hitAt(input.whereNode, properties, index)) return;
    matched += 1;
    if (firstHitIndex === null) {
      firstHitIndex = index;
      firstHitOrdinal = total;
    }
    lastHitIndex = index;
    lastHitOrdinal = total;
  });

  if (matched === 0) {
    throw new VectorError(
      `条件没有命中任何要素（0 条命中）：「${input.whereSource}」。` +
        `这一层一共 ${total} 条要素，一条都没删。` +
        '可能是条件太严，也可能是字段名写错了。',
    );
  }

  let deleted = matched;
  let keptIndex: number | null = null;
  let keptOrdinal: number | null = null;
  if (input.keep === 'first') {
    keptIndex = firstHitIndex;
    keptOrdinal = firstHitOrdinal;
    deleted = matched - 1;
  } else if (input.keep === 'last') {
    keptIndex = lastHitIndex;
    keptOrdinal = lastHitOrdinal;
    deleted = matched - 1;
  }
  if (deleted === 0) {
    throw new VectorError(
      `条件命中 ${matched} 条，但按 keep=${input.keep} 的规则要留下 1 条 —— 实际一条也删不掉。`,
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
        (keptOrdinal !== null
          ? `；keep=${input.keep}：保留第 ${keptOrdinal} 条`
          : '') +
        '（预演：没有写盘；超大 Shapefile 按 DBF 删除标记）',
      data: {
        target: input.targetRel,
        where: input.whereSource,
        keep: input.keep,
        matched,
        deleted,
        remaining,
        total,
        ...(keptOrdinal !== null
          ? { kept: { featureIndex: keptOrdinal, reason: `keep=${input.keep}` } }
          : {}),
        dryRun: true,
        streamed: true,
      },
    };
  }

  const backupPath = await createBackup(store, ctx.dbfRel, 'delete');
  if (!backupPath) {
    throw new VectorError('删之前没能建立 .dbf 备份，已停止（不会在没有备份的情况下改原文件）');
  }

  // 原地改删除标记：分块读、改、整块写回
  const fd = openSync(ctx.dbfAbs, 'r+');
  try {
    const perChunk = Math.max(1, Math.floor(CHUNK_BYTES / ctx.header.recordLength));
    let index = 0;
    let offset = ctx.header.headerLength;
    while (index < ctx.header.recordCount) {
      const count = Math.min(perChunk, ctx.header.recordCount - index);
      const chunk = Buffer.alloc(count * ctx.header.recordLength);
      const got = readSync(fd, chunk, 0, chunk.length, offset);
      if (got !== chunk.length) {
        throw new VectorError(`这个 .dbf 在读取第 ${index + 1} 条记录时提前结束，可能损坏。`);
      }
      let changed = false;
      for (let i = 0; i < count; i += 1) {
        const record = chunk.subarray(i * ctx.header.recordLength, (i + 1) * ctx.header.recordLength);
        if (!isActiveRecord(record)) continue;
        const recordIndex = index + i;
        if (recordIndex === keptIndex) continue;
        const properties = decodeDbfRecord(record, ctx.header, ctx.info.fields);
        if (!hitAt(input.whereNode, properties, recordIndex)) continue;
        record[0] = RECORD_DELETED;
        changed = true;
      }
      if (changed) {
        writeSync(fd, chunk, 0, chunk.length, offset);
      }
      index += count;
      offset += chunk.length;
    }
    const date = Buffer.from([0, 0, 0]);
    touchHeaderDate(date);
    writeSync(fd, date, 0, 3, 1);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  const afterHeader = readDbfHeader(ctx.shpAbs, ctx.dbfAbs);
  const afterActive = countActiveRecords(afterHeader, ctx.dbfAbs);
  if (afterActive !== remaining) {
    throw new VectorError(
      `删完之后要素数不对：应该剩 ${remaining} 条，实际 ${afterActive} 条。备份在 ${backupPath}`,
    );
  }

  return {
    kind: 'value',
    summary:
      `已删掉 ${deleted} 条要素（命中 ${matched} 条，共 ${total} 条）` +
      (keptOrdinal !== null ? `；keep=${input.keep}：保留第 ${keptOrdinal} 条` : '') +
      `，剩下 ${afterActive} 条（超大 Shapefile 按 DBF 删除标记；文件体积不变，` +
      '部分工具在压缩前仍按头里的记录数显示；需要彻底压缩请用 ArcGIS / QGIS 的压缩操作）',
    data: {
      target: input.targetRel,
      where: input.whereSource,
      keep: input.keep,
      matched,
      deleted,
      remaining: afterActive,
      total,
      ...(keptOrdinal !== null
        ? { kept: { featureIndex: keptOrdinal, reason: `keep=${input.keep}` } }
        : {}),
      backupPath,
      streamed: true,
    },
  };
}
