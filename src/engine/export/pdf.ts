/**
 * 零依赖的最小 PDF 封装器：把一张 JPEG 贴进单页 PDF。
 *
 * 为什么不引第三方 PDF 库：
 *   - 我们的出图目标只是"能交差"（docs/06 §3.2），一张图 + 图框 + 标题栏就够；
 *   - 引一个 PDF 库要多一份许可审核与依赖面，而这件事 **80 行就能自己写对**；
 *   - 图面要素（比例尺/图例/指北针/图框/标题栏）由**前端 canvas** 画好再导出 JPEG，
 *     所以这里**不需要嵌中文字体**（PDF 内嵌字体是另一条复杂得多的路）。
 *
 * 产出结构（PDF 1.4）：
 *   Catalog → Pages → Page → Contents（画 XObject）+ XObject（JPEG，DCTDecode）
 *
 * 注意：xref 表里的字节偏移必须精确，差一个字节 PDF 就不合法 —— 所以这里全部按字节拼。
 */

/** A4 横版（点） */
export const A4_LANDSCAPE_PT = { width: 841.89, height: 595.28 } as const;
/** A4 竖版（点） */
export const A4_PORTRAIT_PT = { width: 595.28, height: 841.89 } as const;

export interface PdfOptions {
  /** 页面尺寸（点） */
  readonly pageWidthPt?: number;
  readonly pageHeightPt?: number;
  /** 图纸 DPI —— 用来把像素尺寸换算成页面上的物理尺寸 */
  readonly dpi?: number;
  /** 图片四周留白（点） */
  readonly marginPt?: number;
  /** 文档标题（写进 PDF 元数据，非 ASCII 会被替换） */
  readonly title?: string;
  /** 作者（写进 PDF 元数据） */
  readonly author?: string;
  /** 产地说明（写进 PDF 元数据） */
  readonly producer?: string;
}

export class PdfBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfBuildError';
  }
}

function latin1(text: string): string {
  // PDF 的文本字符串按 Latin-1 解释；非 Latin-1 字符换成 '?'
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0x3f;
    out += code >= 0x20 && code <= 0x7e ? ch : code <= 0xff ? ch : '?';
  }
  return out;
}

function escapePdfString(text: string): string {
  return latin1(text).replace(/([\\()])/g, '\\$1');
}

/**
 * 把 JPEG 封装成单页 PDF。
 *
 * @param jpeg        JPEG 字节（必须是 JPEG，PDF 用 DCTDecode 直接嵌原始字节）
 * @param pixelWidth  图片像素宽
 * @param pixelHeight 图片像素高
 */
export function buildPdfFromJpeg(
  jpeg: Uint8Array,
  pixelWidth: number,
  pixelHeight: number,
  options: PdfOptions = {},
): Uint8Array {
  if (jpeg.length < 4) throw new PdfBuildError('JPEG 数据为空');
  // JPEG SOI 标记：FF D8
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new PdfBuildError('传入的数据不是 JPEG（缺少 FFD8 起始标记）');
  }
  if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight) || pixelWidth <= 0 || pixelHeight <= 0) {
    throw new PdfBuildError(`图片尺寸非法：${pixelWidth}×${pixelHeight}`);
  }

  const pageWidth = options.pageWidthPt ?? A4_LANDSCAPE_PT.width;
  const pageHeight = options.pageHeightPt ?? A4_LANDSCAPE_PT.height;
  const margin = options.marginPt ?? 24;
  const dpi = options.dpi ?? 150;

  // 像素 → 点：像素 / dpi × 72
  const drawWidth = (pixelWidth / dpi) * 72;
  const drawHeight = (pixelHeight / dpi) * 72;

  // 等比缩放到页面内（留边后），居中
  const availWidth = pageWidth - margin * 2;
  const availHeight = pageHeight - margin * 2;
  const scale = Math.min(availWidth / drawWidth, availHeight / drawHeight, 1);
  const imgWidth = drawWidth * scale;
  const imgHeight = drawHeight * scale;
  const imgX = (pageWidth - imgWidth) / 2;
  const imgY = (pageHeight - imgHeight) / 2;

  const content = [
    'q',
    // 图框
    `${margin / 2} ${margin / 2} ${pageWidth - margin} ${pageHeight - margin} re S`,
    'Q',
    'q',
    `${imgWidth.toFixed(3)} 0 0 ${imgHeight.toFixed(3)} ${imgX.toFixed(3)} ${imgY.toFixed(3)} cm`,
    '/Im0 Do',
    'Q',
  ].join('\n');

  const infoParts = [
    `/Title (${escapePdfString(options.title ?? 'Cartouche export')})`,
    `/Producer (${escapePdfString(options.producer ?? 'Cartouche')})`,
  ];
  if (options.author) infoParts.push(`/Author (${escapePdfString(options.author)})`);

  const objects: string[] = [];
  // 1 Catalog, 2 Pages, 3 Page, 4 Contents, 5 Image, 6 Info
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(
    '<< /Type /Page /Parent 2 0 R ' +
      `/MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] ` +
      '/Resources << /XObject << /Im0 5 0 R >> >> ' +
      '/Contents 4 0 R >>',
  );
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objects.push(
    '<< /Type /XObject /Subtype /Image ' +
      `/Width ${pixelWidth} /Height ${pixelHeight} ` +
      '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ' +
      `/Length ${jpeg.length} >>\nstream\n`,
  );
  objects.push(`<< ${infoParts.join(' ')} >>`);

  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  let offset = 0;
  const push = (s: string | Uint8Array) => {
    const bytes = typeof s === 'string' ? enc.encode(s) : s;
    chunks.push(bytes);
    offset += bytes.length;
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    push(`${i + 1} 0 obj\n${body}\n`);
    if (i === 4) {
      // 第 5 个对象（图像）的流数据是二进制，单独接上
      push(jpeg);
      push('\nendstream\nendobj\n');
      return;
    }
    push('endobj\n');
  });

  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\n`;
  xref += `startxref\n${xrefStart}\n%%EOF\n`;
  push(xref);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/**
 * 自检：验证产出的 PDF 结构基本合法（供测试与 CI 使用）。
 */
export function inspectPdf(pdf: Uint8Array): {
  valid: boolean;
  version: string;
  pageCount: number;
  objectCount: number;
  hasImage: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  const text = new TextDecoder('latin1').decode(pdf);
  const header = text.slice(0, 8);
  const version = header.startsWith('%PDF-') ? header.slice(0, 8).trim() : '';
  if (!version) issues.push('缺少 %PDF- 文件头');
  if (!text.trimEnd().endsWith('%%EOF')) issues.push('缺少 %%EOF 结束标记');
  if (!text.includes('/Type /Catalog')) issues.push('缺少 Catalog');
  if (!text.includes('/Type /Page ')) issues.push('缺少 Page');
  if (!text.includes('/Type /Pages')) issues.push('缺少 Pages');

  const pageCount = Number(/\/Count (\d+)/.exec(text)?.[1] ?? 0);
  const objectCount = (text.match(/^\d+ 0 obj$/gm) ?? []).length;
  const hasImage = text.includes('/Subtype /Image') && text.includes('/DCTDecode');

  // xref 起点自洽性：startxref 指向的数字应落在文件内
  const sx = Number(/startxref\s+(\d+)/.exec(text)?.[1] ?? -1);
  if (sx < 0 || sx >= pdf.length) issues.push(`startxref 偏移越界：${sx}`);

  return {
    valid: issues.length === 0,
    version,
    pageCount,
    objectCount,
    hasImage,
    issues,
  };
}
