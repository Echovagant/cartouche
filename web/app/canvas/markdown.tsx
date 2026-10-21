/**
 * 极简 Markdown 渲染。
 *
 * 为什么自己写而不引 markdown 库：
 *   - 兼容性报告的结构是**我们自己定的**（服务端 compat-report.ts 产出），
 *     用到的语法只有标题、引用、列表、任务项、表格、分隔线这几种，
 *     完整实现要引 remark/rehype 一整条链（几十个包、还得审许可）；
 *   - 报告最终要**原样转给 GIS 同事**，宁可渲染得朴素，也不要引一个把
 *     中文标点、空格、行内代码吃掉一半的渲染器。
 *
 * 只覆盖上面那几种语法；遇到不认识的一律按纯文本显示，不丢内容。
 */
'use client';

import { useMemo, type CSSProperties, type ReactNode } from 'react';

interface ListItem {
  readonly text: string;
  /** 任务项的勾选状态；null 表示不是任务项 */
  readonly checked: boolean | null;
}

type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'quote'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: ListItem[] }
  | { readonly kind: 'table'; readonly head: string[]; readonly rows: string[][] }
  | { readonly kind: 'hr' }
  | { readonly kind: 'paragraph'; readonly text: string };

// 颜色一律走 Tailwind token（见 app/globals.css 的 studio 色阶），这里不再留硬编码色值。


/** 表格行的分隔符判断：| --- | :--- | 之类 */
const TABLE_DIVIDER = /^\|?[\s:|-]*-[\s:|-]*\|?$/;

function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isListStart(line: string): boolean {
  return /^\s*([-*+]|\d+\.)\s+/.test(line);
}

/** 把 Markdown 拆成块级结构 */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const line = raw.trim();

    if (line === '') {
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    if (line.startsWith('>')) {
      const buffer: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('>')) {
        buffer.push((lines[i] ?? '').trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', text: buffer.join(' ') });
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes('|') && TABLE_DIVIDER.test((lines[i + 1] ?? '').trim())) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').trim().includes('|')) {
        rows.push(splitRow((lines[i] ?? '').trim()));
        i += 1;
      }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }

    if (isListStart(raw)) {
      const ordered = /^\s*\d+\./.test(raw);
      const items: ListItem[] = [];
      while (i < lines.length && isListStart(lines[i] ?? '')) {
        const match = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[i] ?? '');
        const text = match?.[2] ?? '';
        const task = /^\[([ xX])\]\s*(.*)$/.exec(text);
        if (task) {
          items.push({ text: task[2] ?? '', checked: (task[1] ?? '').toLowerCase() === 'x' });
        } else {
          items.push({ text, checked: null });
        }
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // 段落：连续的普通行合成一段
    const buffer: string[] = [];
    while (i < lines.length) {
      const current = (lines[i] ?? '').trim();
      if (
        current === '' ||
        /^#{1,6}\s/.test(current) ||
        current.startsWith('>') ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(current) ||
        isListStart(lines[i] ?? '')
      ) {
        break;
      }
      buffer.push(current);
      i += 1;
    }
    if (buffer.length > 0) blocks.push({ kind: 'paragraph', text: buffer.join(' ') });
  }

  return blocks;
}

/** 行内标记：**粗体**、`代码`、*斜体* */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;
  let last = 0;
  let index = 0;
  let match: RegExpExecArray | null = pattern.exec(text);

  while (match !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    index += 1;
    if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), `${key}i`)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="rounded border border-studio-line bg-studio-3/60 px-1 py-px font-mono text-[0.92em] text-studio-ink"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), `${key}i`)}</em>);
    }
    last = match.index + token.length;
    match = pattern.exec(text);
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function headingStyle(level: number): CSSProperties {
  const sizes = [20, 16, 14, 13, 12, 12];
  return {
    margin: level <= 2 ? '18px 0 8px' : '14px 0 6px',
    fontSize: sizes[level - 1] ?? 12,
    fontWeight: 600,
    lineHeight: 1.4,
  };
}

/**
 * 渲染一段 Markdown。
 * 全部用 Tailwind 类名，与界面其余部分共用一套 token。
 */
export function MarkdownView({ source }: { source: string }): ReactNode {
  const blocks = useMemo(() => parseBlocks(source), [source]);

  return (
    <div className="text-[13.5px] leading-[1.75] text-studio-ink-2">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'heading':
            return (
              <div key={key} style={headingStyle(block.level)} className="text-studio-ink">
                {renderInline(block.text, key)}
              </div>
            );
          case 'quote':
            return (
              <blockquote
                key={key}
                className="my-2 rounded-r border-l-2 border-accent/45 bg-accent-soft/45 py-1.5 pr-3 pl-3 text-studio-ink-2"
              >
                {renderInline(block.text, key)}
              </blockquote>
            );
          case 'hr':
            return <hr key={key} className="my-4 border-0 border-t border-studio-line" />;
          case 'list':
            return (
              <ul key={key} className="my-1.5 list-disc pl-5">
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`} className="my-0.5">
                    {item.checked === null ? null : (
                      <input
                        type="checkbox"
                        checked={item.checked}
                        readOnly
                        className="mr-1.5 align-middle accent-[#2f6f5e]"
                      />
                    )}
                    {renderInline(item.text, `${key}-${itemIndex}`)}
                  </li>
                ))}
              </ul>
            );
          case 'table':
            return (
              <div key={key} className="my-2 overflow-x-auto">
                <table className="w-full border-collapse text-[12.5px]">
                  <thead>
                    <tr>
                      {block.head.map((cell, cellIndex) => (
                        <th
                          key={`${key}-h${cellIndex}`}
                          className="border border-studio-line bg-studio-3/60 px-2 py-1.5 text-left font-medium whitespace-nowrap text-studio-ink"
                        >
                          {renderInline(cell, `${key}-h${cellIndex}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${key}-r${rowIndex}`}>
                        {row.map((cell, cellIndex) => (
                          <td
                            key={`${key}-r${rowIndex}c${cellIndex}`}
                            className="border border-studio-line px-2 py-1.5 align-top"
                          >
                            {renderInline(cell, `${key}-r${rowIndex}c${cellIndex}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'paragraph':
          default:
            return (
              <p key={key} className="my-2">
                {renderInline(block.text, key)}
              </p>
            );
        }
      })}
    </div>
  );
}
