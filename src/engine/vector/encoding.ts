/**
 * 属性表（DBF）编码的识别。
 *
 * 为什么单独一个文件：字段重命名与重编码两个 op 都要读 .cpg、都要回答
 * "这个文件现在是什么编码"。这件事只有一份可靠的做法 —— 两处各写一遍，
 * 就会出现「重命名说它是 GBK、重编码说它是 UTF-8」这种自相矛盾的结论，
 * 而用户看到的正是这两句话。
 *
 * ## 编码是怎么被认出来的
 *
 * 1. **.cpg 标记**（首选）：Shapefile 旁边的编码标记文件，写着 "GBK" / "UTF-8" 之类。
 *    这是数据生产者自己声明的，最可信。
 * 2. **按字节猜**（.cpg 缺失时）：读 .dbf 的记录区，按「严格解码 + 能不能解出汉字」判断。
 *    判据与取舍写在 `probeEncodingFromBytes` 里。
 *
 * 猜不出来时**报错**，不猜一个默认值接着往下走：编码猜错的后果是
 * 「转完之后中文变成乱码」，而用户往往要到下一次打开文件才发现。
 */
import { existsSync, readFileSync } from 'node:fs';
import { VectorError } from './types.ts';

/** 引擎支持的属性表编码（与契约里 vector.recode 的取值一致）。 */
export const SUPPORTED_ENCODINGS = ['GBK', 'UTF-8', 'LATIN1'] as const;

export type SupportedEncoding = (typeof SUPPORTED_ENCODINGS)[number];

/**
 * 编码别名 → 引擎口径。
 *
 * 为什么要有别名表：现实里的 .cpg 写的是五花八门的名字
 * （GB2312 / CP936 / ISO-8859-1 / ANSI …），它们指向同一套字节。
 * 只认字面量的话，用户看到「.cpg 里写的是 CP936」却得到一句「不支持」，
 * 而实际上换个名字就能转。
 */
const ENCODING_ALIASES: Readonly<Record<string, SupportedEncoding>> = {
  gbk: 'GBK',
  gb2312: 'GBK',
  gb_2312: 'GBK',
  gb18030: 'GBK',
  cp936: 'GBK',
  ms936: 'GBK',
  'windows-936': 'GBK',
  'utf-8': 'UTF-8',
  utf8: 'UTF-8',
  'utf_8': 'UTF-8',
  latin1: 'LATIN1',
  'latin-1': 'LATIN1',
  'iso-8859-1': 'LATIN1',
  'iso8859-1': 'LATIN1',
  'iso_8859-1': 'LATIN1',
  cp1252: 'LATIN1',
  windows1252: 'LATIN1',
};

/** 把任意写法归一到引擎口径；认不出来返回 null（不猜）。 */
export function normalizeEncoding(raw: string | null | undefined): SupportedEncoding | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (key === '') return null;
  return ENCODING_ALIASES[key] ?? null;
}

/** Shapefile 旁边的 .cpg 路径。 */
function cpgPathOf(shpPath: string): string {
  return shpPath.replace(/\.shp$/i, '.cpg');
}

/** .dbf 路径。 */
function dbfPathOf(shpPath: string): string {
  return shpPath.replace(/\.shp$/i, '.dbf');
}

/** 读 .cpg 里的编码声明；没有 .cpg 或读不出来返回 null。 */
export function readCpgEncoding(shpPath: string): string | null {
  const p = cpgPathOf(shpPath);
  if (!existsSync(p)) return null;
  try {
    const text = readFileSync(p, 'utf8').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/** 严格解码：解不开就返回 null（不拿替换字符糊弄）。 */
function strictDecode(bytes: Buffer, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 解出来的文本里有没有汉字。 */
function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff\U00020000-\U0002ffff]/.test(text);
}

/**
 * .dbf 的记录区（去掉头部与字段描述表）。
 *
 * 为什么只取记录区：头部与字段描述里也有字节（字段名本身可能是中文），
 * 但它们的结构固定、长度已知，混进来会干扰"这串字节像不像某种编码"的判断。
 * 记录区才是属性值本身。
 *
 * DBF 头：第 8~9 字节是头长度（小端 uint16），记录区从那儿开始。
 */
function dbfRecordArea(bytes: Buffer): Buffer | null {
  if (bytes.length < 33) return null;
  const headerLength = bytes.readUInt16LE(8);
  if (headerLength < 33 || headerLength >= bytes.length) return null;
  return bytes.subarray(headerLength);
}

/** 记录区是不是纯 ASCII。 */
function isAsciiArea(area: Buffer): boolean {
  for (const b of area) {
    if (b >= 0x80) return false;
  }
  return true;
}

/** 按字节猜属性表的编码；定不下来返回 null。
 *
 * 判据与取舍（实测过几组真实字节）：
 *  - **只有 UTF-8 解得开** → UTF-8（GBK 的双字节序列绝大多数不是合法 UTF-8）；
 *  - **只有 GBK 解得开** → GBK；
 *  - **两种都解得开**：看谁解出汉字 —— 同一串字节按 UTF-8 解与按 GBK 解
 *    **都可能**给出汉字，这时唯一的额外线索是"UTF-8 能解出汉字"：
 *    UTF-8 的多字节序列有严格的长度与取值约束，能解出汉字的 UTF-8 字节流
 *    几乎不可能是 GBK 凑出来的；
 *  - **两种都解得开且都不是汉字** → 定不下来（返回 null，由调用方报错）；
 *  - **两种都解不开** → 定不下来（返回 null，由调用方报错）。
 *
 * 纯 ASCII 单独处理：任何编码都解得通，编码之争没有意义。
 */
export function probeEncodingFromBytes(dbfBytes: Buffer): SupportedEncoding | null {
  const area = dbfRecordArea(dbfBytes);
  if (!area || area.length === 0) return null;
  if (isAsciiArea(area)) return null;

  const utf8 = strictDecode(area, 'utf-8');
  const gbk = strictDecode(area, 'gbk');
  if (utf8 !== null && gbk === null) return 'UTF-8';
  if (gbk !== null && utf8 === null) return 'GBK';
  if (utf8 !== null && gbk !== null) {
    if (hasCjk(utf8)) return 'UTF-8';
    if (hasCjk(gbk)) return 'GBK';
  }
  return null;
}

/** 记录区能不能被指定编码严格解开。 */
export function canDecodeWith(dbfBytes: Buffer, encoding: SupportedEncoding): boolean {
  const area = dbfRecordArea(dbfBytes);
  if (!area || area.length === 0) return true;
  const label = encoding === 'GBK' ? 'gbk' : encoding === 'UTF-8' ? 'utf-8' : 'latin1';
  return strictDecode(area, label) !== null;
}

/** 记录区是不是纯 ASCII（纯 ASCII 时编码之争没有意义）。 */
export function isAsciiOnlyDbf(dbfPath: string): boolean {
  if (!existsSync(dbfPath)) return true;
  try {
    const bytes = readFileSync(dbfPath);
    const area = dbfRecordArea(bytes);
    if (!area) return true;
    return isAsciiArea(area);
  } catch {
    return true;
  }
}

export interface DetectedEncoding {
  /** 认出来的编码 */
  readonly encoding: SupportedEncoding;
  /** 依据：.cpg 标记 还是 字节探测 */
  readonly source: 'cpg' | 'probe';
  /** 需要让用户知道的补充说明（例如"内容全是 ASCII，编码之争没有意义"） */
  readonly note?: string;
}

/**
 * 认出一个 Shapefile 的属性表编码。
 *
 * @throws {VectorError} .cpg 说的编码认不出来、或 .cpg 与实际字节对不上、或完全探测不出来。
 *
 * ⚠️ **.cpg 与字节对不上时报错，不按 .cpg 硬转**：
 * 真实数据里 .cpg 写错的情况不少（拿 UTF-8 的文件标成 GBK 是常见的一类）。
 * 按标记硬转的结局是「转完之后中文变成另一批汉字」，而用户要等到下次打开文件才发现。
 * 这里当场报错，并让用户用 `from` 显式指定真实编码 —— 显式指定就是用户在做判断。
 */
export function detectEncoding(shpPath: string): DetectedEncoding {
  const cpgRaw = readCpgEncoding(shpPath);
  const cpgEnc = normalizeEncoding(cpgRaw);
  const dbf = dbfPathOf(shpPath);
  const dbfBytes = existsSync(dbf) ? readFileSync(dbf) : null;

  if (cpgRaw !== null && cpgEnc === null) {
    throw new VectorError(
      `.cpg 里写的编码「${cpgRaw}」认不出来（本引擎只认 ${SUPPORTED_ENCODINGS.join('、')}）。` +
        '请显式给 from 指定编码。',
    );
  }

  const probed = dbfBytes ? probeEncodingFromBytes(dbfBytes) : null;

  if (cpgEnc !== null) {
    if (probed !== null && probed !== cpgEnc) {
      throw new VectorError(
        `.cpg 说这个文件的编码是 ${cpgEnc}，但属性表的字节按 ${probed} 才解得通（标记与内容对不上）。` +
          `按标记硬转会把中文转成乱码，所以没有继续。确认真实编码后用 from 指定（${SUPPORTED_ENCODINGS.join('、')}）。`,
      );
    }
    if (probed === null && dbfBytes !== null && !isAsciiOnlyDbf(dbf)) {
      if (!canDecodeWith(dbfBytes, cpgEnc)) {
        throw new VectorError(
          `.cpg 说这个文件的编码是 ${cpgEnc}，但属性表的字节按 ${cpgEnc} 解不开（标记与内容对不上）。` +
            `请显式给 from 指定真实编码（${SUPPORTED_ENCODINGS.join('、')}）。`,
        );
      }
    }
    return { encoding: cpgEnc, source: 'cpg' };
  }

  if (probed !== null) return { encoding: probed, source: 'probe' };

  if (dbfBytes !== null && isAsciiOnlyDbf(dbf)) {
    // 纯 ASCII：ASCII 是所有这些编码的子集，按哪种解码内容都一样 ——
    // 这里给一个明确结论并说明它不唯一，而不是装作"探测成功"。
    return {
      encoding: 'UTF-8',
      source: 'probe',
      note: '属性表里全是 ASCII 字符，各编码解出来完全相同，编码之争没有实际影响（按 UTF-8 处理）',
    };
  }

  throw new VectorError(
    '探测不出这个文件的属性表编码：没有 .cpg 标记，按字节试解也定不下来' +
      '（字节既不是 GBK 也不是 UTF-8）。请显式给 from 指定编码' +
      `（${SUPPORTED_ENCODINGS.join('、')}）。`,
  );
}

/**
 * 写回时该用哪个编码。
 *
 * 为什么要专门算一遍：writeFeatures 默认写 UTF-8。对一个 GBK 的图层做字段重命名，
 * 顺带把编码换成 UTF-8 是一次**用户没要求的改动** —— 属性值看着一样，
 * 但别的工具按 .cpg 解就会出错。所以这里把源编码原样带过去。
 *
 * 探不出来时退回 UTF-8：UTF-8 是唯一能装下所有字符的编码，
 * 写失败会回滚，写坏文件不会。
 */
export function encodingForWriteback(shpPath: string): SupportedEncoding {
  const cpgEnc = normalizeEncoding(readCpgEncoding(shpPath));
  if (cpgEnc !== null) return cpgEnc;
  try {
    const dbf = dbfPathOf(shpPath);
    if (existsSync(dbf)) {
      const probed = probeEncodingFromBytes(readFileSync(dbf));
      if (probed !== null) return probed;
    }
  } catch {
    /* 读不到就按 UTF-8 走 */
  }
  return 'UTF-8';
}
