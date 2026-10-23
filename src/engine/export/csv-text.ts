/**
 * CSV 的拼装与解析。
 *
 * 为什么不引第三方 CSV 库：报表的列数不多，字段里最多有逗号、引号和换行；
 * 引一个库要多一份许可审核与依赖面，而这件事一百来行就能写对。
 *
 * 口径与 RFC 4180 一致：分隔符是逗号、记录用 CRLF 结束、
 * 字段里的引号写成两个、含分隔符/引号/换行的字段用双引号包起来。
 */

/** 字段转义：需要时才加引号 */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** 一行（自带行尾） */
export function csvRow(values: readonly string[]): string {
  return `${values.map(csvEscape).join(',')}\r\n`;
}

/** 整张表 */
export function csvTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return csvRow(header) + rows.map(csvRow).join('');
}

/**
 * 解析 CSV 文本 → 行 → 列。
 *
 * 自己写状态机而不是 split(',')：字段里可能有逗号（"北京市,朝阳区"）、
 * 引号（"他说""好"""）甚至换行 —— 按逗号硬切会把一条记录切成好几条。
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  // 去掉 BOM：Excel 导出的 CSV 常带 UTF-8 BOM，不去掉会让第一列名多出三个字符
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      // CRLF 与 LF 都算行尾
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // 末尾没有换行时也要把最后一行交出去
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * CSV 文本 → 记录数组（第一行当表头）。
 *
 * 列数不齐的行按表头长度补齐或截断：OGR 写出来的 CSV 偶尔会有空行，
 * 不补齐的话下游按列号取值会拿到 undefined。
 */
export function parseCsvRecords(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text).filter((r) => r.length > 1 || (r[0] ?? '').trim() !== '');
  const header = rows[0] ?? [];
  const out: Array<Record<string, string>> = [];
  for (const r of rows.slice(1)) {
    const rec: Record<string, string> = {};
    header.forEach((name, idx) => {
      rec[name] = r[idx] ?? '';
    });
    out.push(rec);
  }
  return out;
}
