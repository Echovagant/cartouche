#!/usr/bin/env node
/**
 * 环境自检：一次性报告"本机现在具备什么、还缺什么、M0' 七项验证各自处于什么状态"。
 * 用法：npm run doctor
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveGdalBin, runTool, hasTool } from './lib/env.mjs';

const OK = '\x1b[32m●\x1b[0m';
const WARN = '\x1b[33m▲\x1b[0m';
const BAD = '\x1b[31m■\x1b[0m';
const DIM = '\x1b[90m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const line = (label, ok, detail = '') =>
  `  ${ok ? OK : WARN} ${label.padEnd(26, ' ')}${DIM}${detail}${RESET}`;

function section(title) {
  console.log(`\n${BOLD}${title}${RESET}`);
}

// ── 1. 运行时 ───────────────────────────────────────────────
section('运行时');
console.log(line('Node.js', true, `${process.version}  (要求 >= 22)`));
console.log(line('npm', hasTool('npm'), '包管理与脚本'));
console.log(line('git', hasTool('git'), '版本管理'));

// ── 2. GDAL ─────────────────────────────────────────────────
section('GDAL（数据读写地基）');
const gdalBin = resolveGdalBin();
let driverInfo = [];
if (!gdalBin) {
  console.log(line('GDAL 命令行', false, '未找到 — 运行 scripts/setup-conda-gdal.ps1 安装'));
  console.log(line('  ↳ 安装位置', true, join(homedir(), 'miniconda3', 'envs', 'gdal', 'Library', 'bin')));
} else {
  let version = '';
  try {
    version = runTool(gdalBin, 'gdalinfo', ['--version']).trim();
  } catch (e) {
    version = `调用失败: ${e.message}`;
  }
  console.log(line('GDAL 命令行', true, `${version}`));
  console.log(line('  ↳ 路径', true, gdalBin));

  try {
    // 栅格驱动用 gdalinfo --formats，矢量驱动用 ogrinfo --formats（两者列表不同）
    const rasterFormats = runTool(gdalBin, 'gdalinfo', ['--formats']);
    const vectorFormats = runTool(gdalBin, 'ogrinfo', ['--formats']);
    const wanted = [
      { name: 'GTiff', source: rasterFormats },
      { name: 'OpenFileGDB', source: vectorFormats },
      { name: 'ESRI Shapefile', source: vectorFormats },
      { name: 'GeoJSON', source: vectorFormats },
      { name: 'GPKG', source: vectorFormats },
      { name: 'PNG', source: rasterFormats },
    ];
    for (const { name, source } of wanted) {
      const hit = source.split(/\r?\n/).find((l) => l.includes(name));
      driverInfo.push({ name, ok: Boolean(hit), detail: hit ? hit.trim().slice(0, 46) : '未编译进此构建' });
    }
    for (const d of driverInfo) {
      console.log(line(`驱动 ${d.name}`, d.ok, d.detail));
    }
  } catch (e) {
    console.log(line('驱动枚举', false, `失败: ${e.message}`));
  }
}

// ── 3. C++ 工具链 ───────────────────────────────────────────
section('C++ 工具链（仅 Tauri 桌面版 / 原生依赖需要）');
const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
let msvcPath = null;
if (existsSync(vswhere)) {
  try {
    msvcPath = execFileSync(
      vswhere,
      ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
  } catch {
    msvcPath = null;
  }
}
console.log(line('MSVC 工具集 (cl.exe)', Boolean(msvcPath), msvcPath || '未安装 — Tauri 打包需要，运行 scripts/install-msvc.cmd'));
const msvcVer = msvcPath && existsSync(join(msvcPath, 'VC', 'Tools', 'MSVC'))
  ? readdirSync(join(msvcPath, 'VC', 'Tools', 'MSVC')).filter((d) => /^\d+/.test(d)).sort().pop()
  : null;
console.log(line('  ↳ 工具集版本', Boolean(msvcVer), msvcVer || 'n/a'));

// VS 自带的 CMake / Ninja：直接查安装目录，不依赖 PATH
const vsCMake = msvcPath ? join(msvcPath, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe') : null;
const vsNinja = msvcPath ? join(msvcPath, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'Ninja', 'ninja.exe') : null;
const cmakeFound = vsCMake && existsSync(vsCMake) ? vsCMake : null;
const ninjaFound = vsNinja && existsSync(vsNinja) ? vsNinja : null;
console.log(line('CMake', Boolean(cmakeFound) || hasTool('cmake'), cmakeFound ? 'VS 自带（默认不在 PATH）' : (hasTool('cmake') ? '已在 PATH' : '未安装 — Tauri 构建需要')));
console.log(line('Ninja', Boolean(ninjaFound) || hasTool('ninja'), ninjaFound ? 'VS 自带（默认不在 PATH）' : (hasTool('ninja') ? '已在 PATH' : '未安装')));
const sdkRoot = 'C:\\Program Files (x86)\\Windows Kits\\10\\Include';
const sdks = existsSync(sdkRoot)
  ? readdirSync(sdkRoot).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
  : [];
console.log(line('Windows SDK', sdks.length > 0, sdks.length ? sdks.join(', ') : '未安装'));
console.log(line('MinGW gcc', hasTool('gcc'), '备选工具链（Tauri 默认用 MSVC）'));
console.log(`  ${DIM}注：GDAL 用预编译二进制，以上均不参与 GDAL 的使用${RESET}`);

// ── 4. M0' 七项就绪度 ──────────────────────────────────────
section("M0' 七项验证 · 当前就绪度");
const gdalReady = Boolean(gdalBin);
const filegdbOk = driverInfo.find((d) => d.name === 'OpenFileGDB')?.ok ?? false;
const readiness = [
  ['V1 GDAL 读写 .tff/.shp/.gdb', gdalReady && filegdbOk, gdalReady ? (filegdbOk ? '就绪，可直接跑' : '缺 OpenFileGDB 驱动（写 .gdb 需先解决）') : '缺 GDAL'],
  ['V2 MapLibre 与 ArcGIS 叠合对位', false, '需前端工程 + ArcGIS Pro'],
  ['V3 面积/长度与 ArcGIS 对账', gdalReady, gdalReady ? 'GDAL 侧就绪，需 ArcGIS Pro 做基准' : '缺 GDAL'],
  ['V4 LLM 30 题基准', false, '需先写 30 条任务描述 + 接入模型'],
  ['V5 静态导出 + Tauri 最小壳', Boolean(msvcPath), msvcPath ? 'MSVC 就绪，可做 PoC' : '缺 MSVC'],
  ['V6 大栅格窗口化编辑', gdalReady, '需前端工程'],
  ['V7 ArcGIS 占用下的写回', false, '需 ArcGIS Pro'],
];
for (const [name, ok, detail] of readiness) {
  console.log(line(name, ok, detail));
}
const readyCount = readiness.filter((r) => r[1]).length;
console.log(`\n  ${BOLD}就绪 ${readyCount}/7${RESET}  ${DIM}（"▲" 表示还缺前置条件）${RESET}`);
console.log(`  ${DIM}下一步：npm run fixture 生成 .tff 样本并做一次写回往返校验${RESET}\n`);
