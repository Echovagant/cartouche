/**
 * 引擎服务的应用层：只负责创建 http.Server，不绑定端口、不处理信号。
 * 拆开是为了可测试——冒烟测试直接在本进程内起服务并优雅关闭，
 * 避免 Windows 上强杀子进程导致 libuv 断言。
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LocalFolderStore,
  NotFoundError,
  OccupiedError,
  PathEscapeError,
  RootRegistry,
  ProjectStore,
  newManifest,
  type CompatOperation,
  type ProjectHistoryEntry,
  type ProjectManifest,
  type WorkspaceAdapter,
} from '@cartouche/engine';
import {
  resolveGdal,
  probeDataset,
  runHealthCheck,
  renderCompatReport,
  renderRasterPng,
  vectorToGeoJson,
  datasetExtent,
  buildPdfFromJpeg,
} from '@cartouche/engine';
import { llmStatus, scrub, setSessionApiKey } from './llm.ts';
import { loadRegisteredRoots, registerRoot } from './roots.ts';

const here = dirname(fileURLToPath(import.meta.url));
// dist/app.js → 仓库根目录
const repoRoot = join(here, '..', '..');

export interface EngineInfo {
  name: string;
  version: string;
  ops: number;
  workspaceRoot: string;
}

/** 工作区根目录：引擎只能在这个目录内读写 */
export const WORKSPACE_ROOT = process.env.ENGINE_WORKSPACE_ROOT ?? join(repoRoot, 'workspace');
const store = new LocalFolderStore(WORKSPACE_ROOT);

/* ── ③a-1：已登记根（默认根内置 + 用户登记的其它目录） ── */
const roots = new RootRegistry(WORKSPACE_ROOT);
loadRegisteredRoots(roots);

/* ── ③a-1：项目存储（清单 / 留痕 / 产出物） ── */
const projects = new ProjectStore(roots);

/** GDAL 运行时位置（找不到会在调用时给出可读错误） */
const gdalLoc = resolveGdal();
if (!gdalLoc) {
  console.warn('[engine] 未找到 GDAL，出图与体检相关接口将不可用；先运行 npm run doctor');
}

export function readSchema(): unknown {
  const p = join(repoRoot, 'src', 'engine', 'ops.schema.json');
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function opCount(): number {
  const schema = readSchema() as {
    $defs: { operation: { properties: { op: { enum: string[] } } } };
  };
  return schema.$defs.operation.properties.op.enum.length;
}

async function readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** 一次路径解析的结果：操作的 store、相对该 store 根的相对路径、绝对路径 */
interface WorkspaceTarget {
  readonly store: WorkspaceAdapter;
  readonly relative: string;
  readonly absolute: string;
}

/**
 * 把「根 + 相对路径」解析成可以操作的 store 与相对路径。
 *
 * - 不给 `root` → 相对**默认根**，与今天的行为完全一致；
 * - 给了 `root` → 先拼成绝对路径，再经 RootRegistry 最长前缀匹配找到所属的根。
 *   这样即便项目目录本身没被登记成根（只要在某个已登记根之下）也能正确定位。
 *
 * `path` **必须**是相对路径：绝对路径会绕过根的边界
 * （今天 `GET /api/fs/read?path=C:\任意路径` 就能读到工作区外的文件），
 * 一律按越界处理 —— 这是「路径安全不可放松」的要求。
 */
function resolveTarget(root: string | null, rel: string): WorkspaceTarget {
  // 绝对路径（含 `C:foo` 这种盘符相对写法）一律拒绝：它能绕过根的边界
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new PathEscapeError(rel);
  }
  if (!root) {
    // 不给 root：相对默认根。store.resolve 内部还会挡掉 `../` 逃逸
    return { store, relative: rel, absolute: store.resolve(rel) };
  }
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, rel);
  // 相对路径不得逃出它自己声明的那个根
  if (!isInside(rootAbs, abs)) throw new PathEscapeError(rel);
  // 且必须落在**某个已登记根**之下（不在 → PathEscapeError）
  const r = roots.resolve(abs);
  return { store: roots.storeFor(r.rootId), relative: r.relative, absolute: abs };
}

/** 只要绝对路径时用这个（出图 / 矢量 / 兼容性报告） */
function resolveWorkspacePath(root: string | null, rel: string): string {
  return resolveTarget(root, rel).absolute;
}

/**
 * 同上，但给出该路径所属根的 store 与**相对该根**的路径。
 * `/api/fs/*` 这类按 store 操作的地方用（`store.list(rel)` 收的是相对根的路径）。
 */
function storeFor(
  root: string | null,
  rel: string,
): { store: WorkspaceAdapter; relative: string } {
  const t = resolveTarget(root, rel);
  return { store: t.store, relative: t.relative };
}

/** 路径是否落在 root 之下（Windows 上文件系统不区分大小写） */
function isInside(rootPath: string, candidate: string): boolean {
  const root = foldCase(rootPath);
  const cand = foldCase(candidate);
  if (cand === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return cand.startsWith(prefix);
}

function foldCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** 项目默认名：取路径最后一段（Windows 与 POSIX 的分隔符都认） */
function defaultProjectName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function createEngineServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    /**
     * 跨域策略。
     *
     * 引擎只监听 127.0.0.1，所以它面对的"外部世界"只有本机上的页面。
     * 默认放行**回环地址来源**（http://127.0.0.1:<端口> / http://localhost:<端口>）
     * 与 `null`（file:// 加载的静态产物）：
     *
     *   - 来自互联网的页面（Origin 是 https://example.com 之类）→ 不放行，
     *     浏览器会拦下它的响应，引擎不会被任意网页调用；
     *   - 来自回环地址的页面 → 放行。理由：能在本机起服务的页面，
     *     本机就已经有代码在跑了，再挡也挡不住什么；而挡掉的话，
     *     本工具自己的画布（也是本机 http 页面）连不上引擎。
     *
     * 要更严就设 `ENGINE_ALLOWED_ORIGINS` 白名单：设了之后**只**放行列出的 Origin，
     * 回环地址不再自动放行。例如：
     *   ENGINE_ALLOWED_ORIGINS=http://127.0.0.1:8080
     */
    const allowedOrigins = (process.env.ENGINE_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const requestOrigin = req.headers.origin;
    const isLoopbackOrigin = (origin: string): boolean => {
      try {
        const u = new URL(origin);
        return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
      } catch {
        return false;
      }
    };
    const allowOrigin = !requestOrigin
      ? 'null'
      : allowedOrigins.length > 0
        ? (allowedOrigins.includes(requestOrigin) ? requestOrigin : 'null')
        : (isLoopbackOrigin(requestOrigin) ? requestOrigin : 'null');

    const corsHeaders = (): Record<string, string> => ({
      'access-control-allow-origin': allowOrigin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      'x-content-type-options': 'nosniff',
    });

    // 预检：带 content-type 的 POST 会触发浏览器预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    const json = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        ...corsHeaders(),
      });
      res.end(payload);
    };

    const binary = (status: number, buf: Buffer) => {
      res.writeHead(status, {
        'content-type': 'application/octet-stream',
        'content-length': buf.length,
        ...corsHeaders(),
      });
      res.end(buf);
    };

    /* ───────── 基础信息 ───────── */

    if (url.pathname === '/api/health') {
      const info: EngineInfo = {
        name: 'cartouche-engine',
        version: '0.1.0',
        ops: opCount(),
        workspaceRoot: WORKSPACE_ROOT,
      };
      json(200, { ok: true, ...info });
      return;
    }

    if (url.pathname === '/api/ops/schema') {
      json(200, readSchema());
      return;
    }

    /* ───────── 模型接入状态（只暴露状态，绝不返回密钥） ───────── */

    if (url.pathname === '/api/llm/status') {
      json(200, llmStatus());
      return;
    }

    if (url.pathname === '/api/llm/session-key' && req.method === 'POST') {
      void (async () => {
        try {
          const body = await readBody(req);
          const raw = body.toString('utf8').trim();
          // 约定：传 JSON {"apiKey":"..."}  设置；传空体或 {"clear":true} 清除
          let key: string | null = null;
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as { apiKey?: string; clear?: boolean };
              key = parsed.clear ? null : (parsed.apiKey?.trim() || null);
            } catch {
              json(400, { error: 'bad_request', message: '请求体必须是 JSON：{"apiKey":"..."} 或 {"clear":true}' });
              return;
            }
          }
          setSessionApiKey(key);
          json(200, llmStatus());
        } catch (err) {
          json(500, { error: 'internal', message: scrub((err as Error).message) });
        }
      })();
      return;
    }

    /* ───────── S5：出图 / 矢量 / 兼容性报告 ───────── */

    if (url.pathname === '/api/render/raster.png' && req.method === 'GET') {
      void (async () => {
        try {
          if (!gdalLoc) {
            json(503, { error: 'gdal_unavailable', message: '未找到 GDAL 运行时，出图与体检不可用；请先运行 npm run doctor' });
            return;
          }
          const rel = url.searchParams.get('path') ?? '';
          const root = url.searchParams.get('root');
          const width = Number(url.searchParams.get('width') ?? 1024);
          const height = Number(url.searchParams.get('height') ?? 768);
          const bboxParam = url.searchParams.get('bbox');
          const bbox = bboxParam
            ? (bboxParam.split(',').map(Number) as [number, number, number, number])
            : undefined;
          // 默认出 EPSG:4326 的图：前端 MapLibre 的 image source 是**按经纬度角点**贴图的，
          // 所以 PNG 必须是 4326 的，否则投影坐标系的栅格会与 bbox 对不上位（错开一块）。
          const targetCrs = url.searchParams.get('targetCrs') ?? 'EPSG:4326';
          const res = await renderRasterPng(gdalLoc, {
            path: resolveWorkspacePath(root, rel),
            width,
            height,
            targetCrs,
            ...(bbox ? { bbox } : {}),
          });
          binary(200, Buffer.from(res.png));
        } catch (err) {
          const message = (err as Error).message;
          const bad = err instanceof PathEscapeError || /bbox|范围不合法/.test(message) ? 400 : 500;
          json(bad, { error: bad === 400 ? 'bad_request' : 'internal', message: scrub(message) });
        }
      })();
      return;
    }

    if (url.pathname === '/api/data/geojson' && req.method === 'GET') {
      void (async () => {
        try {
          if (!gdalLoc) {
            json(503, { error: 'gdal_unavailable', message: '未找到 GDAL 运行时，出图与体检不可用；请先运行 npm run doctor' });
            return;
          }
          const rel = url.searchParams.get('path') ?? '';
          const root = url.searchParams.get('root');
          const limitParam = url.searchParams.get('limit');
          const res = await vectorToGeoJson(gdalLoc, {
            path: resolveWorkspacePath(root, rel),
            // ⚠️ 必须显式换算到 4326：ogr2ogr 不给 -t_srs 时**按源 CRS 输出**。
            //    投影坐标系的矢量会带着 UTM 东坐标/北坐标出去（如 816690, 3381042），
            //    MapLibre 当成经纬度解析 → 要素跑到几百万度外，画布上什么都看不见。
            //    实测：`-t_srs EPSG:4326` 输出的是 lon/lat 序（x=经度）。
            targetCrs: 'EPSG:4326',
            ...(limitParam ? { limit: Number(limitParam) } : {}),
          });
          json(200, res);
        } catch (err) {
          const bad = err instanceof PathEscapeError ? 400 : 500;
          json(bad, { error: bad === 400 ? 'bad_request' : 'internal', message: scrub((err as Error).message) });
        }
      })();
      return;
    }

    if (url.pathname === '/api/data/extent' && req.method === 'GET') {
      void (async () => {
        try {
          if (!gdalLoc) {
            json(503, { error: 'gdal_unavailable', message: '未找到 GDAL 运行时，出图与体检不可用；请先运行 npm run doctor' });
            return;
          }
          const rel = url.searchParams.get('path') ?? '';
          const root = url.searchParams.get('root');
          const res = await datasetExtent(gdalLoc, { path: resolveWorkspacePath(root, rel) });
          json(200, res);
        } catch (err) {
          const bad = err instanceof PathEscapeError ? 400 : 500;
          json(bad, { error: bad === 400 ? 'bad_request' : 'internal', message: scrub((err as Error).message) });
        }
      })();
      return;
    }

    if (url.pathname === '/api/report/compat' && req.method === 'POST') {
      void (async () => {
        try {
          if (!gdalLoc) {
            json(503, { error: 'gdal_unavailable', message: '未找到 GDAL 运行时，出图与体检不可用；请先运行 npm run doctor' });
            return;
          }
          const body = await readBody(req);
          const req0 = JSON.parse(body.toString('utf8') || '{}') as {
            path?: string;
            root?: string;
            operations?: CompatOperation[];
          };
          const rel = req0.path ?? '';
          const abs = resolveWorkspacePath(req0.root ?? null, rel);
          const { dataset } = await probeDataset(gdalLoc, abs);
          if (!dataset) {
            json(400, { error: 'bad_request', message: '无法打开该数据集' });
            return;
          }
          const health = await runHealthCheck(gdalLoc, abs);
          const report = renderCompatReport({
            path: rel,
            dataset,
            health,
            ...(req0.operations ? { operations: req0.operations } : {}),
            engineVersion: '0.1.0',
          });
          json(200, {
            markdown: report.markdown,
            hasBlocker: report.hasBlocker,
            manualChecks: report.manualChecks,
          });
        } catch (err) {
          const bad = err instanceof PathEscapeError ? 400 : 500;
          json(bad, { error: bad === 400 ? 'bad_request' : 'internal', message: scrub((err as Error).message) });
        }
      })();
      return;
    }

    if (url.pathname === '/api/export/pdf' && req.method === 'POST') {
      void (async () => {
        try {
          if (!gdalLoc) {
            json(503, { error: 'gdal_unavailable', message: '未找到 GDAL 运行时，出图与体检不可用；请先运行 npm run doctor' });
            return;
          }
          const body = await readBody(req);
          const req0 = JSON.parse(body.toString('utf8') || '{}') as {
            jpeg?: string;
            width?: number;
            height?: number;
            title?: string;
            operator?: string;
          };
          if (!req0.jpeg) {
            json(400, { error: 'bad_request', message: '缺少 jpeg（base64 数据 URL 或纯 base64）' });
            return;
          }
          const base64 = req0.jpeg.includes(',') ? req0.jpeg.split(',')[1]! : req0.jpeg;
          const jpeg = new Uint8Array(Buffer.from(base64, 'base64'));
          const pdf = buildPdfFromJpeg(jpeg, req0.width ?? 0, req0.height ?? 0, {
            ...(req0.title ? { title: req0.title } : {}),
            ...(req0.operator ? { author: req0.operator } : {}),
          });
          const out = Buffer.from(pdf);
          res.writeHead(200, {
            'content-type': 'application/pdf',
            'content-length': out.length,
            ...corsHeaders(),
            'content-disposition': 'attachment; filename="cartouche-export.pdf"',
          });
          res.end(out);
        } catch (err) {
          json(500, { error: 'internal', message: scrub((err as Error).message) });
        }
      })();
      return;
    }

    /* ───────── ③a-1：已登记根与项目 ───────── */

    if (url.pathname === '/api/workspace/roots' && req.method === 'GET') {
      json(200, { roots: roots.list() });
      return;
    }

    if (url.pathname === '/api/workspace/roots' && req.method === 'POST') {
      void (async () => {
        try {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as {
            path?: string;
            label?: string;
          };
          if (!body.path) {
            json(400, { error: 'bad_request', message: '缺少 path：告诉引擎要登记哪个文件夹' });
            return;
          }
          json(200, registerRoot(roots, body.path, body.label));
        } catch (err) {
          json(400, { error: 'bad_request', message: scrub((err as Error).message) });
        }
      })();
      return;
    }

    if (url.pathname === '/api/project/manifest' && req.method === 'GET') {
      void (async () => {
        try {
          const p = url.searchParams.get('path') ?? '';
          const m = await projects.readManifest(p);
          json(200, m ? { exists: true, manifest: m } : { exists: false });
        } catch (err) {
          json(400, { error: 'bad_request', message: scrub((err as Error).message) });
        }
      })();
      return;
    }

    if (url.pathname === '/api/project/manifest' && req.method === 'PUT') {
      void (async () => {
        try {
          const body = JSON.parse((await readBody(req)).toString('utf8')) as {
            path?: string;
            manifest?: ProjectManifest;
            create?: boolean;
            name?: string;
          };
          if (!body.path) {
            json(400, { error: 'bad_request', message: '缺少 path：告诉引擎是哪个文件夹' });
            return;
          }
          // create：写一份空清单。**已存在就不覆盖** —— 免得把用户已经配好的项目冲掉。
          if (body.create) {
            const existing = await projects.readManifest(body.path);
            if (existing) {
              json(200, { ok: true, manifest: existing, created: false });
              return;
            }
            const name = (body.name ?? '').trim() || defaultProjectName(body.path);
            const m = newManifest(name);
            await projects.writeManifest(body.path, m);
            json(200, { ok: true, manifest: m, created: true });
            return;
          }
          if (!body.manifest) {
            json(400, { error: 'bad_request', message: '缺少 manifest：把要保存的项目清单一起发来' });
            return;
          }
          await projects.writeManifest(body.path, body.manifest);
          json(200, { ok: true });
        } catch (err) {
          json(400, { error: 'bad_request', message: scrub((err as Error).message) });
        }
      })();
      return;
    }

    if (url.pathname === '/api/project/history' && req.method === 'GET') {
      void (async () => {
        try {
          const p = url.searchParams.get('path') ?? '';
          json(200, { entries: await projects.readHistory(p) });
        } catch (err) {
          json(400, { error: 'bad_request', message: scrub((err as Error).message) });
        }
      })();
      return;
    }

    if (url.pathname === '/api/project/history' && req.method === 'POST') {
      void (async () => {
        try {
          const body = JSON.parse((await readBody(req)).toString('utf8')) as {
            path?: string;
            entry?: ProjectHistoryEntry;
          };
          if (!body.path || !body.entry) {
            json(400, { error: 'bad_request', message: '缺少 path 或 entry：告诉引擎是哪个项目、要记哪一条操作' });
            return;
          }
          await projects.appendHistory(body.path, body.entry);
          json(200, { ok: true });
        } catch (err) {
          json(400, { error: 'bad_request', message: scrub((err as Error).message) });
        }
      })();
      return;
    }

    if (url.pathname === '/api/project/outputs' && req.method === 'GET') {
      void (async () => {
        try {
          const p = url.searchParams.get('path') ?? '';
          json(200, { outputs: await projects.listOutputs(p) });
        } catch (err) {
          json(400, { error: 'bad_request', message: scrub((err as Error).message) });
        }
      })();
      return;
    }

    if (url.pathname === '/api/project/output' && req.method === 'POST') {
      void (async () => {
        try {
          const body = JSON.parse((await readBody(req)).toString('utf8')) as {
            path?: string;
            name?: string;
            dataBase64?: string;
          };
          if (!body.path || !body.name || !body.dataBase64) {
            json(400, { error: 'bad_request', message: '缺少 path / name / dataBase64：告诉引擎存到哪个项目、叫什么名字、内容是什么' });
            return;
          }
          const data = Buffer.from(body.dataBase64, 'base64');
          const relative = await projects.writeOutput(
            body.path,
            body.name,
            new Uint8Array(data),
          );
          json(200, { ok: true, relative });
        } catch (err) {
          json(400, { error: 'bad_request', message: scrub((err as Error).message) });
        }
      })();
      return;
    }

    /* ───────── 工作区文件接口（契约见 src/engine/workspace/http-store.ts） ───────── */

    if (url.pathname.startsWith('/api/fs/')) {
      void (async () => {
        try {
          if (req.method === 'GET' && url.pathname === '/api/fs/read') {
            const p = url.searchParams.get('path') ?? '';
            const s = storeFor(url.searchParams.get('root'), p);
            const data = await s.store.read(s.relative);
            binary(200, Buffer.from(data));
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/fs/stat') {
            const p = url.searchParams.get('path') ?? '';
            const s = storeFor(url.searchParams.get('root'), p);
            const st = await s.store.stat(s.relative);
            json(200, st);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/fs/list') {
            const p = url.searchParams.get('path') ?? '';
            const s = storeFor(url.searchParams.get('root'), p);
            json(200, { entries: await s.store.list(s.relative) });
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody(req);
            if (url.pathname === '/api/fs/write') {
              const sep = body.indexOf(0);
              if (sep < 0) {
                json(400, { error: 'bad_request', message: '缺少 path 分隔符' });
                return;
              }
              const p = body.subarray(0, sep).toString('utf8');
              const data = new Uint8Array(body.subarray(sep + 1));
              // 写操作同样要过路径闸门：绝对路径等于可以改工作区外的文件
              const t = resolveTarget(null, p);
              await t.store.write(t.relative, data);
              json(200, { ok: true, size: data.length });
              return;
            }
            if (url.pathname === '/api/fs/remove') {
              const t = resolveTarget(null, body.toString('utf8'));
              await t.store.remove(t.relative);
              json(200, { ok: true });
              return;
            }
            if (url.pathname === '/api/fs/copy' || url.pathname === '/api/fs/rename') {
              const [from, to] = body.toString('utf8').split('\n');
              if (!from || !to) {
                json(400, { error: 'bad_request' });
                return;
              }
              const f = resolveTarget(null, from);
              const t = resolveTarget(null, to);
              if (url.pathname === '/api/fs/copy') await f.store.copy(f.relative, t.relative);
              else await f.store.rename(f.relative, t.relative);
              json(200, { ok: true });
              return;
            }
            if (url.pathname === '/api/fs/assert-writable') {
              const t = resolveTarget(null, body.toString('utf8'));
              await t.store.assertWritable(t.relative);
              json(200, { ok: true });
              return;
            }
          }
        } catch (err) {
          if (err instanceof OccupiedError) {
            json(409, { error: 'occupied', path: err.path, message: err.message });
            return;
          }
          if (err instanceof NotFoundError) {
            json(404, { error: 'not_found', path: err.path, message: err.message });
            return;
          }
          if (err instanceof PathEscapeError) {
            json(400, { error: 'path_escape', path: err.path, message: err.message });
            return;
          }
          const e = err as NodeJS.ErrnoException;
          if (e?.code === 'ENOENT') {
            json(404, { error: 'not_found', message: e.message });
            return;
          }
          json(500, { error: 'internal', message: e?.message ?? String(err) });
          return;
        }
        json(404, { error: 'not_found', path: url.pathname });
      })();
      return;
    }

    json(404, { ok: false, error: 'not_found', path: url.pathname });
  });
}
