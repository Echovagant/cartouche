#!/usr/bin/env node
/**
 * 打「绿色便携包」：解压 → 双击 → 就能用的 Windows x64 包。
 *
 * 给谁用：不写代码的制图/测绘从业者。上一版发布包要他们装 Node、装 GDAL、
 * 跑 npm install —— 三道坎，每一道都足以让人在第一步就放弃。所以这里把
 * **运行时整个塞进包里**：Node 引擎、裁过的 GDAL、生产依赖、预构建产物，
 * 一次下载，解压即用。
 *
 * 为什么不做成 .exe：没签名的 .exe 会被 Windows SmartScreen 拦成
 * 「Windows 已保护你的电脑」，对不懂技术的人比「装 Node」更劝退；
 * 签名证书还要花钱。zip + .cmd 不触发这个拦截。
 *
 * 打包方式：自己写 zip（scripts/lib/zip.mjs）—— 依赖许可门禁只放行宽松许可的包，
 * 为打一个包引一个压缩库不划算，而 zlib 是 Node 自带的。
 *
 * 产物：release/portable/cartouche-portable-<版本>.zip（+ 同名 .sha256）
 *
 * 用法：
 *   node scripts/pack-portable.mjs
 *   node scripts\pack-portable.mjs --node "<node.exe 的路径>" --gdal "<conda 环境目录>"
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './lib/zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'release', 'portable');

/** 包内顶层目录名：解压后直接就是内容，不用先进一个文件夹 */
const TOP = 'cartouche-portable';

/**
 * 引擎**实际**会调用的 GDAL 命令行工具。
 *
 * 为什么只有这 8 个：整个 conda 的 GDAL 环境是 738 MB，其中 144 个 exe 里
 * 引擎一个都用不上。按 PE 导入表算出这 8 个的 DLL 依赖闭包后只剩 106 MB。
 *
 * ⚠️ 少了一个：`gdal_edit.py`。conda 环境下它根本不是可执行文件
 * （只在 site-packages 里，是 Python 脚本），引擎的 runner 声明了它但
 * **全仓库没有任何调用点**（已逐处核实），所以不收 —— 收了还得带上整套
 * Python 运行时，那才是几百 MB。
 */
const GDAL_TOOLS = [
  'gdalinfo.exe',
  'gdal_translate.exe',
  'gdalwarp.exe',
  'ogrinfo.exe',
  'ogr2ogr.exe',
  'gdaladdo.exe',
  'gdalbuildvrt.exe',
  'projinfo.exe',
];

/** 引擎的服务端会读这个文件（server/src/app.ts 里的 readSchema） */
const ENGINE_SCHEMA = 'src/engine/ops.schema.json';

/**
 * 预构建产物。
 *
 * 只收 .js：tsc 一起吐出来的 .d.ts（类型声明）与 .js.map（源码映射）
 * 是给开发与 IDE 用的，运行时一行都不读 —— 占掉预构建产物近一半的体积。
 */
const PREBUILT = [
  { rel: 'src/engine/dist', jsOnly: true },
  { rel: 'server/dist', jsOnly: true },
  { rel: 'web/out', jsOnly: false },
];

/**
 * 进包的脚本：只收运行期真正用得到的。
 *
 * `scripts/run-engine.ps1` 单独处理（见 {@link PORTABLE_RUN_ENGINE_PS1}）。
 */
const SCRIPTS = [
  'scripts/serve-static.mjs',
  'scripts/set-key.ps1',
  'scripts/doctor.mjs',
  'scripts/start-portable.cmd',
  'scripts/lib/env.mjs',
];

/**
 * 包里的 scripts/run-engine.ps1（替换仓库里那份）。
 *
 * 为什么替换：仓库那一份最后一行是 `npm -w server run dev` ——
 * 便携包里既没有 npm，也没有 TS 源码，那一行必然失败。
 * 留着它只会让用户点一下就看到一条红字，所以换成"用包里的 node 起
 * 已经构建好的 server/dist"，密钥的读法（DPAPI）保持一致。
 *
 * 纯 ASCII：Windows PowerShell 5.1 读无 BOM 的 .ps1 时按系统代码页解，
 * 文件里有中文就会变乱码（仓库那份同样遵守这条）。
 */
const PORTABLE_RUN_ENGINE_PS1 = `# Start the portable engine: bundled Node + prebuilt server/dist.
#
# The key is decrypted into this process environment and handed to the child
# process. It is never written to disk in plaintext and never echoed.
#
# Pure ASCII on purpose (Windows PowerShell 5.1 .ps1 encoding rule).

param(
  [int]$Port = 0,
  [switch]$NoKey
)

$ErrorActionPreference = 'Stop'
$pkgRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = Join-Path $pkgRoot 'runtime\\node\\node.exe'
$serverEntry = Join-Path $pkgRoot 'server\\dist\\index.js'
$keyFile = Join-Path $env:LOCALAPPDATA 'cartouche\\llm-key.txt'

# 端口优先取环境变量：启动器（start-portable.cmd）已经把 ENGINE_PORT 设好了，
# 这里再写死一个默认值会把启动器的设置覆盖掉 —— 实测踩到过：
# 启动器让引擎跑在 18787，引擎却去抢 8787，直接 EADDRINUSE 起不来。
if ($Port -le 0) {
  if ($env:ENGINE_PORT) { $Port = [int]$env:ENGINE_PORT } else { $Port = 8787 }
}

if (-not (Test-Path $nodeExe)) {
  Write-Output "[engine] bundled node.exe is missing: $nodeExe"
  exit 1
}
if (-not (Test-Path $serverEntry)) {
  Write-Output "[engine] server build is missing: $serverEntry"
  exit 1
}

if (-not $NoKey -and (Test-Path $keyFile)) {
  $enc = [IO.File]::ReadAllText($keyFile).Trim()
  try {
    $sec = ConvertTo-SecureString $enc
  } catch {
    Write-Output "[key] cannot decrypt (was it saved by a different Windows user?) -> $keyFile"
    $sec = $null
  }
  if ($sec) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try {
      $env:MINIMAX_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
      # report only presence, never the value
      Write-Output ("[key] loaded from DPAPI store, length={0}" -f $env:MINIMAX_API_KEY.Length)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
} elseif (-not $NoKey) {
  Write-Output "[key] not configured. Run: scripts\\set-key.ps1"
}

$env:ENGINE_PORT = "$Port"
$env:ENGINE_HOST = '127.0.0.1'

Write-Output "[engine] starting on http://127.0.0.1:$Port (workspace root: $pkgRoot\\workspace)"
Set-Location $pkgRoot
& $nodeExe $serverEntry
`;

/**
 * 说明文件。
 *
 * `assets` 也带上：README 里引了 4 张图（landing / canvas / report / projects），
 * 不带的话包里的 README 就是四张裂图 —— 0.34 MB 换一份能看的说明，划算。
 */
const DOCS = ['README.md', 'QUICKSTART.md', 'LICENSE', 'NOTICE', 'assets'];

/* ── PE 导入表解析（用来算 DLL 依赖闭包） ───────────────────────────── */

/**
 * 读出一个 PE 文件的导入表（普通导入 + 延迟导入）。
 *
 * 为什么自己解析：conda 的 GDAL 的 DLL 依赖是一团，谁也说不清"缺哪个就报
 * 「找不到 DLL」"。而 DLL 的依赖**写在 PE 头里**（导入表），是确定的 ——
 * 比"删一个试试"可靠得多，也不用装 dumpbin。
 *
 * @param {Buffer} buf
 * @returns {string[] | null} 依赖的 DLL 名；null 表示这不是 PE 文件
 */
function parsePeImports(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > buf.length) return null;
  if (buf.readUInt32LE(peOff) !== 0x00004550) return null; // 'PE\0\0'

  const coff = peOff + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const pe32plus = buf.readUInt16LE(opt) === 0x20b;
  // 数据目录的起点：PE32 是 optional header + 96，PE32+ 是 + 112
  const ddOff = opt + (pe32plus ? 112 : 96);
  const sectOff = opt + optSize;

  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const s = sectOff + i * 40;
    sections.push({
      va: buf.readUInt32LE(s + 12),
      vsize: buf.readUInt32LE(s + 8),
      rawSize: buf.readUInt32LE(s + 16),
      rawPtr: buf.readUInt32LE(s + 20),
    });
  }
  const rvaToOff = (rva) => {
    for (const s of sections) {
      const span = Math.max(s.vsize, s.rawSize);
      if (rva >= s.va && rva < s.va + span) return s.rawPtr + (rva - s.va);
    }
    return -1;
  };
  const cstr = (off) => {
    if (off < 0 || off >= buf.length) return null;
    let end = off;
    while (end < buf.length && buf[end] !== 0) end++;
    return buf.toString('latin1', off, end);
  };

  const imports = [];
  const readDir = (dirIdx, isDelay) => {
    if (ddOff + dirIdx * 8 + 8 > buf.length) return;
    const rva = buf.readUInt32LE(ddOff + dirIdx * 8);
    const size = buf.readUInt32LE(ddOff + dirIdx * 8 + 4);
    if (!rva || !size) return;
    const base = rvaToOff(rva);
    if (base < 0) return;
    const entrySize = isDelay ? 32 : 20;
    const nameField = isDelay ? 4 : 12;
    for (let i = 0; ; i++) {
      const e = base + i * entrySize;
      if (e + entrySize > buf.length) break;
      // 全 0 的条目 = 目录结束
      let allZero = true;
      for (let k = 0; k < entrySize; k++) {
        if (buf[e + k] !== 0) { allZero = false; break; }
      }
      if (allZero) break;
      const name = cstr(rvaToOff(buf.readUInt32LE(e + nameField)));
      if (name) imports.push(name);
    }
  };
  readDir(1, false);  // 导入表
  readDir(13, true);  // 延迟导入表（少了它会漏掉一部分依赖）
  return imports;
}

/** Windows 的 API Set：系统自带，按名字解析，不该去 conda 环境里找 */
const API_SET = /^(api-ms-|ext-ms-)/i;

/**
 * 算出依赖闭包：从若干入口文件出发，把它们依赖的 DLL 一层层拉进来。
 *
 * 解析顺序按 Windows 加载器的实际行为来：先看**调用方自己所在目录**
 * （exe 同目录的 DLL 优先），再按给定目录找。
 *
 * @param {string[]} entryFiles
 * @param {string[]} searchDirs
 * @returns {{files: Set<string>, missing: Set<string>}}
 */
async function dllClosure(entryFiles, searchDirs) {
  const files = new Set();
  const missing = new Set();
  const queue = entryFiles.map((p) => ({ path: p, dir: dirname(p) }));
  while (queue.length) {
    const { path, dir } = queue.shift();
    if (files.has(path)) continue;
    let buf;
    try {
      buf = await readFile(path);
    } catch {
      continue;
    }
    const imports = parsePeImports(buf);
    if (!imports) continue;
    files.add(path);
    for (const imp of imports) {
      if (API_SET.test(imp)) continue;
      const candidates = [join(dir, imp), ...searchDirs.map((d) => join(d, imp))];
      let hit = null;
      for (const c of candidates) {
        if (existsSync(c)) { hit = c; break; }
      }
      if (!hit) {
        missing.add(imp);
        continue;
      }
      queue.push({ path: hit, dir: dirname(hit) });
    }
  }
  return { files, missing };
}

/* ── 找运行时来源 ─────────────────────────────────────────────────── */

function argOf(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/**
 * 找 node.exe。
 *
 * 默认用**跑这个脚本的那个 node**（process.execPath）—— 它必然能跑，
 * 且实测是独立 exe（只依赖 Windows 自带的 DLL），不需要带同目录的其它文件。
 */
function resolveNodeExe() {
  const explicit = argOf('node') ?? process.env.CARTOUCHE_NODE_EXE ?? process.execPath;
  if (!existsSync(explicit)) throw new Error(`找不到 node.exe：${explicit}`);
  return explicit;
}

/**
 * 找 conda 的 GDAL 环境。
 *
 * 候选位置用环境变量拼（不写死任何人的用户目录）——写死的话，
 * 这个文件本身就会把打包者的本机路径带进仓库，也会让别人的包带上别人的路径。
 */
function resolveGdalEnv() {
  const candidates = [];
  const explicit = argOf('gdal') ?? process.env.CARTOUCHE_GDAL_PREFIX;
  if (explicit) candidates.push(explicit);
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (home) {
    candidates.push(join(home, 'miniconda3', 'envs', 'gdal'));
    candidates.push(join(home, 'anaconda3', 'envs', 'gdal'));
    candidates.push(join(home, 'miniconda3', 'envs', 'gdal-base'));
  }
  if (process.env.CONDA_PREFIX) candidates.push(process.env.CONDA_PREFIX);
  candidates.push('C:\\OSGeo4W');

  for (const prefix of candidates) {
    // conda 在 Windows 上把可执行文件放在 Library\bin，数据放在 Library\share
    for (const binRel of [join('Library', 'bin'), 'bin']) {
      const binDir = join(prefix, binRel);
      if (!existsSync(join(binDir, 'gdalinfo.exe'))) continue;
      const shareRoot = existsSync(join(prefix, 'Library', 'share', 'gdal'))
        ? join(prefix, 'Library', 'share')
        : join(prefix, 'share');
      return { prefix, binDir, shareRoot };
    }
  }
  throw new Error(
    '找不到可用的 GDAL 环境。请用 --gdal <conda 环境目录> 或 CARTOUCHE_GDAL_PREFIX 指定。',
  );
}

/* ── 收集文件 ─────────────────────────────────────────────────────── */

/** 递归收集一个目录下的所有文件（相对路径用 / 分隔） */
async function collectDir(absDir, relPrefix, out) {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(absDir, e.name);
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await collectDir(abs, rel, out);
    } else if (e.isFile()) {
      out.push({ rel, abs });
    }
  }
}

/** 加一个文件到清单（读进内存，等下统一压 zip） */
async function addFile(list, rel, abs) {
  const data = await readFile(abs);
  list.push({ rel, data });
}

/* ── 本机路径闸门 ─────────────────────────────────────────────────── */

/**
 * 找出打进包里的本机路径。
 *
 * 为什么要这道闸：包是给别人的。带着打包者本机的用户目录路径出去，
 * 等于把打包者的本机路径公开。搬一份 `scripts/pack-release.mjs` 的口径过来。
 */
const LOCAL_PATH_PATTERNS = [
  /[A-Za-z]:\\Users\\[^\\\s"'<>|]+/g,
  /\/Users\/[^/\s"'<>|]+/g,
  /\/home\/[^/\s"'<>|]+/g,
];

function findLocalPathLeaks(entries) {
  const leaks = [];
  for (const e of entries) {
    const head = e.data.subarray(0, 4096);
    if (head.includes(0)) continue; // 二进制，扫它没有意义
    const text = e.data.toString('utf8');
    for (const re of LOCAL_PATH_PATTERNS) {
      re.lastIndex = 0;
      const m = re.exec(text);
      if (m) {
        leaks.push({ name: e.name, sample: m[0].slice(0, 120) });
        break;
      }
    }
  }
  return leaks;
}

/* ── 包内说明文字 ─────────────────────────────────────────────────── */

/**
 * 统一成 CRLF。
 *
 * 为什么必须统一：**cmd.exe 的批处理解析器要求 CRLF**。
 * 只用 LF 写 .cmd 时，cmd 读文件的字节位置会漂 —— 表现是
 * 「goto 到某个标签后，cmd 把标签名当成命令去执行」，
 * 报一串 `xxx is not recognized as an internal or external command`，
 * 而用户看到的是"双击没反应 + 一屏英文报错"。
 *
 * 这是实测踩到的（2026-10-24）：同一份内容，LF 写就散架，CRLF 写就正常。
 */
function toCrlf(text) {
  return text.replace(/\r?\n/g, '\r\n');
}

/**
 * 塞到 README / QUICKSTART 开头的「便携包用法」。
 *
 * 为什么要在包里的文档上加这一段：仓库里的 README 讲的是开发流程
 * （装 Node、npm install），照着做在便携包里全都不成立 ——
 * 对不懂技术的人来说，照着做失败比不给说明更糟。
 */
const PORTABLE_DOC_HEADER = `> **这是便携包**：不用装 Node、不用装 GDAL、不用跑 \`npm install\`。
> 解压后**双击 \`START.cmd\`** 就能用（Windows x64）。
> 下面保留的是项目本身的完整说明；便携包怎么用，看上面这一段就够。
>
> - 画布：<http://127.0.0.1:8080/canvas.html>
> - 引擎：<http://127.0.0.1:8787>
> - 关掉：在弹出的两个命令行窗口里按 Ctrl+C（或直接关掉窗口）
> - 数据放哪：引擎只在自己登记过的目录里读写，源数据不用搬家
> - 想用 AI 功能：在包内跑 \`scripts\\set-key.ps1\` 填一次密钥（DPAPI 加密，只存在你自己的电脑上）
`;

/** 包根目录那个双击入口：只做转发，逻辑都在 scripts\\start-portable.cmd 里 */
const ROOT_LAUNCHER = `@echo off
chcp 65001 >nul
call "%~dp0scripts\\start-portable.cmd" %*
`;

/* ── 主流程 ───────────────────────────────────────────────────────── */

async function main() {
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version ?? '0.0.0';
  const nodeExe = resolveNodeExe();
  const gdal = resolveGdalEnv();

  console.log(`[pack] Node 运行时来源：${nodeExe}`);
  console.log(`[pack] GDAL 来源：${gdal.prefix}`);

  /* ── 1. GDAL：算 DLL 依赖闭包 ─────────────────────────────────── */
  const searchDirs = [
    gdal.binDir,
    gdal.prefix,
    join(gdal.prefix, 'Library', 'mingw-w64', 'bin'),
    join(gdal.prefix, 'Library', 'lib'),
  ];
  const toolPaths = GDAL_TOOLS.map((t) => join(gdal.binDir, t));
  const missingTools = toolPaths.filter((p) => !existsSync(p));
  if (missingTools.length) {
    console.error(`[pack] GDAL 环境里缺这些工具：${missingTools.map((p) => basename(p)).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const closure = await dllClosure(toolPaths, searchDirs);
  console.log(
    `[pack] GDAL 依赖闭包：${closure.files.size} 个文件（含 ${GDAL_TOOLS.length} 个工具）`,
  );
  if (closure.missing.size) {
    console.log(`[pack]   依赖里有 ${closure.missing.size} 个 Windows 自带的 DLL（不打包）：${[...closure.missing].join(', ')}`);
  }

  /* ── 2. 组装包内容 ────────────────────────────────────────────── */
  /** @type {{name: string, data: Buffer}[]} */
  const entries = [];
  const sizes = new Map();
  const bump = (bucket, bytes) => sizes.set(bucket, (sizes.get(bucket) ?? 0) + bytes);

  // 2.1 Node 运行时
  const nodeExeBuf = await readFile(nodeExe);
  entries.push({ name: `${TOP}/runtime/node/node.exe`, data: nodeExeBuf });
  bump('node 运行时', nodeExeBuf.length);

  // 2.2 GDAL：可执行文件 + 它们的 DLL 依赖
  for (const abs of closure.files) {
    const data = await readFile(abs);
    entries.push({ name: `${TOP}/runtime/gdal/bin/${basename(abs)}`, data });
    bump('GDAL 可执行文件与 DLL', data.length);
  }
  // GDAL 的数据与投影库：驱动定义、EPSG 表、proj.db —— 缺了就是"静默加载失败"
  for (const sub of ['gdal', 'proj']) {
    const abs = join(gdal.shareRoot, sub);
    if (!existsSync(abs)) {
      console.warn(`[pack] 警告：GDAL 的 share/${sub} 不存在，投影/驱动可能加载失败`);
      continue;
    }
    const files = [];
    await collectDir(abs, '', files);
    for (const f of files) {
      const data = await readFile(f.abs);
      entries.push({ name: `${TOP}/runtime/gdal/share/${sub}/${f.rel}`, data });
      bump('GDAL 数据与投影库', data.length);
    }
  }

  // 2.3 生产依赖：引擎与服务端**只依赖 Node 自带模块**，
  //     整份 node_modules 里唯一需要进包的是工作区里的 @cartouche/engine ——
  //     它不是第三方包，dev 依赖（next / react / typescript …）一个都不用。
  //     所以「装依赖」这一步在便携包里根本不存在。
  //
  //     @cartouche/engine 只放一个 package.json：它把 main 指到
  //     src/engine/dist（引擎代码真正的位置，也是服务端读 ops.schema.json
  //     的同级目录）。用 main 而不是 exports，是因为 exports 的目标必须
  //     留在包目录内，不能往外指。
  const enginePkg = JSON.parse(await readFile(join(root, 'src', 'engine', 'package.json'), 'utf8'));
  const shimPkg = {
    name: enginePkg.name,
    version: enginePkg.version,
    type: 'module',
    main: '../../../src/engine/dist/index.js',
  };
  const shimBuf = Buffer.from(`${JSON.stringify(shimPkg, null, 2)}\n`, 'utf8');
  entries.push({ name: `${TOP}/node_modules/@cartouche/engine/package.json`, data: shimBuf });
  bump('生产依赖（node_modules）', shimBuf.length);

  // 2.4 预构建产物
  for (const { rel, jsOnly } of PREBUILT) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      console.error(`[pack] 缺预构建产物：${rel}（先跑 npm run build:server / build:web）`);
      process.exitCode = 1;
      return;
    }
    const files = [];
    await collectDir(abs, '', files);
    for (const f of files) {
      if (jsOnly && !f.rel.endsWith('.js')) continue;
      const data = await readFile(f.abs);
      entries.push({ name: `${TOP}/${rel}/${f.rel}`, data });
      bump('预构建产物', data.length);
    }
  }
  // 引擎的 ops 契约：服务端 readSchema() 按固定路径读它
  {
    const abs = join(root, ENGINE_SCHEMA);
    if (!existsSync(abs)) {
      console.error(`[pack] 缺 ${ENGINE_SCHEMA}`);
      process.exitCode = 1;
      return;
    }
    const data = await readFile(abs);
    entries.push({ name: `${TOP}/${ENGINE_SCHEMA}`, data });
    bump('预构建产物', data.length);
  }

  // 2.5 脚本
  for (const rel of SCRIPTS) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      console.error(`[pack] 缺脚本：${rel}`);
      process.exitCode = 1;
      return;
    }
    let data = await readFile(abs);
    // .cmd / .ps1 必须是 CRLF（见 toCrlf 的说明）
    if (rel.endsWith('.cmd') || rel.endsWith('.ps1')) {
      data = Buffer.from(toCrlf(data.toString('utf8')), 'utf8');
    }
    entries.push({ name: `${TOP}/${rel}`, data });
    bump('脚本', data.length);
  }
  // run-engine.ps1 在包里换成便携版（仓库那版最后一行要 npm）
  {
    const data = Buffer.from(toCrlf(PORTABLE_RUN_ENGINE_PS1), 'utf8');
    entries.push({ name: `${TOP}/scripts/run-engine.ps1`, data });
    bump('脚本', data.length);
  }
  // 引擎的 package.json 也要在包里：dist/*.js 是 .js，
  // Node 靠最近的 package.json 里的 "type" 判定它是 ESM 还是 CJS
  {
    const data = await readFile(join(root, 'src', 'engine', 'package.json'));
    entries.push({ name: `${TOP}/src/engine/package.json`, data });
    bump('脚本', data.length);
  }

  // 2.6 说明
  for (const rel of DOCS) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      console.warn(`[pack] 跳过（不存在）：${rel}`);
      continue;
    }
    if (statSync(abs).isDirectory()) {
      const files = [];
      await collectDir(abs, '', files);
      for (const f of files) {
        const data = await readFile(f.abs);
        entries.push({ name: `${TOP}/${rel}/${f.rel}`, data });
        bump('说明文件', data.length);
      }
      continue;
    }
    let data = await readFile(abs);
    // README / QUICKSTART 前面加一段便携包用法
    if (rel === 'README.md' || rel === 'QUICKSTART.md') {
      const text = data.toString('utf8');
      data = Buffer.from(`${PORTABLE_DOC_HEADER}\n${text}`, 'utf8');
    }
    entries.push({ name: `${TOP}/${rel}`, data });
    bump('说明文件', data.length);
  }
  // 包根目录的双击入口
  {
    const data = Buffer.from(toCrlf(ROOT_LAUNCHER), 'utf8');
    entries.push({ name: `${TOP}/START.cmd`, data });
    bump('脚本', data.length);
  }

  /* ── 3. 出包前的最后一道闸 ─────────────────────────────────────── */
  const leaks = findLocalPathLeaks(entries);
  if (leaks.length > 0) {
    console.error(`[pack] 拒绝出包：发现 ${leaks.length} 处本机路径痕迹`);
    for (const l of leaks) console.error(`        ${l.name}  →  ${l.sample}`);
    process.exitCode = 1;
    return;
  }

  /* ── 4. 写 zip ─────────────────────────────────────────────────── */
  const buf = zip(entries);
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `cartouche-portable-${version}.zip`);
  await writeFile(outFile, buf);
  const sha = createHash('sha256').update(buf).digest('hex');
  await writeFile(`${outFile}.sha256`, `${sha}  ${basename(outFile)}\n`, 'utf8');

  /* ── 5. 体积报告 ───────────────────────────────────────────────── */
  const rawTotal = [...sizes.values()].reduce((a, b) => a + b, 0);
  console.log('');
  console.log('[pack] 体积构成（解压后 / 压缩后）');
  for (const [bucket, bytes] of sizes) {
    console.log(`        ${bucket.padEnd(22, ' ')} ${(bytes / 1048576).toFixed(1).padStart(7)} MB`);
  }
  console.log(`        ${'合计'.padEnd(22, ' ')} ${(rawTotal / 1048576).toFixed(1).padStart(7)} MB  →  ${(buf.length / 1048576).toFixed(1)} MB`);
  console.log(`        ${'压缩率'.padEnd(22, ' ')} ${((buf.length / rawTotal) * 100).toFixed(1)}%`);
  console.log('');
  console.log(`[pack] ${entries.length} 个条目，输出：${outFile}`);
  console.log(`[pack] sha256：${sha}`);
}

await main();
