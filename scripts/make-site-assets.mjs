#!/usr/bin/env node
/**
 * 站点素材准备：把真实界面截图裁成官网用的图片。
 *
 * 为什么要有这一步：
 *   官网页面要放**真实产品截图**（确认卡 / 出图 / 自检报告），
 *   而这些截图原来只存在于 shots/ 与 assets/ 里 —— 前者是验收临时产物（.gitignore），
 *   后者是给 README 用的整屏图。官网要的是**裁到主体**、按 web 体积压过的版本。
 *
 * 产出：web/public/site/*.jpg
 *   - confirm-card.jpg  确认卡（从整屏截图里裁出卡片本体）
 *   - canvas-frame.jpg  带图框的成图（沿用 README 那张）
 *   - report.jpg        六段式自检报告（沿用 README 那张）
 *
 * 以及：
 *   - china-sheet.webp  首屏主图的网页版（由 china-sheet.png 转出）
 *
 * 单独跑：node scripts/make-site-assets.mjs
 */
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'web', 'public', 'site');

/**
 * 裁切 + 压缩。用系统自带的图像栈，不引第三方依赖——
 * 这个仓库的依赖许可门禁只放行宽松许可的包，能不装就不装。
 *
 * @param {string} src 输入
 * @param {string} dst 输出
 * @param {{x:number,y:number,w:number,h:number}} box 裁切框（源图像素）
 * @param {number} maxW 输出最大宽度
 */
async function cropToJpeg(src, dst, box, maxW) {
  if (!existsSync(src)) {
    console.warn(`[site-assets] 跳过（源不存在）：${src}`);
    return false;
  }
  // Windows 自带 WIC 编码器：通过 .NET 侧实现，Node 侧只负责调度。
  // 这里改为直接调用一个内联的 PowerShell 片段。
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = '${src.replace(/'/g, "''")}'
$dst = '${dst.replace(/'/g, "''")}'
$img = [System.Drawing.Image]::FromFile($src)
$box = New-Object System.Drawing.Rectangle(${box.x}, ${box.y}, ${box.w}, ${box.h})
$crop = New-Object System.Drawing.Bitmap($box.Width, $box.Height)
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, $box.Width, $box.Height)), $box, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$img.Dispose()
$scale = [Math]::Min(1.0, ${maxW} / $crop.Width)
$final = New-Object System.Drawing.Bitmap([int]($crop.Width * $scale), [int]($crop.Height * $scale))
$g2 = [System.Drawing.Graphics]::FromImage($final)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($crop, 0, 0, $final.Width, $final.Height)
$g2.Dispose()
$crop.Dispose()
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$psParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$psParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 86)
$final.Save($dst, $enc, $psParams)
$final.Dispose()
Write-Output ("{0} {1}x{2} {3}KB" -f $dst, (Get-Item $dst).Length, 0, 0)
`;
  const { execFileSync } = await import('node:child_process');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    stdio: 'inherit',
  });
  return true;
}

await mkdir(outDir, { recursive: true });

// 1. 确认卡：从整屏截图里裁出卡片本体（周围是压暗的地图，留一点边当阴影底）
const cardSrc = join(root, 'shots', 'edit-confirm-card.png');
if (existsSync(cardSrc)) {
  await cropToJpeg(cardSrc, join(outDir, 'confirm-card.jpg'), { x: 496, y: 196, w: 556, h: 398 }, 900);
} else {
  console.warn('[site-assets] 没有 shots/edit-confirm-card.png，确认卡素材需先跑一次浏览器实测');
}

// 2. 出图（带图框）与自检报告：README 那两张已经是压好的 jpg，直接复制
for (const [src, dst] of [
  ['assets/canvas.jpg', 'canvas-frame.jpg'],
  ['assets/report.jpg', 'report.jpg'],
]) {
  const s = join(root, src);
  if (existsSync(s)) {
    await copyFile(s, join(outDir, dst));
    console.log(`[site-assets] 复制 ${src} -> web/public/site/${dst}`);
  } else {
    console.warn(`[site-assets] 跳过（源不存在）：${src}`);
  }
}

console.log('[site-assets] 完成');

/**
 * 3. 首屏主图：中国图面的网页版。
 *
 * china-sheet.png 是**图签自己出的图面原图**（引擎/画布的真实输出，4.7MB）。
 * 直接当首屏主图太重，压到 WebP 后是 509KB —— 比原来那张
 * export-pdf.png（871KB）还轻，文字锐度肉眼无差。
 *
 * sharp 是 Next.js 带进来的传递依赖，仓库没有把它列为直接依赖；
 * 这里动态引入，取不到就跳过（产物已经入库，没有 sharp 也不影响站点跑）。
 */
const chinaPng = join(outDir, 'china-sheet.png');
const chinaWebp = join(outDir, 'china-sheet.webp');
if (existsSync(chinaPng)) {
  try {
    const { default: sharp } = await import('sharp');
    await sharp(chinaPng).webp({ quality: 88, effort: 6, smartSubsample: true }).toFile(chinaWebp);
    const { size } = await import('node:fs/promises');
    const stat = await size(chinaWebp);
    console.log(`[site-assets] china-sheet.png -> china-sheet.webp（${Math.round(stat / 1024)}KB）`);
  } catch (err) {
    console.warn(`[site-assets] 跳过 WebP 转换（${err.message}）——站点会退回 PNG 源图`);
  }
} else {
  console.warn('[site-assets] 没有 china-sheet.png，跳过 WebP 转换');
}
