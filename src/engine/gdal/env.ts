/**
 * GDAL 运行时定位与环境变量。
 *
 * 关键教训（M0' 实测）：不设置 GDAL_DATA / PROJ_LIB 时，GDAL 会输出
 * "Cannot find tms_NZTM2000.json (GDAL_DATA is not defined)" 之类的警告，
 * 部分驱动会**静默加载失败**。因此所有 GDAL 调用都必须带上这里构造的环境。
 *
 * 跨平台要点（2026-10-22 CI 修复）：
 *   1. PATH 分隔符随平台变化（Windows 是 ';'，POSIX 是 ':'），
 *      写死 ';' 会让 Linux 上一个 GDAL 目录都找不到。
 *   2. 可执行文件后缀随平台变化（Windows 是 .exe，POSIX 无后缀）。
 *   3. conda 的目录布局随平台变化：Windows 是 <prefix>\Library\bin，
 *      Linux 是 <prefix>\bin；数据目录同理（Library\share vs share）。
 *   以上三点任一写死，CI 在 ubuntu-latest 上都会以"找不到 GDAL"收场。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';

export interface GdalLocation {
  /** 存放可执行文件的目录，如 <prefix>\Library\bin 或 <prefix>/bin */
  readonly binDir: string;
  /** 安装前缀，如 <prefix> */
  readonly prefix: string;
  readonly gdalData: string | null;
  readonly projData: string | null;
  readonly exeSuffix: string;
}

/** 解析选项：默认用当前进程的环境，主要供测试注入"另一种平台"的形状。 */
export interface ResolveGdalOptions {
  /** 覆盖 PATH 取值 */
  readonly pathValue?: string;
  /** PATH 分隔符，默认取当前平台的分隔符 */
  readonly pathSeparator?: string;
  /** 目标平台，默认当前平台 */
  readonly platform?: NodeJS.Platform;
  /** 显式指定 GDAL 的 bin 目录；默认取环境变量 GDAL_BIN */
  readonly gdalBin?: string;
}

/** 已知安装位置（按优先级） */
export function candidateBinDirs(): string[] {
  return [
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
}

/** 目录里是否有 GDAL 命令行：Windows 是 gdalinfo.exe，POSIX 是 gdalinfo。 */
function isGdalBin(dir: string): boolean {
  return existsSync(join(dir, 'gdalinfo.exe')) || existsSync(join(dir, 'gdalinfo'));
}

/** 第一个存在的目录，全不存在返回 null。 */
function firstExisting(dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** 定位 GDAL：先找 PATH，再找已知安装位置。找不到返回 null。 */
export function resolveGdal(options: ResolveGdalOptions = {}): GdalLocation | null {
  const separator = options.pathSeparator ?? delimiter;
  const pathValue = options.pathValue ?? process.env.PATH ?? '';
  const platform = options.platform ?? process.platform;
  // gdalBin 显式传 '' 表示"不要用环境变量里的 GDAL_BIN"（测试要隔离时用）；
  // 不传这个键才回落到 process.env.GDAL_BIN。
  const explicit =
    options.gdalBin !== undefined ? options.gdalBin : (process.env.GDAL_BIN ?? '');

  // 显式指定（GDAL_BIN）优先：CI 里已经把它指向 conda 环境的 bin
  if (explicit && isGdalBin(explicit)) return buildLocation(explicit, platform);

  const pathDirs = pathValue.split(separator).filter(Boolean);
  for (const dir of pathDirs) {
    if (isGdalBin(dir)) return buildLocation(dir, platform);
  }
  for (const dir of candidateBinDirs()) {
    if (isGdalBin(dir)) return buildLocation(dir, platform);
  }
  return null;
}

function buildLocation(binDir: string, platform: NodeJS.Platform): GdalLocation {
  // bin 形如 <prefix>\Library\bin（Windows）或 <prefix>/bin（POSIX）
  const prefix = binDir.endsWith(join('Library', 'bin')) ? dirname(dirname(binDir)) : dirname(binDir);
  // 数据目录两套布局都试一遍：谁存在用谁
  const gdalData = firstExisting([join(prefix, 'Library', 'share', 'gdal'), join(prefix, 'share', 'gdal')]);
  const projData = firstExisting([join(prefix, 'Library', 'share', 'proj'), join(prefix, 'share', 'proj')]);
  return {
    binDir,
    prefix,
    gdalData,
    projData,
    exeSuffix: platform === 'win32' ? '.exe' : '',
  };
}

/** 构造调用 GDAL 所需的环境变量。 */
export function gdalEnv(loc: GdalLocation): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (loc.gdalData) env.GDAL_DATA = loc.gdalData;
  if (loc.projData) {
    env.PROJ_LIB = loc.projData;
    env.PROJ_DATA = loc.projData;
  }
  const extra = [loc.binDir, join(loc.prefix, 'Library', 'mingw-w64', 'bin')].filter((p) => existsSync(p));
  // 分隔符必须跟着平台走：Windows 用 ';'，POSIX 用 ':'
  env.PATH = [...extra, env.PATH ?? ''].join(delimiter);
  return env;
}
