/**
 * 操作计划调度器（栅格编辑闭环）。
 *
 * 一份计划 = 一串 op。调度器的职责只有四件，**一件都不多**：
 *   1. 逐条执行；
 *   2. 每条给出**量化影响**（改了多少像元、改前改后的校验和、备份在哪）；
 *   3. 失败**不回滚** —— 已完成的条目照常生效，报告里写清"已完成 N 条、第 K 条失败"；
 *   4. 没实现的 op 明确说"该操作尚未支持"，**不静默跳过**。
 *
 * 为什么失败不回滚：单条 op 的写回是原子的（临时文件 → 原子替换 → 回读校验），
 * 一条失败不会把文件改坏到"半截状态"。这时把前面几条一起撤掉，
 * 反而会让用户手里的文件和报告对不上 —— 报告说的是"改了 2 处"，
 * 磁盘上却回到 0 处，那才叫说不清。
 *
 * 两套输入形状都收：
 *   - 计划文档 `{ version, intent?, ops: [...] }`（ops.schema.json 里的那个形状）
 *   - 单条 `{ op, params }`（模板产出的形状）
 */
import { RasterEditor, type RasterOpResult } from '../raster/index.ts';
import {
  buildPixelMask,
  geoToPixelRegion,
  type GeoBounds,
  type PixelMask,
  type PixelRegion,
} from '../raster/mask.ts';
import { probeDataset } from '../gdal/probe.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { WorkspaceAdapter } from '../workspace/index.ts';

/* ── 对外类型 ─────────────────────────────────────────────── */

export interface OperationSpec {
  readonly op: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** 执行前的前置条件（如 crsEqual / sourceExists） */
  readonly preconditions?: Readonly<Record<string, unknown>>;
  /** 执行前的预期上限；超出则中止并报告 */
  readonly expect?: Readonly<Record<string, unknown>>;
  /** 涉及删除、批量修改时必须人工确认 */
  readonly requireUserConfirm?: boolean;
}

export interface PlanDocument {
  readonly version?: string;
  readonly intent?: string;
  readonly ops: readonly OperationSpec[];
}

export interface OpImpact {
  readonly affectedPixels: number;
  readonly totalPixels: number;
  /** 受影响比例 0~1 */
  readonly affectedRatio: number;
  readonly backupPath: string | null;
  readonly verified: boolean;
  readonly checksumBefore: string;
  readonly checksumAfter: string;
  readonly width: number;
  readonly height: number;
  readonly bandCount: number;
  /** true = 这是预演的结果，文件没被写过 */
  readonly dryRun?: boolean;
}

export interface OpExecutionRecord {
  readonly index: number;
  readonly op: string;
  readonly ok: boolean;
  readonly target: string;
  /** 该 op 尚未实现 */
  readonly unimplemented?: boolean;
  readonly impact?: OpImpact;
  readonly error?: string;
}

export interface PlanExecutionResult {
  readonly ok: boolean;
  readonly results: readonly OpExecutionRecord[];
  /** 成功执行的条数 */
  readonly completed: number;
  /** 失败那条的下标（0 起）；没有失败则不存在 */
  readonly failedAt?: number;
}

export interface ExecutorDeps {
  readonly loc: GdalLocation;
  readonly store: WorkspaceAdapter;
}

/** 计划文档或单条 op —— 两种形状都能收 */
export type PlanInput = PlanDocument | OperationSpec;

/* ── op 注册表 ─────────────────────────────────────────────── */

interface OpHandler {
  /** 中文名，给报告和确认卡用 */
  readonly label: string;
  /**
   * 能不能预演。
   * GDAL 级操作（裁切 / 重采样 / 拼接）要真的产出临时文件才知道影响面，
   * 预演不了 —— 这种 op 在预演时直接说"该操作无法预演影响面"，
   * 而不是给一个假的像元数。
   */
  readonly previewable: boolean;
  run(
    editor: RasterEditor,
    params: Readonly<Record<string, unknown>>,
    dryRun: boolean,
  ): Promise<RasterOpResult>;
}

/**
 * 已实现的 op。
 *
 * 这里只登记**引擎里真的能跑**的。schema 里的 23 个 op 有 10 个是矢量编辑
 * （矢量编辑类 op 尚未实现），另有 dataset.* 与 export.* 已经由各自的端点承担
 * （`/api/report/compat`、`/api/render/raster.png`、`/api/export/pdf`），
 * 所以这里不重复登记。
 */
const IMPLEMENTED: Readonly<Record<string, OpHandler>> = {
  'raster.paint': {
    label: '涂色',
    previewable: true,
    run: async (editor, params, dryRun) => {
      const mask = readMask(params);
      return editor.paint(
        {
          target: requireTarget(params),
          region: requireRegion(params),
          color: requireColor(params),
          ...(mask ? { mask } : {}),
        },
        { dryRun },
      );
    },
  },
  'raster.erase': {
    label: '擦除',
    previewable: true,
    run: async (editor, params, dryRun) => {
      const source = readRelPath(params, 'source');
      return editor.erase(
        {
          target: requireTarget(params),
          region: requireRegion(params),
          ...(source ? { source } : {}),
        },
        { dryRun },
      );
    },
  },
  'raster.replaceRegion': {
    label: '区域替换',
    previewable: true,
    run: async (editor, params, dryRun) => {
      const bbox = readBbox(params);
      // region 缺省时必须给 undefined，不能给一个零区域：
      // 零区域会把「region ?? bbox 换算」里的 bbox 分支挡掉，
      // 结果是预演与执行都报 ok，却一个像元都没改。
      const region = requireRegion(params, { optional: true });
      return editor.replaceRegion(
        {
          source: requireRelPath(params, 'source'),
          target: requireTarget(params),
          ...(region ? { region } : {}),
          ...(bbox ? { bbox } : {}),
        },
        { dryRun },
      );
    },
  },
  'raster.inpaint': {
    label: '边界修补',
    previewable: true,
    run: async (editor, params, dryRun) => {
      const radiusPx = readNumber(params, 'radiusPx');
      return editor.inpaint(
        {
          target: requireTarget(params),
          region: requireRegion(params),
          ...(radiusPx !== undefined ? { radiusPx } : {}),
        },
        { dryRun },
      );
    },
  },
  'raster.adjustLevels': {
    label: '亮度对比度调整',
    previewable: true,
    run: async (editor, params, dryRun) => {
      const method = readString(params, 'method');
      const brightness = readNumber(params, 'brightness');
      const contrast = readNumber(params, 'contrast');
      const gamma = readNumber(params, 'gamma');
      return editor.adjustLevels(
        {
          target: requireTarget(params),
          ...(method ? { method: method as 'linear-stretch' | 'gamma' | 'manual' } : {}),
          ...(brightness !== undefined ? { brightness } : {}),
          ...(contrast !== undefined ? { contrast } : {}),
          ...(gamma !== undefined ? { gamma } : {}),
        },
        { dryRun },
      );
    },
  },
  'raster.clip': {
    label: '裁切',
    previewable: false,
    run: async (editor, params) => {
      const bbox = readBbox(params);
      const clip = readRelPath(params, 'clip');
      return editor.clip({
        target: requireTarget(params),
        ...(bbox ? { bbox } : {}),
        ...(clip ? { clip } : {}),
      });
    },
  },
  'raster.resample': {
    label: '重采样',
    previewable: false,
    run: async (editor, params) => {
      const targetResolution = readNumber(params, 'targetResolution');
      const resampleMethod = readString(params, 'resampleMethod');
      return editor.resample({
        target: requireTarget(params),
        ...(targetResolution !== undefined ? { targetResolution } : {}),
        ...(resampleMethod ? { resampleMethod: resampleMethod as 'nearest' | 'bilinear' | 'cubic' | 'average' } : {}),
      });
    },
  },
  'raster.mosaic': {
    label: '拼接',
    previewable: false,
    run: async (editor, params) => {
      const inputs = params['inputs'];
      if (!Array.isArray(inputs) || inputs.length < 2) {
        throw new Error('拼接至少需要两幅影像');
      }
      const output = readString(params, 'output');
      const overlap = readString(params, 'overlap');
      return editor.mosaic({
        inputs: inputs.map((x) => toRelPath(String(x))),
        ...(output ? { output: toRelPath(output) } : {}),
        ...(overlap ? { overlap: overlap as 'first' | 'last' | 'blend' } : {}),
      });
    },
  },
};

/** 已实现的 op 名字 */
export function listImplementedOps(): string[] {
  return Object.keys(IMPLEMENTED).sort();
}

/* ── 计划归一化 ───────────────────────────────────────────── */

/**
 * 把两种输入形状统一成"一份计划"。
 *
 * 单条 op 直接包成一条计划 —— 快捷路径和完整路径走**同一段代码**，
 * 免得两条路各修一半、行为不一致。
 */
export function normalizePlan(input: PlanInput): PlanDocument {
  if (Array.isArray((input as PlanDocument).ops)) {
    const p = input as PlanDocument;
    return {
      ...(p.version !== undefined ? { version: p.version } : {}),
      ...(p.intent !== undefined ? { intent: p.intent } : {}),
      ops: p.ops,
    };
  }
  const single = input as OperationSpec;
  if (typeof single?.op !== 'string') {
    throw new Error('操作计划格式不对：需要 { op, params } 或 { version, ops: [...] }');
  }
  return { ops: [single] };
}

/* ── 预演与执行 ───────────────────────────────────────────── */

/**
 * 预演一条 op：**不写盘**，只算出影响面。
 *
 * 确认卡要在用户点头之前报出"会影响多少像元"。如果这里给的是估算值，
 * 确认卡就成了摆设 —— 用户看到的数字和真执行对不上，闸门形同虚设。
 */
export async function previewOp(deps: ExecutorDeps, spec: OperationSpec): Promise<OpExecutionRecord> {
  const handler = IMPLEMENTED[spec.op];
  const target = targetOf(spec);
  if (!handler) {
    return {
      index: 0,
      op: spec.op,
      ok: false,
      target,
      unimplemented: true,
      error: `该操作尚未支持：${spec.op}`,
    };
  }
  if (!handler.previewable) {
    return {
      index: 0,
      op: spec.op,
      ok: false,
      target,
      error: `该操作无法预演影响面（${handler.label}需要真的产出文件才能知道改了什么）；确认后可直接执行。`,
    };
  }
  try {
    const params = await normalizeParams(deps, spec);
    const editor = new RasterEditor({ loc: deps.loc, store: deps.store });
    const result = await handler.run(editor, params, true);
    return { index: 0, op: spec.op, ok: true, target, impact: toImpact(result) };
  } catch (err) {
    return { index: 0, op: spec.op, ok: false, target, error: messageOf(err) };
  }
}

/**
 * 执行一份计划。
 *
 * 逐条执行；**第一条失败就停**（后面的 op 依赖前面的结果，盲目继续只会越改越乱），
 * 但**已经完成的不回滚**。
 */
export async function executePlan(deps: ExecutorDeps, input: PlanInput): Promise<PlanExecutionResult> {
  const plan = normalizePlan(input);
  const editor = new RasterEditor({ loc: deps.loc, store: deps.store });
  const results: OpExecutionRecord[] = [];
  let completed = 0;
  let failedAt: number | undefined;

  for (let i = 0; i < plan.ops.length; i++) {
    const spec = plan.ops[i]!;
    const target = targetOf(spec);
    const handler = IMPLEMENTED[spec.op];

    if (!handler) {
      // 没实现的 op 不静默跳过：明确写出来，并就地停下
      results.push({
        index: i,
        op: spec.op,
        ok: false,
        target,
        unimplemented: true,
        error: `该操作尚未支持：${spec.op}`,
      });
      failedAt = i;
      break;
    }

    let params: Readonly<Record<string, unknown>>;
    try {
      params = await normalizeParams(deps, spec);
    } catch (err) {
      results.push({ index: i, op: spec.op, ok: false, target, error: messageOf(err) });
      failedAt = i;
      break;
    }

    // 预期上限要在**动手之前**核对，所以先预演一次
    const cap = readNumber(spec.expect ?? {}, 'maxAffectedPixels');
    let impact: OpImpact | undefined;
    if (cap !== undefined) {
      if (!handler.previewable) {
        results.push({
          index: i,
          op: spec.op,
          ok: false,
          target,
          error: `该操作无法预演影响面，无法核对 maxAffectedPixels 上限（${handler.label}）；已中止，未做任何改动。`,
        });
        failedAt = i;
        break;
      }
      try {
        const preview = await handler.run(editor, params, true);
        impact = toImpact(preview);
        if (impact.affectedPixels > cap) {
          results.push({
            index: i,
            op: spec.op,
            ok: false,
            target,
            impact,
            error:
              `实际影响 ${impact.affectedPixels} 个像元，超出预期上限 ${cap}，已中止；` +
              '前面已完成的条目照常生效，不会回滚。',
          });
          failedAt = i;
          break;
        }
      } catch (err) {
        results.push({ index: i, op: spec.op, ok: false, target, error: messageOf(err) });
        failedAt = i;
        break;
      }
    }

    try {
      const result = await handler.run(editor, params, false);
      results.push({ index: i, op: spec.op, ok: true, target, impact: toImpact(result) });
      completed++;
    } catch (err) {
      results.push({ index: i, op: spec.op, ok: false, target, error: messageOf(err) });
      failedAt = i;
      break;
    }
  }

  return {
    ok: failedAt === undefined,
    results,
    completed,
    ...(failedAt !== undefined ? { failedAt } : {}),
  };
}

/* ── 内部工具 ─────────────────────────────────────────────── */

function toImpact(r: RasterOpResult): OpImpact {
  return {
    affectedPixels: r.affectedPixels,
    totalPixels: r.totalPixels,
    affectedRatio: r.totalPixels > 0 ? r.affectedPixels / r.totalPixels : 0,
    backupPath: r.backupPath,
    verified: r.verified,
    checksumBefore: r.checksumBefore,
    checksumAfter: r.checksumAfter,
    width: r.width,
    height: r.height,
    bandCount: r.bandCount,
    ...(r.dryRun !== undefined ? { dryRun: r.dryRun } : {}),
  };
}

/**
 * 把 `dataset://x.tff` 这类引用剥成工作区相对路径。
 *
 * `layer://` / `summary://` 指的是图层标识，不是文件路径 —— 这里不猜，
 * 直接报错让调用方给一个能落地的路径。
 */
function toRelPath(raw: string): string {
  const m = /^(?:dataset|layer|summary):\/\/(.+)$/.exec(raw);
  if (m) {
    if (!/^dataset:\/\//.test(raw)) {
      throw new Error(`目标引用不是文件路径（${raw}）；请用 dataset://<相对路径> 或直接给相对路径`);
    }
    return m[1]!;
  }
  return raw;
}

/** 目标路径（相对项目根）：绝对路径一律拒绝 */
function requireTarget(params: Readonly<Record<string, unknown>>): string {
  return requireRelPath(params, 'target');
}

function requireRelPath(params: Readonly<Record<string, unknown>>, key: string): string {
  const raw = readString(params, key);
  if (raw === undefined) throw new Error(`缺少参数 ${key}`);
  return toRelPathChecked(raw, key);
}

/** 可选的相对路径参数：不给就没有，给了就得是安全的相对路径 */
function readRelPath(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const raw = readString(params, key);
  if (raw === undefined) return undefined;
  return toRelPathChecked(raw, key);
}

function toRelPathChecked(raw: string, key: string): string {
  const rel = toRelPath(raw);
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) {
    throw new Error(`${key} 必须是相对路径，不能是绝对路径：${raw}`);
  }
  if (rel.split(/[\\/]/).includes('..')) {
    throw new Error(`${key} 不能包含 .. （会逃出工作区根）：${raw}`);
  }
  return rel;
}

/** 目标路径（只用于报告展示）：剥 scheme，不做安全校验 */
function targetOf(spec: OperationSpec): string {
  const raw = spec.params['target'];
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  const m = /^(?:dataset|layer|summary):\/\/(.+)$/.exec(raw);
  return m?.[1] ?? raw;
}

function readString(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function readNumber(params: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function requireColor(params: Readonly<Record<string, unknown>>): string | readonly number[] {
  const v = params['color'];
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (Array.isArray(v) && v.length >= 3) return v.map((x) => Number(x) || 0);
  throw new Error('缺少参数 color（填色用 #RRGGBB，或 [r,g,b]）');
}

/**
 * 区域：两种形状。
 *   - `{ minX, minY, maxX, maxY }` —— 原生像元坐标
 *   - `[minX, minY, maxX, maxY]` —— 地理范围（目标坐标系），由 normalizeParams 换算
 *
 * optional 形态缺参时返回 **undefined**（不是零区域）：
 * 零区域会让下游的「region ?? 其它来源」分支永远走不到，
 * 把「没给范围」变成「改了 0 像元却报成功」。
 */
function requireRegion(params: Readonly<Record<string, unknown>>): PixelRegion;
function requireRegion(
  params: Readonly<Record<string, unknown>>,
  opts: { readonly optional: true },
): PixelRegion | undefined;
function requireRegion(
  params: Readonly<Record<string, unknown>>,
  opts?: { readonly optional?: boolean },
): PixelRegion | undefined {
  const raw = params['region'];
  if (raw === undefined || raw === null) {
    if (opts?.optional) return undefined;
    throw new Error('缺少参数 region（要改动的像元区域）');
  }
  if (Array.isArray(raw)) {
    throw new Error('region 的地理范围形式还没接上，请给像元坐标 { minX, minY, maxX, maxY }');
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const minX = Number(o['minX']);
    const minY = Number(o['minY']);
    const maxX = Number(o['maxX']);
    const maxY = Number(o['maxY']);
    if (![minX, minY, maxX, maxY].every((x) => Number.isFinite(x))) {
      throw new Error('region 必须是 { minX, minY, maxX, maxY } 四个数字');
    }
    // 归一化：用户拖框的方向不该决定结果
    return {
      minX: Math.min(minX, maxX),
      minY: Math.min(minY, maxY),
      maxX: Math.max(minX, maxX),
      maxY: Math.max(minY, maxY),
    };
  }
  throw new Error('region 形状不认识：给 { minX, minY, maxX, maxY }');
}

/** 地理范围形式的 region —— 需要目标栅格的仿射参数才能换算成像元 */
async function normalizeParams(
  deps: ExecutorDeps,
  spec: OperationSpec,
): Promise<Readonly<Record<string, unknown>>> {
  const params: Record<string, unknown> = { ...spec.params };
  const raw = params['region'];
  if (Array.isArray(raw) && raw.length === 4) {
    const nums = raw.map((x) => Number(x));
    if (!nums.every((x) => Number.isFinite(x))) {
      throw new Error('region 的地理范围必须是四个数字：[minX, minY, maxX, maxY]');
    }
    const bounds: GeoBounds = {
      minX: Math.min(nums[0]!, nums[2]!),
      minY: Math.min(nums[1]!, nums[3]!),
      maxX: Math.max(nums[0]!, nums[2]!),
      maxY: Math.max(nums[1]!, nums[3]!),
    };
    const target = requireTarget(params);
    const probe = await probeDataset(deps.loc, deps.store.resolve(target));
    // DatasetInfo 是按 kind 区分的联合类型：只有栅格才有仿射参数
    const gt = probe.dataset?.kind === 'raster' ? probe.dataset.geotransform : null;
    if (!gt) {
      throw new Error('该栅格没有仿射参数，无法把地理范围换算成像元区域');
    }
    params['region'] = geoToPixelRegion(bounds, gt);
  }
  return params;
}

function readBbox(params: Readonly<Record<string, unknown>>): GeoBounds | undefined {
  const raw = params['bbox'];
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const nums = raw.map((x) => Number(x));
  if (!nums.every((x) => Number.isFinite(x))) return undefined;
  return {
    minX: Math.min(nums[0]!, nums[2]!),
    minY: Math.min(nums[1]!, nums[3]!),
    maxX: Math.max(nums[0]!, nums[2]!),
    maxY: Math.max(nums[1]!, nums[3]!),
  };
}

/** 自由形状掩膜（画笔）：base64 的逐像元字节 */
function readMask(params: Readonly<Record<string, unknown>>): PixelMask | undefined {
  const raw = params['mask'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const width = Number(o['width']);
  const height = Number(o['height']);
  const data = o['data'];
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('mask 的 width / height 必须是正整数');
  }
  if (typeof data !== 'string') {
    throw new Error('mask 的 data 必须是 base64 字符串');
  }
  const bytes = new Uint8Array(Buffer.from(data, 'base64'));
  const need = width * height;
  if (bytes.length < need) {
    throw new Error(`mask 的数据长度不对：需要 ${need} 字节（${width}×${height}），实际 ${bytes.length}`);
  }
  return buildPixelMask(width, height, bytes);
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
