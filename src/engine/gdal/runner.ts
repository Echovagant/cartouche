/**
 * GDAL/OGR 命令行封装。
 *
 * 原则：
 *  1. 永远用 execFile 传参数数组，不拼 shell 字符串（避免路径里的空格与注入）
 *  2. 永远带上 gdalEnv()（GDAL_DATA / PROJ_LIB），否则部分驱动静默失败
 *  3. 超时可控，超时/非零退出码都转成结构化结果，由上层翻译成人话
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { gdalEnv, type GdalLocation } from './env.ts';

export interface ToolResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly command: string;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function runTool(
  loc: GdalLocation,
  exe: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ToolResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = `${join(loc.binDir, exe)} ${args.join(' ')}`;

  return new Promise<ToolResult>((resolve) => {
    execFile(
      join(loc.binDir, exe),
      [...args],
      {
        env: gdalEnv(loc),
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        cwd: options.cwd,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        const timedOut = Boolean(e?.killed) && e?.signal === 'SIGTERM';
        const code = e && typeof e.code === 'number' ? e.code : e ? 1 : 0;
        resolve({
          ok: !e,
          code,
          stdout: stdout ?? '',
          stderr: stderr ?? (e ? String(e.message) : ''),
          timedOut,
          command,
        });
      },
    );
  });
}

/** GDAL 常用工具集（exe 名不含 .exe 后缀，运行时补齐）。 */
export interface GdalTools {
  readonly info: (path: string, extra?: readonly string[]) => Promise<ToolResult>;
  readonly translate: (args: readonly string[]) => Promise<ToolResult>;
  readonly warp: (args: readonly string[]) => Promise<ToolResult>;
  readonly edit: (args: readonly string[]) => Promise<ToolResult>;
  readonly ogrInfo: (args: readonly string[]) => Promise<ToolResult>;
  readonly ogr2ogr: (args: readonly string[]) => Promise<ToolResult>;
  readonly buildOverviews: (args: readonly string[]) => Promise<ToolResult>;
  readonly buildVrt: (args: readonly string[]) => Promise<ToolResult>;
}

export function tools(loc: GdalLocation): GdalTools {
  const sfx = loc.exeSuffix;
  return {
    info: (path, extra = []) => runTool(loc, `gdalinfo${sfx}`, [path, ...extra]),
    translate: (args) => runTool(loc, `gdal_translate${sfx}`, args),
    warp: (args) => runTool(loc, `gdalwarp${sfx}`, args),
    edit: (args) => runTool(loc, `gdal_edit.py${sfx}`, args),
    ogrInfo: (args) => runTool(loc, `ogrinfo${sfx}`, args),
    ogr2ogr: (args) => runTool(loc, `ogr2ogr${sfx}`, args),
    buildOverviews: (args) => runTool(loc, `gdaladdo${sfx}`, args),
    buildVrt: (args) => runTool(loc, `gdalbuildvrt${sfx}`, args),
  };
}

/** 把 GDAL 的原始 stderr 归一化成"可读的错误类型"，供上层做人话翻译。 */
export type GdalErrorKind =
  | 'crs-missing'
  | 'file-locked'
  | 'format-unsupported'
  | 'driver-missing'
  | 'timeout'
  | 'not-found'
  | 'unknown';

export interface ClassifiedError {
  readonly kind: GdalErrorKind;
  readonly message: string;
  readonly raw: string;
}

export function classifyError(result: ToolResult): ClassifiedError {
  const raw = `${result.stderr}\n${result.stdout}`;
  const lower = raw.toLowerCase();

  if (result.timedOut) {
    return { kind: 'timeout', message: '处理超时，数据过大或盘符响应过慢', raw };
  }
  if (lower.includes('no such file') || lower.includes('does not exist') || lower.includes('not found')) {
    return { kind: 'not-found', message: '找不到指定的数据文件', raw };
  }
  if (lower.includes('permission denied') || lower.includes('file is locked') || lower.includes('being used by another process')) {
    return { kind: 'file-locked', message: '文件被其它程序占用（可能是 ArcGIS 正在打开它），请先在 ArcGIS 中移除该图层', raw };
  }
  if (lower.includes('no spatial reference') || lower.includes('assigning spatial reference') || lower.includes('crs') && lower.includes('not found')) {
    return { kind: 'crs-missing', message: '数据缺少坐标系，无法进行空间计算', raw };
  }
  if (lower.includes('not supported by the driver') || lower.includes('does not support')) {
    return { kind: 'format-unsupported', message: '该格式不支持此操作', raw };
  }
  if (lower.includes('driver') && lower.includes('not found') || lower.includes('no suitable driver')) {
    return { kind: 'driver-missing', message: '当前 GDAL 构建缺少所需驱动', raw };
  }
  return { kind: 'unknown', message: '处理失败', raw };
}
