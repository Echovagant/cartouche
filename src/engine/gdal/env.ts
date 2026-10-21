/**
 * GDAL 运行时定位与环境变量。
 *
 * 关键教训（M0' 实测）：不设置 GDAL_DATA / PROJ_LIB 时，GDAL 会输出
 * "Cannot find tms_NZTM2000.json (GDAL_DATA is not defined)" 之类的警告，
 * 部分驱动会**静默加载失败**。因此所有 GDAL 调用都必须带上这里构造的环境。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export interface GdalLocation {
  /** 存放可执行文件的目录，如 <prefix>\Library\bin */
  readonly binDir: string;
  /** 安装前缀，如 <prefix> */
  readonly prefix: string;
  readonly gdalData: string | null;
  readonly projData: string | null;
  readonly exeSuffix: string;
}

/** 已知安装位置（按优先级） */
export function candidateBinDirs(): string[] {
  return [
    join(homedir(), 'miniconda3', 'envs', 'gdal', 'Library', 'bin'),
    join(homedir(), 'miniconda3', 'envs', 'gdal', 'bin'),
    'C:\\Program Files\\GISInternals\\GDAL',
    'C:\\OSGeo4W\\bin',
  ];
}

function isGdalBin(dir: string): boolean {
  return existsSync(join(dir, 'gdalinfo.exe')) || existsSync(join(dir, 'gdalinfo'));
}

/** 定位 GDAL：先找 PATH，再找已知安装位置。找不到返回 null。 */
export function resolveGdal(): GdalLocation | null {
  const pathDirs = (process.env.PATH ?? '').split(';').filter(Boolean);
  for (const dir of pathDirs) {
    if (isGdalBin(dir)) return buildLocation(dir);
  }
  for (const dir of candidateBinDirs()) {
    if (isGdalBin(dir)) return buildLocation(dir);
  }
  return null;
}

function buildLocation(binDir: string): GdalLocation {
  // bin 形如 <prefix>\Library\bin 或 <prefix>\bin
  const prefix = binDir.endsWith(join('Library', 'bin')) ? dirname(dirname(binDir)) : dirname(binDir);
  const gdalData = join(prefix, 'Library', 'share', 'gdal');
  const projData = join(prefix, 'Library', 'share', 'proj');
  return {
    binDir,
    prefix,
    gdalData: existsSync(gdalData) ? gdalData : null,
    projData: existsSync(projData) ? projData : null,
    exeSuffix: process.platform === 'win32' ? '.exe' : '',
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
  env.PATH = [...extra, env.PATH ?? ''].join(';');
  return env;
}
