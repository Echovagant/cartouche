/**
 * 按需 MVT 瓦片（B 阶段：大矢量显示）。
 *
 * 为什么按需切而不是预生成整库：
 *   - 5 GB 数据在 z12 全量预生成会有海量瓦片；按视口请求只切需要的九宫格。
 *   - GPKG 有空间索引，`-spat` 后单块实测 0.3–1.3 秒；切片结果落缓存，第二次直接读。
 *   - 低倍瓦片首次生成较慢（覆盖整幅数据），但数量少，缓存后同样即时。
 *
 * 缓存位置：数据旁边的 `.cartouche/mvt/<源指纹>/<z>/<x>/<y>.pbf`。
 * 源文件 mtime/size 一变指纹就变，旧缓存自然失联。
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { tools, type GdalTools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';
import { probeLayer } from '../vector/read.ts';

/** 经纬度 → Web Mercator XYZ 瓦片号 */
export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

/** XYZ 瓦片 → EPSG:4326 包围盒 [minX, minY, maxX, maxY] */
export function tileBbox4326(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (tx: number) => (tx / n) * 360 - 180;
  const lat = (ty: number) => {
    const m = Math.PI * (1 - (2 * ty) / n);
    return (Math.atan(Math.sinh(m)) * 180) / Math.PI;
  };
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

export interface MvtTileOptions {
  /** 矢量文件绝对路径 */
  readonly path: string;
  readonly z: number;
  readonly x: number;
  readonly y: number;
  /** 图层名；多图层容器不传时取第一层 */
  readonly layerName?: string;
}

export interface MvtTileResult {
  readonly bytes: Uint8Array;
  readonly cachePath: string;
  readonly layerName: string;
  /** true = 本次现场生成；false = 命中缓存 */
  readonly generated: boolean;
  /** 瓦片字节是否是 gzip（响应要带 Content-Encoding: gzip） */
  readonly compressed: boolean;
}

/** 源文件指纹：路径 + mtime + size */
function sourceHash(absPath: string): string {
  const st = statSync(absPath);
  return createHash('sha1')
    .update(`${absPath}\u0000${st.mtimeMs}\u0000${st.size}`)
    .digest('hex')
    .slice(0, 16);
}

function assertTile(z: number, x: number, y: number): void {
  if (!Number.isInteger(z) || z < 0 || z > 22) throw new Error(`瓦片层级不合法：${z}`);
  const n = 2 ** z;
  if (!Number.isInteger(x) || x < 0 || x >= n) throw new Error(`瓦片 x 不合法：${x}（z=${z} 应在 0–${n - 1}）`);
  if (!Number.isInteger(y) || y < 0 || y >= n) throw new Error(`瓦片 y 不合法：${y}（z=${z} 应在 0–${n - 1}）`);
}

function copyTiles(src: string, dst: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTiles(from, to);
    } else if (entry.name.endsWith('.pbf')) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
}

const inFlight = new Map<string, Promise<MvtTileResult | null>>();

/**
 * 切片并发上限。
 *
 * 一屏要十几块瓦片，但每块都要 GDAL 全量扫一遍源数据（5 GB 实测单块
 * 二十秒级）。不限流的话，MapLibre 一次请求十几块 = 十几个 ogr2ogr
 * 同时扫同一个文件，磁盘与 CPU 互相拖死，反而比串行还慢。
 * 每次 `-spat` 会顺带产出周围 3×3 的瓦片，排在后面的请求多半会直接命中缓存。
 */
const MAX_CONCURRENT_TILES = 2;
let activeTiles = 0;
const tileWaiters: Array<() => void> = [];

async function withTileSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeTiles >= MAX_CONCURRENT_TILES) {
    await new Promise<void>((resolve) => tileWaiters.push(resolve));
  }
  activeTiles += 1;
  try {
    return await fn();
  } finally {
    activeTiles -= 1;
    tileWaiters.shift()?.();
  }
}

/**
 * 图层名内存缓存（按源指纹）。
 *
 * 每块瓦片都起一次 ogrinfo 探图层名是纯浪费：一屏九到十几块瓦片，
 * 光探测就要多花一秒多。源文件一变指纹就变，缓存自然失效。
 */
const layerNameCache = new Map<string, readonly string[]>();

async function layerNamesFor(
  loc: GdalLocation,
  absPath: string,
  hash: string,
): Promise<readonly string[]> {
  const hit = layerNameCache.get(hash);
  if (hit) return hit;
  const info = await probeLayer(loc, absPath);
  layerNameCache.set(hash, info.layerNames);
  return info.layerNames;
}

/**
 * 取一块 MVT 瓦片。没有要素时返回 null（调用方回 204）。
 *
 * GDAL 的 MVT 驱动会围绕 `-spat` 生成 3×3 九宫格；这里把九块全部落缓存，
 * 相邻瓦片下一次请求就直接命中。
 */
export async function buildMvtTile(
  loc: GdalLocation,
  options: MvtTileOptions,
): Promise<MvtTileResult | null> {
  const { path: absPath, z, x, y } = options;
  assertTile(z, x, y);
  if (!existsSync(absPath)) throw new Error(`矢量文件不存在：${absPath}`);

  const hash = sourceHash(absPath);
  const cacheDir = join(dirname(absPath), '.cartouche', 'mvt', hash);
  const target = join(cacheDir, String(z), String(x), `${y}.pbf`);
  // 空瓦片也要落个记号：数据范围之外的瓦片每次重跑一遍 ogr2ogr 是几百毫秒，
  // 拖动到空白区域时会连续请求十几块 —— 不记下来等于反复白跑。
  const emptyMarker = join(dirname(target), `${y}.empty`);
  if (existsSync(emptyMarker)) return null;

  if (existsSync(target)) {
    const layerName =
      options.layerName ?? (await layerNamesFor(loc, absPath, hash))[0];
    if (!layerName) throw new Error(`这个矢量文件没有可切的图层：${absPath}`);
    const bytes = new Uint8Array(readFileSync(target));
    return {
      bytes,
      cachePath: target,
      layerName,
      generated: false,
      compressed: bytes[0] === 0x1f && bytes[1] === 0x8b,
    };
  }

  const layerName = options.layerName ?? (await layerNamesFor(loc, absPath, hash))[0];
  if (!layerName) throw new Error(`这个矢量文件没有可切的图层：${absPath}`);

  const key = target;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = withTileSlot(async (): Promise<MvtTileResult | null> => {
    // 排队期间，前面那次 -spat 的 3×3 产出可能已经把这块顺带切好了
    if (existsSync(target)) {
      const bytes = new Uint8Array(readFileSync(target));
      return {
        bytes,
        cachePath: target,
        layerName,
        generated: false,
        compressed: bytes[0] === 0x1f && bytes[1] === 0x8b,
      };
    }
    const gdal: GdalTools = tools(loc);
    // MVT 驱动要求输出目录**不存在**；mkdtemp 先给一个父目录，真正输出放到 tiles/
    const tmpRoot = mkdtempSync(join(tmpdir(), 'cartouche-mvt-'));
    const workDir = join(tmpRoot, 'tiles');
    try {
      const bbox = tileBbox4326(z, x, y);
      const args = [
        '-f', 'MVT',
        '-spat', String(bbox[0]), String(bbox[1]), String(bbox[2]), String(bbox[3]),
        '-spat_srs', 'EPSG:4326',
        '-dsco', `MINZOOM=${z}`,
        '-dsco', `MAXZOOM=${z}`,
        // 本地也压缩：5 GB 密面数据 z12 瓦片原始 291 KB，gzip 后约 3 KB
        '-dsco', 'COMPRESS=YES',
        '-nln', layerName,
        workDir, absPath,
        // 只切这一层（位置参数必须跟在源后面）：多图层容器不指定源图层时
        // 会整份输出，瓦片里就会出现用户没在看的层（source-layer 也会对不上）。
        layerName,
      ];
      const res = await gdal.ogr2ogr(args, { timeoutMs: 120_000 });
      if (!res.ok) throw new Error(`MVT 切片失败：${absPath}\n${res.stderr}`);

      mkdirSync(cacheDir, { recursive: true });
      copyTiles(workDir, cacheDir);

      if (!existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(emptyMarker, '');
        return null;
      }
      const bytes = new Uint8Array(readFileSync(target));
      return {
        bytes,
        cachePath: target,
        layerName,
        generated: true,
        compressed: bytes[0] === 0x1f && bytes[1] === 0x8b,
      };
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}
