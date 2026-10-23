/**
 * 极简 Markdown → HTML。
 *
 * 为什么不用第三方 Markdown 库：兼容性报告的正文是**我们自己生成的**，
 * 用到的只有标题、列表、引用、加粗、行内代码、分隔线这几种；
 * 引一个库要多一份许可审核与依赖面，而这个子集一百来行就能写对。
 *
 * 遇到不认识的结构**原样保留**（转义后放进段落）——
 * 宁可排版差一点，也不能把内容丢掉：报告是要转给 GIS 同事照着做的材料。
 */

/** HTML 转义 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 行内标记：`**加粗**` 与 `` `代码` ``。
 *
 * 顺序有讲究：先抽出行内代码（代码里可能有星号），再抽加粗，最后才转义 HTML。
 */
function inline(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => `<code>${escapeHtml(codes[Number(idx)] ?? '')}</code>`);
  return s;
}

/**
 * Markdown → HTML 片段。
 *
 * 只处理这个子集：# / ## / ### 标题、- 列表（含 `- [ ]` 勾选项与两级缩进）、
 * `>` 引用、`---` 分隔线、空行分段、其余按段落。
 */
export function markdownToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let listDepth = -1;

  const closeList = (to: number) => {
    while (listDepth > to) {
      out.push('</ul>');
      listDepth--;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') {
      closeList(-1);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      closeList(-1);
      out.push('<hr>');
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      closeList(-1);
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeList(-1);
      out.push(`<blockquote>${inline(quote[1]!)}</blockquote>`);
      continue;
    }
    const item = /^(\s*)-\s+(.*)$/.exec(line);
    if (item) {
      // 两格缩进算一级：报告里的子项就是这么缩的
      const depth = Math.min(1, Math.floor(item[1]!.length / 2));
      if (depth > listDepth) {
        out.push('<ul>');
        listDepth = depth;
      } else {
        closeList(depth);
      }
      const body = item[2]!;
      const checkbox = /^\[([ xX])\]\s+(.*)$/.exec(body);
      if (checkbox) {
        const checked = checkbox[1]!.toLowerCase() === 'x';
        out.push(
          `<li class="check"><input type="checkbox" disabled${checked ? ' checked' : ''}> ${inline(checkbox[2]!)}</li>`,
        );
      } else {
        out.push(`<li>${inline(body)}</li>`);
      }
      continue;
    }
    closeList(-1);
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(-1);
  return out.join('\n');
}

/** 一个完整的 HTML 文档（报表直接给人看，要能双击打开） */
export function htmlDocument(title: string, bodyHtml: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    'body{font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1.25rem;line-height:1.7;color:#1c1c1e;background:#fff}',
    'h1{font-size:1.6rem;border-bottom:2px solid #1c1c1e;padding-bottom:.4rem}',
    'h2{font-size:1.2rem;margin-top:2rem;border-left:4px solid #1c1c1e;padding-left:.6rem}',
    'h3{font-size:1.05rem;margin-top:1.4rem}',
    'table{border-collapse:collapse;width:100%;margin:.8rem 0}',
    'th,td{border:1px solid #d4d4d8;padding:.45rem .6rem;text-align:left;vertical-align:top;font-size:.92rem}',
    'th{background:#f4f4f6;font-weight:600}',
    'code{background:#f4f4f6;padding:.1rem .3rem;border-radius:3px;font-family:Consolas,monospace;font-size:.9em}',
    'blockquote{margin:.6rem 0;padding:.4rem .9rem;border-left:3px solid #c7c7cc;background:#fafafa;color:#3a3a3c}',
    'hr{border:0;border-top:1px solid #d4d4d8;margin:1.6rem 0}',
    'ul.check{list-style:none;padding-left:0}',
    '</style>',
    '</head>',
    '<body>',
    bodyHtml,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
