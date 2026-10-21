import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

/** 已知 GDAL 安装位置（按优先级） */
const CANDIDATE_BIN_DIRS = [
  join(homedir(), 'miniconda3', 'envs', 'gdal', 'Library', 'bin'),
  join(homedir(), 'miniconda3', 'envs', 'gdal', 'bin'),
  'C:\\Program Files\\GISInternals\\GDAL',
  'C:\\OSGeo4W\\bin',
];

/**
 * 定位 GDAL 命令行工具目录。
 * 查找顺序：PATH → 已知安装目录。返回 null 表示未安装。
 */
export function resolveGdalBin() {
  const pathDirs = (process.env.PATH || '').split(';').filter(Boolean);
  for (const dir of pathDirs) {
    if (existsSync(join(dir, 'gdalinfo.exe'))) return dir;
  }
  for (const dir of CANDIDATE_BIN_DIRS) {
    if (existsSync(join(dir, 'gdalinfo.exe'))) return dir;
  }
  return null;
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
  // binDir 形如 <prefix>\Library\bin 或 <prefix>\bin
  const prefix = binDir.endsWith(join('Library', 'bin'))
    ? dirname(dirname(binDir))
    : dirname(binDir);
  const gdalData = join(prefix, 'Library', 'share', 'gdal');
  const projData = join(prefix, 'Library', 'share', 'proj');
  if (existsSync(gdalData)) env.GDAL_DATA = gdalData;
  if (existsSync(projData)) {
    env.PROJ_LIB = projData;
    env.PROJ_DATA = projData;
  }
  env.PATH = [binDir, join(prefix, 'Library', 'mingw-w64', 'bin'), env.PATH].join(';');
  return env;
}

/** 调用一个 GDAL/OGR 命令行工具，返回 stdout 文本（自动带上 GDAL_DATA / PROJ_LIB） */
export function runTool(binDir, exe, args, options = {}) {
  return execFileSync(join(binDir, exe), args, {
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
    execFileSync('where', [name], { encoding: 'utf8', windowsHide: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
