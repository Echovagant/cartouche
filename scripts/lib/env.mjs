import { existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * GDAL 定位与环境变量（scripts/ 侧的 JS 孪生实现，与 src/engine/gdal/env.ts 保持一致）。
 *
 * 跨平台要点（2026-10-22 CI 修复）：
 *   1. PATH 分隔符随平台变化（Windows ';'，POSIX ':'）——写死 ';' 在 Linux 上必然找不到 GDAL。
 *   2. 可执行文件后缀随平台变化（Windows .exe，POSIX 无后缀）。
 *   3. conda 目录布局随平台变化（Windows <prefix>\Library\bin，POSIX <prefix>/bin）。
 * 两处实现必须同步改，否则 scripts/ 与 engine/ 在同一个 CI 上会给出不同的结论。
 */

/** 已知 GDAL 安装位置（按优先级） */
const CANDIDATE_BIN_DIRS = [
  // Windows：miniconda 的 Windows 布局
  join(homedir(), 'miniconda3', 'envs', 'gdal', 'Library', 'bin'),
  join(homedir(), 'miniconda3', 'envs', 'gdal', 'bin'),
  join(homedir(), 'anaconda3', 'envs', 'gdal', 'Library', 'bin'),
  'C:\\Program Files\\GISInternals\\GDAL',
  'C:\\OSGeo4W\\bin',
  // Linux：conda 的 POSIX 布局（GitHub Actions runner 上是 /usr/share/miniconda）
  '/usr/share/miniconda/envs/gdal/bin',
  '/opt/conda/envs/gdal/bin',
  '/usr/local/bin',
];

/** 解析选项：默认用当前进程的环境，主要供测试注入"另一种平台"的形状。 */
export function resolveOptions(options = {}) {
  return {
    pathValue: options.pathValue ?? process.env.PATH ?? '',
    pathSeparator: options.pathSeparator ?? delimiter,
    platform: options.platform ?? process.platform,
    // 显式指定优先于 PATH 考古：CI 里 GDAL_BIN 就是给这一步用的
    gdalBin: options.gdalBin ?? process.env.GDAL_BIN ?? '',
  };
}

/** 目录里是否有 GDAL 命令行：Windows 是 gdalinfo.exe，POSIX 是 gdalinfo。 */
function isGdalBin(dir) {
  return existsSync(join(dir, 'gdalinfo.exe')) || existsSync(join(dir, 'gdalinfo'));
}

/** 第一个存在的目录，全不存在返回 null。 */
function firstExisting(dirs) {
  for (const dir of dirs) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * 定位 GDAL 命令行工具目录。
 * 查找顺序：PATH → 已知安装目录。返回 null 表示未安装。
 */
export function resolveGdalBin(options = {}) {
  const { pathValue, pathSeparator, platform, gdalBin } = resolveOptions(options);

  // 显式指定（GDAL_BIN）优先：CI 里已经把它指向 conda 环境的 bin
  if (gdalBin && isGdalBin(gdalBin)) return gdalBin;

  const pathDirs = pathValue.split(pathSeparator).filter(Boolean);
  for (const dir of pathDirs) {
    if (isGdalBin(dir)) return dir;
  }
  for (const dir of CANDIDATE_BIN_DIRS) {
    if (isGdalBin(dir)) return dir;
  }
  return null;
}

/** 当前平台下可执行文件的后缀（Windows .exe，POSIX 空）。 */
export function exeSuffix(platform = process.platform) {
  return platform === 'win32' ? '.exe' : '';
}

/**
 * 构造调用 GDAL 所需的环境变量。
 *
 * 不设置 GDAL_DATA / PROJ_LIB 时，GDAL 会打印
 * "Cannot find tms_NZTM2000.json (GDAL_DATA is not defined)" 之类的警告，
 * 某些驱动（坐标网格、瓦片服务等）会静默加载失败。
 * 因此凡是调用 GDAL/OGR，都必须带上这里构造的环境。
 */
export function gdalEnv(binDir) {
  const env = { ...process.env };
  // binDir 形如 <prefix>\Library\bin（Windows）或 <prefix>/bin（POSIX）
  const prefix = binDir.endsWith(join('Library', 'bin')) ? dirname(dirname(binDir)) : dirname(binDir);
  // 数据目录两套布局都试一遍：谁存在用谁
  const gdalData = firstExisting([join(prefix, 'Library', 'share', 'gdal'), join(prefix, 'share', 'gdal')]);
  const projData = firstExisting([join(prefix, 'Library', 'share', 'proj'), join(prefix, 'share', 'proj')]);
  if (gdalData) env.GDAL_DATA = gdalData;
  if (projData) {
    env.PROJ_LIB = projData;
    env.PROJ_DATA = projData;
  }
  // 分隔符必须跟着平台走：Windows 用 ';'，POSIX 用 ':'
  env.PATH = [binDir, join(prefix, 'Library', 'mingw-w64', 'bin'), env.PATH].filter(Boolean).join(delimiter);
  return env;
}

/**
 * 把工具名解析成实际可执行文件路径。
 * 调用方可以传基础名（gdalinfo）或带后缀名（gdalinfo.exe），这里兜底两种写法。
 */
export function resolveToolPath(binDir, exe) {
  const direct = join(binDir, exe);
  if (existsSync(direct)) return direct;
  const alt = exe.toLowerCase().endsWith('.exe') ? exe.slice(0, -4) : `${exe}.exe`;
  const altPath = join(binDir, alt);
  if (existsSync(altPath)) return altPath;
  return direct;
}

/** 调用一个 GDAL/OGR 命令行工具，返回 stdout 文本（自动带上 GDAL_DATA / PROJ_LIB） */
export function runTool(binDir, exe, args, options = {}) {
  return execFileSync(resolveToolPath(binDir, exe), args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: gdalEnv(binDir),
    ...options,
  });
}

/** 检查某个命令行工具是否存在 */
export function hasTool(name) {
  try {
    // Windows 用 where，POSIX 用 which
    const finder = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(finder, [name], { encoding: 'utf8', windowsHide: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
