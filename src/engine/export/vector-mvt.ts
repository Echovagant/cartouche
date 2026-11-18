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
import { datasetExtent } from './dataset-extent.ts';

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

/** 低倍预热入参：把 z0–maxZoom 覆盖数据范围的瓦片一次性切好 */
export interface MvtWarmOptions {
  /** 矢量文件绝对路径 */
  readonly path: string;
  /** 预热到哪一级（含）；默认 7 */
  readonly maxZoom?: number;
  /** 图层名；不传取第一层 */
  readonly layerName?: string;
}

/** 低倍预热结果 */
export interface MvtWarmResult {
  /** 覆盖数据范围的低倍瓦片总数 */
  readonly tiles: number;
  /** 本次新生成的块数 */
  readonly generated: number;
  /** 本次之前就有缓存的块数 */
  readonly cached: number;
  /** 这些瓦片的缓存总字节数 */
  readonly bytes: number;
  readonly ms: number;
  readonly maxZoom: number;
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
const tileWaiters: Array<{ readonly background: boolean; readonly resolve: () => void }> = [];

/**
 * 取一个切片执行位。
 *
 * 前台（用户正在看的瓦片）排在后台预热前面：预热是一次一百多秒的重活，
 * 不能让它在队列里堵住用户刚拖到的瓦片。
 */
async function withTileSlot<T>(fn: () => Promise<T>, background = false): Promise<T> {
  // 用 while 而不是 if：被唤醒到真正开跑之间，空出的位置可能被新来的请求
  // 先拿走（经典信号量交接竞态）；拿不到就继续排队，保证并发绝不超过上限。
  while (activeTiles >= MAX_CONCURRENT_TILES) {
    await new Promise<void>((resolve) => {
      const waiter = { background, resolve };
      const firstBackground = tileWaiters.findIndex((w) => w.background);
      if (!background && firstBackground >= 0) tileWaiters.splice(firstBackground, 0, waiter);
      else tileWaiters.push(waiter);
    });
  }
  activeTiles += 1;
  try {
    return await fn();
  } finally {
    activeTiles -= 1;
    tileWaiters.shift()?.resolve();
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

/** 覆盖 bbox 的低倍瓦片清单（z0..maxZoom，含边界） */
function tilesForExtent(
  bbox: readonly [number, number, number, number],
  maxZoom: number,
): Array<{ z: number; x: number; y: number }> {
  const out: Array<{ z: number; x: number; y: number }> = [];
  const clamp = (v: number, n: number): number => Math.min(n - 1, Math.max(0, v));
  for (let z = 0; z <= maxZoom; z += 1) {
    const n = 2 ** z;
    const west = clamp(Math.floor(((bbox[0] + 180) / 360) * n), n);
    const east = clamp(Math.floor(((bbox[2] + 180) / 360) * n), n);
    const north = clamp(lonLatToTile(bbox[0], bbox[3], z).y, n);
    const south = clamp(lonLatToTile(bbox[0], bbox[1], z).y, n);
    for (let x = Math.min(west, east); x <= Math.max(west, east); x += 1) {
      for (let y = Math.min(north, south); y <= Math.max(north, south); y += 1) {
        out.push({ z, x, y });
      }
    }
  }
  return out;
}

/** 正在预热的任务（同一源 + 同一层级只跑一份） */
const warmInFlight = new Map<string, Promise<MvtWarmResult>>();

/**
 * 预热任务串行队列：不同数据集的预热也不并发。
 *
 * 每个预热都是一次几分钟的全量扫描；两个同时跑只会互相抢磁盘，
 * 还会把前台瓦片挤到没位置。串起来后，第二个预热等第一个跑完再开始。
 */
let warmChain: Promise<unknown> = Promise.resolve();
function enqueueWarm<T>(fn: () => Promise<T>): Promise<T> {
  const next = warmChain.then(fn, fn);
  warmChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * 低倍预热：把 z0–maxZoom 覆盖数据范围的瓦片一次性切好并落缓存。
 *
 * 为什么用**一次** ogr2ogr 生成整段层级：每级单独跑都要把源数据完整扫一遍，
 * 5.04 GB 数据 z0–z7 逐级跑约 5 分钟；一次任务连续输出只要 161 秒（实测），
 * 瓦片 17 块、2.3 MB。预热在后台排队（让位给用户正在看的瓦片），
 * 完成后低倍视图直接命中缓存，不再等几十秒。
 */
export async function warmMvtTiles(
  loc: GdalLocation,
  options: MvtWarmOptions,
): Promise<MvtWarmResult> {
  const absPath = options.path;
  if (!existsSync(absPath)) throw new Error(`矢量文件不存在：${absPath}`);
  const maxZoom = options.maxZoom ?? 7;
  if (!Number.isInteger(maxZoom) || maxZoom < 1 || maxZoom > 14) {
    throw new Error(`预热层级不合法：${maxZoom}（应为 1–14 的整数）`);
  }
  const hash = sourceHash(absPath);
  const key = `${hash}:${maxZoom}:${options.layerName ?? ''}`;
  const pending = warmInFlight.get(key);
  if (pending) return pending;
  const task = warmInternal(loc, absPath, hash, maxZoom, options.layerName);
  warmInFlight.set(key, task);
  try {
    return await task;
  } finally {
    warmInFlight.delete(key);
  }
}

async function warmInternal(
  loc: GdalLocation,
  absPath: string,
  hash: string,
  maxZoom: number,
  requestedLayer: string | undefined,
): Promise<MvtWarmResult> {
  const t0 = Date.now();
  const extent = await datasetExtent(loc, { path: absPath });
  const layerName = requestedLayer ?? extent.layerNames?.[0];
  if (!layerName) throw new Error(`这个矢量文件没有可切的图层：${absPath}`);

  const wanted = tilesForExtent(extent.bbox, maxZoom);
  if (wanted.length === 0) throw new Error(`数据范围为空，无法预热瓦片：${absPath}`);
  const cacheDir = join(dirname(absPath), '.cartouche', 'mvt', hash);
  const targetOf = (tile: { z: number; x: number; y: number }): string =>
    join(cacheDir, String(tile.z), String(tile.x), `${tile.y}.pbf`);
  const emptyOf = (tile: { z: number; x: number; y: number }): string =>
    join(cacheDir, String(tile.z), String(tile.x), `${tile.y}.empty`);
  // 有瓦片或空记号都算"已就绪"：空记号是上次预热确认过没有要素的块
  const isReady = (tile: { z: number; x: number; y: number }): boolean =>
    existsSync(targetOf(tile)) || existsSync(emptyOf(tile));

  const missing = wanted.filter((tile) => !isReady(tile));
  const cached = wanted.length - missing.length;

  if (missing.length > 0) {
    const gdal: GdalTools = tools(loc);
    // MVT 驱动要求输出目录不存在；mkdtemp 给父目录，真正输出放 tiles/
    const tmpRoot = mkdtempSync(join(tmpdir(), 'cartouche-mvt-warm-'));
    const workDir = join(tmpRoot, 'tiles');
    try {
      const [minX, minY, maxX, maxY] = extent.bbox;
      const args = [
        '-f', 'MVT',
        '-spat', String(minX), String(minY), String(maxX), String(maxY),
        '-spat_srs', 'EPSG:4326',
        '-dsco', 'MINZOOM=0',
        '-dsco', `MAXZOOM=${maxZoom}`,
        '-dsco', 'COMPRESS=YES',
        '-nln', layerName,
        workDir, absPath,
        layerName,
      ];
      // 大源一次扫完要几分钟：超时给足；预热之间串行，且让位给前台瓦片
      const res = await enqueueWarm(() =>
        withTileSlot(() => gdal.ogr2ogr(args, { timeoutMs: 900_000 }), true),
      );
      if (!res.ok) {
        throw new Error(
          `低倍瓦片预热失败：${absPath}` +
            (res.timedOut ? '（超时）' : '') +
            (res.stderr ? `\n${res.stderr.slice(-300)}` : ''),
        );
      }
      mkdirSync(cacheDir, { recursive: true });
      if (existsSync(workDir)) copyTiles(workDir, cacheDir);
      // 覆盖范围内确实没有要素的块：落空记号，后续不再重跑
      for (const tile of wanted) {
        if (existsSync(targetOf(tile))) continue;
        const marker = emptyOf(tile);
        mkdirSync(dirname(marker), { recursive: true });
        writeFileSync(marker, '');
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  let bytes = 0;
  for (const tile of wanted) {
    const target = targetOf(tile);
    if (existsSync(target)) bytes += statSync(target).size;
  }
  return {
    tiles: wanted.length,
    generated: missing.length,
    cached,
    bytes,
    ms: Date.now() - t0,
    maxZoom,
  };
}
