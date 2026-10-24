'use client';

/**
 * 值型 op 的结果表。
 *
 * 为什么需要它：`feature.summarize`（按字段分组汇总）是**纯读操作**，
 * 它的产出就是一张表 —— 只显示一句「分成 3 组」等于什么都没告诉用户。
 * 表格是它的正身，必须显示出来。
 *
 * 为什么只渲染「像表的数据」而不是任意 data：
 * 各 op 的 data 形状不同（属性表可能是几千条要素、编码转换只有几个计数），
 * 没有 columns + rows 这两个字段的，一律不渲染 —— 宁可少显示，
 * 也不能把一堆 JSON 原样糊到界面上。
 */
import type { ReactNode } from 'react';

/** 能渲染成表的数据形状 */
export interface TableLikeData {
  readonly columns?: readonly string[];
  readonly rows?: readonly Record<string, unknown>[];
}

/** asTableData 的返回类型：columns 与 rows 到这里都是确定的 */
interface ResolvedTable {
  readonly columns: string[];
  readonly rows: Record<string, unknown>[];
}

/** 一次最多显示多少行（再多就把界面撑坏了，而用户要的是前几行） */
const MAX_ROWS = 50;

/** 判断这是不是一个能渲染成表的结果 */
export function asTableData(data: unknown): ResolvedTable | null {
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Record<string, unknown>;
  const columns = o['columns'];
  const rows = o['rows'];
  if (!Array.isArray(columns) || !Array.isArray(rows)) return null;
  if (columns.length === 0) return null;
  const clean: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (typeof r !== 'object' || r === null) continue;
    clean.push(r as Record<string, unknown>);
  }
  return { columns: columns.map((c) => String(c)), rows: clean };
}

/** 单元格的值：数字按本地格式，null 显示成破折号，其余走字符串 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return value.toLocaleString('zh-CN');
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * 渲染一张结果表。
 *
 * @param data 值型 op 的 data
 * @param caption 表上方的一句说明（如「按「类型」分成 3 组」）
 */
export default function ValueTable({
  data,
  caption,
}: {
  readonly data: unknown;
  readonly caption?: string | null;
}): ReactNode {
  const table = asTableData(data);
  if (!table || !table.columns) return null;
  const shown = table.rows.slice(0, MAX_ROWS);
  const rest = table.rows.length - shown.length;

  return (
    <div className="mt-2">
      {caption ? <div className="mb-1.5 text-[11.5px] text-studio-ink-3">{caption}</div> : null}
      <div className="max-h-[280px] overflow-auto rounded border border-studio-line bg-studio-2/60">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 bg-studio-3/80">
            <tr>
              {table.columns.map((c) => (
                <th
                  key={c}
                  className="border-b border-studio-line px-2.5 py-1.5 text-[11px] font-medium text-studio-ink-2"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i} className="border-b border-studio-line/40 last:border-b-0">
                {table.columns?.map((c) => (
                  <td key={c} className="px-2.5 py-1 font-mono text-[11.5px] text-studio-ink">
                    {cellText(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rest > 0 ? (
        <p className="mt-1 text-[11px] text-studio-ink-3">还有 {rest} 行没显示（上面是前 {MAX_ROWS} 行）。</p>
      ) : null}
    </div>
  );
}
