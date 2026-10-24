/**
 * AI 提议层：把一句人话变成一份**可校验的操作计划**。
 *
 * 这个模块只做三件事，一件不多：
 *
 *   1. **裁剪上下文** —— 前端交来多少都不算数，只有白名单里的字段会进模型。
 *      裁剪规则写死在本文件（服务端）；界面上的「本次将发送什么」预览就是这段
 *      代码算出来的结果 —— 预览与实际发送走同一段逻辑，不存在"预览说一套、
 *      发出去另一套"。
 *   2. **校验模型产物** —— 闸门①过 `src/engine/ops.schema.json`；闸门②认得出
 *      哪些 op 引擎还没实现（"该操作尚未支持"）。
 *   3. **把结论原样带回去** —— 不合法的就明说不合法，不静默修补、不丢弃条目
 *      假装成功。
 *
 * **这里不执行任何改动。** 落盘永远由确定性引擎在用户确认之后做；
 * 量化影响（闸门③）由 `POST /api/op/preview` 给出，闸门④由用户点"确认执行"。
 *
 * 密钥纪律（与 `llm.ts` 一致）：密钥只在这一次请求里用一次，
 * 任何错误信息都先过 `scrub()` 再往外说，**永不回显**。
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findProvider,
  listImplementedOps,
  MINIMAX_MAX_TOKENS,
  parseChatReply,
  probeDataset,
  redactSecrets,
  resolveGdal,
  type MinimaxFetch,
  type OperationSpec,
  type PlanDocument,
} from '@cartouche/engine';
import { currentProviderId, resolveCredentials, scrub } from './llm.ts';

/* ────────────────────────────────────────────────────────────
 * §1 上下文裁剪：白名单
 *
 * 依据 docs/01 §4.4「最小必要披露」：
 *   允许发送 —— 图层名 / 字段名 / 字段类型 / 要素数量 / 视窗内要素（几何简化 +
 *                关键属性）/ 坐标系标识 / 用户提示词；
 *   禁止发送 —— 整个数据文件 / 全量要素 / 与任务无关的图层与字段 /
 *                文件系统路径 / 用户名 / 机器信息。
 *
 * 下面每一个字段都是**逐个挑出来**的，没有"把整个对象丢过去"这种写法 ——
 * 那样一来上游多带一个字段就会跟着漏出去。
 * ──────────────────────────────────────────────────────────── */

/** 名字类文本的长度上限（超出截断，避免超长串把 token 预算吃光） */
const MAX_NAME = 120;
/** 字段名长度上限 */
const MAX_FIELD_NAME = 64;
/** 字段类型长度上限 */
const MAX_FIELD_TYPE = 32;
/** 单个要素最多带几个关键属性 */
const MAX_PROPERTY_COUNT = 8;
/** 属性值（字符串）长度上限 */
const MAX_PROPERTY_TEXT = 120;
/** 最多带多少个要素（视窗内的也只带这么多，绝不发全量） */
const MAX_FEATURE_COUNT = 200;
/** 几何最多带多少个坐标数字（简化后的几何本就很小） */
const MAX_COORDINATE_COUNT = 512;
/** 坐标系标识（WKT）的长度上限 */
const MAX_CRS_TEXT = 120;

export interface PlanFieldContext {
  readonly name: string;
  readonly type: string;
}

export interface PlanLayerContext {
  readonly id: string;
  readonly kind: 'raster' | 'vector';
  /** 项目内相对路径（不含盘符、不含 `..`） */
  readonly path: string;
  readonly visible: boolean;
  readonly opacity: number;
  readonly fields: readonly PlanFieldContext[];
  readonly featureCount: number | null;
  /** 坐标系标识（EPSG 代码或截断后的 WKT） */
  readonly crs: string | null;
}

export interface PlanFeatureContext {
  readonly layerId: string;
  /** 简化后的几何；形状不认识时给 null（宁可没有，也不要发一堆原始坐标） */
  readonly geometry: { readonly type: string; readonly coordinates: unknown } | null;
  /** 关键属性（原始类型，字符串截断） */
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
}

export interface PlanContext {
  readonly projectName: string;
  readonly layers: readonly PlanLayerContext[];
  readonly features: readonly PlanFeatureContext[];
  /** 视窗范围 [minX, minY, maxX, maxY]；没有就为 null */
  readonly viewport: readonly number[] | null;
}

/**
 * 把任意来源的原始上下文裁剪成**只有白名单字段**的上下文。
 *
 * 刻意写成"逐字段挑选"而不是"删掉几个敏感字段"：删字段的实现，
 * 上游一旦新增字段就会自动漏出去；挑选字段的实现，新增字段默认**不进**上下文。
 */
export function buildPlanContext(raw: unknown): PlanContext {
  const o = isPlainObject(raw) ? raw : {};
  return {
    projectName: clipText(text(o['projectName']), MAX_NAME),
    layers: buildLayers(o['layers']),
    features: buildFeatures(o['features']),
    viewport: buildViewport(o['viewport']),
  };
}

function buildLayers(raw: unknown): PlanLayerContext[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanLayerContext[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const id = clipText(text(item['id']), MAX_NAME);
    if (!id) continue;
    const path = safeRelativePath(text(item['path']));
    // 路径不安全的图层直接不进上下文：绝对路径是"文件系统路径"，
    // 按 docs/01 §4.4 属于禁止发送项。与其发出去再指望模型不看，不如不发。
    if (!path) continue;
    out.push({
      id,
      kind: item['kind'] === 'vector' ? 'vector' : 'raster',
      path,
      visible: item['visible'] === false ? false : true,
      opacity: clamp01(number(item['opacity'], 1)),
      fields: buildFields(item['fields']),
      featureCount: countOrNull(item['featureCount']),
      crs: crsLabel(item['crs']),
    });
  }
  return out;
}

function buildFields(raw: unknown): PlanFieldContext[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanFieldContext[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const name = clipText(text(item['name']), MAX_FIELD_NAME);
    if (!name) continue;
    out.push({ name, type: clipText(text(item['type']), MAX_FIELD_TYPE) });
    if (out.length >= 64) break;
  }
  return out;
}

function buildFeatures(raw: unknown): PlanFeatureContext[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanFeatureContext[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const layerId = clipText(text(item['layerId']), MAX_NAME);
    if (!layerId) continue;
    out.push({
      layerId,
      geometry: buildGeometry(item['geometry']),
      properties: buildProperties(item['properties']),
    });
    if (out.length >= MAX_FEATURE_COUNT) break;
  }
  return out;
}

/** 几何：只认「类型 + 一串数字」，别的形状一律丢掉 */
function buildGeometry(raw: unknown): { readonly type: string; readonly coordinates: unknown } | null {
  if (!isPlainObject(raw)) return null;
  const type = clipText(text(raw['type']), MAX_FIELD_TYPE);
  if (!type) return null;
  const coords = raw['coordinates'];
  if (!Array.isArray(coords)) return null;
  if (!allNumbers(coords, { left: MAX_COORDINATE_COUNT })) return null;
  return { type, coordinates: coords };
}

/** 关键属性：只保留原始类型的值，数量与长度都封顶 */
function buildProperties(raw: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!isPlainObject(raw)) return out;
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= MAX_PROPERTY_COUNT) break;
    const name = clipText(key, MAX_FIELD_NAME);
    if (!name) continue;
    if (value === null) {
      out[name] = null;
    } else if (typeof value === 'string') {
      out[name] = clipText(value, MAX_PROPERTY_TEXT);
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      out[name] = value;
    } else if (typeof value === 'boolean') {
      out[name] = value;
    } else {
      // 对象 / 数组：不在白名单里，丢掉（几何、嵌套结构都不该走属性这条路）
      continue;
    }
    count++;
  }
  return out;
}

function buildViewport(raw: unknown): readonly number[] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const nums = raw.map((v) => Number(v));
  if (!nums.every((n) => Number.isFinite(n))) return null;
  return nums;
}

/**
 * 项目内相对路径：绝对路径、盘符路径、含 `..` 的一律判为不安全。
 * 返回 null 表示"这个路径不能进上下文"。
 */
function safeRelativePath(raw: string): string | null {
  const p = raw.trim().replace(/\\/g, '/');
  if (!p) return null;
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(p) || p.startsWith('/')) return null;
  if (p.split('/').some((seg) => seg === '..')) return null;
  return clipText(p, MAX_NAME);
}

/** 坐标系标识：优先 EPSG 代码；只有 WKT 时截断保留 */
function crsLabel(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return `EPSG:${Math.round(raw)}`;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    if (/^EPSG:\d+$/i.test(s)) return s.toUpperCase();
    return clipText(s, MAX_CRS_TEXT);
  }
  if (isPlainObject(raw)) {
    const epsg = raw['epsg'];
    if (typeof epsg === 'number' && Number.isFinite(epsg)) return `EPSG:${Math.round(epsg)}`;
    const authority = text(raw['authority']);
    if (/^EPSG:\d+$/i.test(authority)) return authority.toUpperCase();
    const wkt = text(raw['wkt']);
    if (wkt) return clipText(wkt, MAX_CRS_TEXT);
  }
  return null;
}

/* ────────────────────────────────────────────────────────────
 * §2 操作计划 Schema（闸门①）
 * ──────────────────────────────────────────────────────────── */

/** JSON Schema 节点的宽松形状（本仓库用到的那些关键字） */
export interface SchemaNode {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly additionalProperties?: boolean | SchemaNode;
  readonly items?: SchemaNode;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly $ref?: string;
  readonly allOf?: readonly SchemaNode[];
  readonly if?: SchemaNode;
  readonly then?: SchemaNode;
  readonly else?: SchemaNode;
  readonly $defs?: Readonly<Record<string, SchemaNode>>;
  readonly description?: string;
  readonly default?: unknown;
}

const here = dirname(fileURLToPath(import.meta.url));
/** dist/llm-plan.js → 仓库根目录 */
const repoRoot = join(here, '..', '..');

let schemaCache: SchemaNode | null = null;

/** 读操作计划契约（ops.schema.json） */
export function readOpsSchema(): SchemaNode {
  if (schemaCache) return schemaCache;
  const p = join(repoRoot, 'src', 'engine', 'ops.schema.json');
  schemaCache = JSON.parse(readFileSync(p, 'utf8')) as SchemaNode;
  return schemaCache;
}

/** 一条不合法的操作 */
export interface PlanSchemaIssue {
  /** 第几条操作（从 0 起）；null = 计划级问题 */
  readonly opIndex: number | null;
  /** op 名（认得出来才有） */
  readonly op: string | null;
  readonly message: string;
}

/**
 * 闸门①：模型产物必须过 `ops.schema.json`。
 *
 * **不合法的照实说，不静默修补**：多一个字段、少一个必填参数、op 名写错，
 * 都要指出来是**哪一条**出的问题。
 */
export function validatePlanSchema(plan: unknown, schema: SchemaNode): PlanSchemaIssue[] {
  const issues: PlanSchemaIssue[] = [];
  if (!isPlainObject(plan)) {
    issues.push({ opIndex: null, op: null, message: '模型返回的计划不是一个对象' });
    return issues;
  }
  if (plan['version'] !== '1.0') {
    issues.push({
      opIndex: null,
      op: null,
      message: `计划缺少或写错了 version（应为 "1.0"，实际是 ${JSON.stringify(plan['version'] ?? null)}）`,
    });
  }
  const ops = plan['ops'];
  if (!Array.isArray(ops)) {
    issues.push({ opIndex: null, op: null, message: '计划里缺少 ops 数组' });
    return issues;
  }
  if (ops.length < 1) {
    issues.push({ opIndex: null, op: null, message: '计划里一条操作都没有' });
  }
  if (ops.length > 50) {
    issues.push({ opIndex: null, op: null, message: `计划里的操作条数超过上限（50 条，实际 ${ops.length} 条）` });
  }
  const opSchema = schema.$defs?.['operation'];
  if (!opSchema) {
    issues.push({ opIndex: null, op: null, message: '契约里缺少 $defs.operation，无法校验' });
    return issues;
  }
  ops.forEach((op, index) => {
    const opName = isPlainObject(op) && typeof op['op'] === 'string' ? op['op'] : null;
    const errors = validateNode(op, opSchema, schema, `ops[${index}]`);
    for (const e of errors) {
      issues.push({
        opIndex: index,
        op: opName,
        message: opName
          ? `第 ${index + 1} 条操作（${opName}）：${humanizeSchemaError(e)}`
          : `第 ${index + 1} 条操作：${humanizeSchemaError(e)}`,
      });
    }
  });
  return issues;
}

/** 把校验器的路径式错误改成人话 */
function humanizeSchemaError(raw: string): string {
  return raw
    .replace(/^ops\[\d+\]\.?/, '')
    .replace(/\bparams\b/g, '参数')
    .replace(/\bop\b/g, '操作名')
    .replace(/:\s*/g, ' ')
    .trim();
}

/** 校验一个值，返回错误列表（空 = 合法） */
export function validateNode(value: unknown, schema: SchemaNode, root: SchemaNode, path: string): string[] {
  const errors: string[] = [];

  if (schema.$ref) {
    const target = resolveRef(schema.$ref, root);
    if (!target) {
      errors.push(`${path}: 契约引用无法解析（${schema.$ref}）`);
      return errors;
    }
    return validateNode(value, target, root, path);
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${path}: 必须是 ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${path}: 只能是 ${schema.enum.map((e) => JSON.stringify(e)).join(' / ')}`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${path}: 类型应为 ${types.join('|')}，实际是 ${describeType(value)}`);
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: 长度不能小于 ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: 长度不能大于 ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: 格式不符合要求（${schema.pattern}）`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: 不能小于 ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: 不能大于 ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(`${path}: 必须大于 ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      errors.push(`${path}: 必须小于 ${schema.exclusiveMaximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: 至少要 ${schema.minItems} 项`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: 最多 ${schema.maxItems} 项`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validateNode(item, schema.items as SchemaNode, root, `${path}[${i}]`));
      });
    }
  }

  if (isPlainObject(value)) {
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${path}: 缺少必填字段 ${req}`);
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(value)) {
      const propSchema = props[key];
      if (propSchema) {
        errors.push(...validateNode(sub, propSchema, root, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: 不认识的字段 ${key}`);
      } else if (isPlainObject(schema.additionalProperties)) {
        errors.push(...validateNode(sub, schema.additionalProperties as SchemaNode, root, `${path}.${key}`));
      }
    }
  }

  for (const sub of schema.allOf ?? []) {
    if (sub.if) {
      const matched = validateNode(value, sub.if, root, path).length === 0;
      if (matched && sub.then) errors.push(...validateNode(value, sub.then, root, path));
      else if (!matched && sub.else) errors.push(...validateNode(value, sub.else, root, path));
    } else {
      errors.push(...validateNode(value, sub, root, path));
    }
  }

  return errors;
}

function resolveRef(ref: string, root: SchemaNode): SchemaNode | null {
  if (!ref.startsWith('#/')) return null;
  let cur: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    if (!isPlainObject(cur)) return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return isPlainObject(cur) ? (cur as SchemaNode) : null;
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/* ────────────────────────────────────────────────────────────
 * §3 引擎还没实现的 op（闸门②的前半）
 * ──────────────────────────────────────────────────────────── */

export interface UnsupportedOp {
  readonly opIndex: number;
  readonly op: string;
  readonly message: string;
}

/**
 * 找出引擎还没实现的 op。
 *
 * 「尚未支持」是**结论**，不是错误：用户要的是"删掉这个要素"，
 * 而引擎现在还做不到矢量编辑 —— 这时候该说的是"该操作尚未支持"，
 * 绝不把没做的事说成做成了（静默失败 = 0 是这个项目的硬指标）。
 *
 * `implemented` 可注入，测试用它固定输入，生产用引擎自己的注册表。
 */
export function findUnsupportedOps(plan: unknown, implemented: readonly string[]): UnsupportedOp[] {
  const out: UnsupportedOp[] = [];
  if (!isPlainObject(plan)) return out;
  const ops = plan['ops'];
  if (!Array.isArray(ops)) return out;
  ops.forEach((op, index) => {
    if (!isPlainObject(op)) return;
    const name = op['op'];
    if (typeof name !== 'string' || name.trim() === '') return;
    if (implemented.includes(name)) return;
    out.push({
      opIndex: index,
      op: name,
      message: `该操作尚未支持：${name}`,
    });
  });
  return out;
}

/** 引擎已实现的 op（生产用；测试可注入固定清单） */
export function implementedOps(): readonly string[] {
  return listImplementedOps();
}

/* ────────────────────────────────────────────────────────────
 * §2b 一份计划能不能进执行（/api/llm/plan 与 /api/op/execute 共用）
 * ──────────────────────────────────────────────────────────── */

/** 契约里是「工作区相对路径」的参数（pathRef） */
const PATH_PARAM_KEYS = ['target', 'source', 'clip', 'output'] as const;

/**
 * 把计划里的路径参数统一成**契约形状**（dataset://<相对路径>）。
 *
 * 契约里的 pathRef 只认 `dataset://` 这一种；裸相对路径「引擎能跑，但不符合契约」。
 * `/api/op/execute` 收到的是裸相对路径（画布就是这么发的），
 * 所以先统一形状，再交给**同一份**校验器 ——
 * 两套校验器各说各话，测出来的「绿」是假的。
 *
 * 只动**引擎已实现**的 op：其余 op 的 target 是图层引用（layer://），
 * 不是文件路径，不能这么改写。
 */
export function canonicalizePlanPaths(plan: PlanDocument): PlanDocument {
  const implemented = new Set(implementedOps());
  return {
    ...plan,
    ops: plan.ops.map((op) =>
      implemented.has(op.op) ? { ...op, params: canonicalizeParams(op.params) } : op,
    ),
  };
}

/**
 * 把契约里声明的 `default` 补进计划。
 *
 * 校验器实现的是 required / allOf / type / enum 这些**约束**，
 * 不实现 JSON Schema 的 `default`（那是"缺省时该取什么值"的注解）。
 * 于是契约写着 `requireUserConfirm: { default: true }`、引擎却按
 * "没写就不拦"执行 —— **契约与行为不同向**，而这条恰好是破坏性操作的安全网。
 * 同一个毛病也让「声明了 default 又列进 required」的字段自相矛盾
 * （缺了就该报错，可它明明有缺省值）。
 *
 * 补上之后：契约声明了 default 的属性，缺省就按 default 走；
 * 引擎那边「写了 true 才拦」才真正等于契约说的「默认 true」。
 *
 * 注入的值与引擎自己的缺省**逐个核对过**
 * （brightness 0 / contrast 1 / method linear-stretch / gamma 2.2 /
 *  radiusPx 4 / featherPx 0），所以对已实现的 8 个栅格 op 是**行为不变**的；
 * 对尚未实现的 op 只是让计划自描述，不产生副作用。
 */
export function applySchemaDefaults(plan: PlanDocument): PlanDocument {
  const defs = readOpsSchema().$defs ?? {};
  const opProps = defs['operation']?.properties ?? {};
  return {
    ...plan,
    ops: plan.ops.map((op) => {
      let changed = false;

      /* ① operation 级：requireUserConfirm 就声明在这一层（与 op / params 平级） */
      const spec: Record<string, unknown> = { ...op };
      for (const [key, prop] of Object.entries(opProps)) {
        if (spec[key] !== undefined) continue;
        if (prop.default === undefined) continue;
        spec[key] = prop.default;
        changed = true;
      }

      /* ② params 级：brightness / contrast / method / gamma … */
      const paramsSchema = defs[`params.${op.op}`];
      const params: Record<string, unknown> = { ...op.params };
      if (paramsSchema?.properties) {
        for (const [key, prop] of Object.entries(paramsSchema.properties)) {
          if (params[key] !== undefined) continue;
          if (prop.default === undefined) continue;
          params[key] = prop.default;
          changed = true;
        }
      }

      if (!changed) return op;
      return { ...(spec as unknown as OperationSpec), params };
    }),
  };
}

function canonicalizeParams(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  for (const key of PATH_PARAM_KEYS) {
    const v = out[key];
    if (typeof v === 'string') out[key] = toPathRef(v);
  }
  const inputs = out['inputs'];
  if (Array.isArray(inputs)) {
    out['inputs'] = inputs.map((x) => (typeof x === 'string' ? toPathRef(x) : x));
  }
  return out;
}

/**
 * 裸相对路径 → dataset:// 形状。
 *
 * 绝对路径与含 `..` 的路径**原样保留**：它们本来就非法，
 * 改写成"看起来合法"的样子只会把问题藏起来 —— 该由校验器/路径闸门报错。
 */
function toPathRef(raw: string): string {
  const v = raw.trim();
  if (v === '') return v;
  if (/^(?:dataset|layer|summary):\/\//.test(v)) return v;
  if (isAbsolute(v) || /^[A-Za-z]:/.test(v) || v.startsWith('/') || v.startsWith('\\')) return v;
  if (v.split(/[\\/]/).includes('..')) return v;
  return `dataset://${v.replace(/\\/g, '/')}`;
}

export interface PlanGateResult {
  /** true = 可以进执行 */
  readonly ok: boolean;
  /** 不能进执行时的原因（人话） */
  readonly message: string | null;
  /** 统一成契约形状之后的计划（ok 时它就是被执行的那一份） */
  readonly plan: PlanDocument;
  readonly schemaIssues: readonly PlanSchemaIssue[];
  readonly unsupported: readonly UnsupportedOp[];
}

/**
 * 闸门①：一份计划能不能进入执行。
 *
 * `/api/llm/plan`（模型产物）与 `/api/op/execute`（直接提交的计划）
 * 走的是**同一个函数** —— 计划从哪来不影响它合不合契约。
 */
export function checkPlanAgainstContract(plan: PlanDocument): PlanGateResult {
  // 顺序：先统一路径形状，再补契约声明的缺省值，最后校验。
  const canonical = applySchemaDefaults(canonicalizePlanPaths(plan));
  // 单条快捷写法没有 version；契约要求 version = "1.0"，这里按 1.0 校。
  const versioned: PlanDocument = {
    ...canonical,
    version: canonical.version ?? '1.0',
  };
  const schemaIssues = validatePlanSchema(versioned, readOpsSchema());
  if (schemaIssues.length > 0) {
    return {
      ok: false,
      message: `计划不符合操作契约：${schemaIssues[0]?.message ?? ''}`,
      plan: versioned,
      schemaIssues,
      unsupported: [],
    };
  }
  const unsupported = findUnsupportedOps(versioned, implementedOps());
  if (unsupported.length > 0) {
    return {
      ok: false,
      message: unsupported[0]?.message ?? '该操作尚未支持',
      plan: versioned,
      schemaIssues,
      unsupported,
    };
  }
  return { ok: true, message: null, plan: versioned, schemaIssues, unsupported };
}

/* ────────────────────────────────────────────────────────────
 * §4 可提议的 op 目录与提示词
 * ──────────────────────────────────────────────────────────── */

export interface OpCatalogEntry {
  readonly op: string;
  readonly label: string;
  /** 该 op 的参数契约（直接取自 ops.schema.json） */
  readonly params: SchemaNode;
}

/** op 的中文名（与引擎调度器里的说法保持一致） */
const OP_LABELS: Readonly<Record<string, string>> = {
  'raster.paint': '涂色',
  'raster.erase': '擦除',
  'raster.replaceRegion': '区域替换',
  'raster.inpaint': '边界修补',
  'raster.adjustLevels': '亮度对比度调整',
  'raster.clip': '裁切',
  'raster.resample': '重采样',
  'raster.mosaic': '拼接',
  'vector.query': '属性查询',
  'vector.addField': '计算字段',
  'vector.spatialJoin': '空间连接',
  'vector.reproject': '重投影',
  'vector.renameFields': '重命名字段',
  'vector.recode': '重编码',
};

/**
 * 放行给 AI 提议的 op 前缀。
 *
 * 为什么按前缀过滤而不是写死一份名单：引擎注册表是唯一的真相，
 * 写死的名单必然会漏 —— 2026-10-24 实测踩的就是这个坑：
 * `vector.*` 的六个 op 早就实现并登记进执行器了，提示词却只放行 `raster.*`，
 * 模型**根本看不到**它们，于是所有矢量需求都落到「该操作尚未支持」。
 * 这种缺口不报错，只是功能凭空少了一半 —— 比报错更难发现。
 */
const AI_OP_PREFIXES: readonly string[] = ['raster.', 'vector.'];

/**
 * 逐个放行的 op（不属于任何前缀的）。
 *
 * 为什么要有这么一小撮：`feature.*` 里混着**会删数据**的操作
 * （feature.delete），让模型从一句模糊的话里推出删除动作，风险和收益不成比例。
 * 但 `feature.summarize`（按字段分组汇总）是**纯读操作** ——
 * 它只出一张表，一个字节都不写。放行它，用户问「按类别汇总面积」时 AI 能直接答。
 * 删与改留到 SP-2/4 那一轮，和符号化面板一起做，那时闸门能做得更细。
 */
const AI_OP_ALLOW: readonly string[] = ['feature.summarize'];

/**
 * 故意**不**放行给 AI 的已实现 op，连同原因。
 *
 * 为什么要有这份名单：清单是**硬编码**的，而引擎注册表是活的 ——
 * 2026-10-24 实测踩过这个坑：`vector.*` 的六个 op 早就登记进执行器了，
 * 提示词却只放行 `raster.*`，模型**根本看不到**它们，
 * 于是所有矢量需求都落到「该操作尚未支持」。那种缺口不报错，只是功能凭空少了一半。
 *
 * 这份名单加上「每个已实现的 op 必须在清单里或在这份名单里」那条测试，
 * 就是那道防线：以后再登记 op，要么进清单，要么在这里点名，
 * 不会再有人「实现了但用户看不到」。
 *
 * 名单里只放**真的已实现**的 op —— 没实现的写进来会让那条测试误以为它有归属。
 */
export const AI_OP_DENY: Readonly<Record<string, string>> = {
  'dataset.open': '只是打开数据集，不改东西；AI 的场景是「一句话改图」，打开与查看交给画布和属性表',
  'dataset.healthCheck': '同上：体检与快照属于「查看」，不属于「改」',
  'dataset.snapshot': '同上',
  'export.image': '导出是出片环节，与「一句话改图」是两件事；先把改图那一段做扎实',
  'export.report': '同上',
  'feature.setAttributes': '批量改属性会写数据，与 feature.delete 同类；按执行顺序排在 SP-2/4 那一轮',
  'feature.delete': '会删数据：让模型从一句模糊的话里推出删除动作，风险和收益不成比例',
};

export function opCatalog(schema: SchemaNode, implemented: readonly string[]): OpCatalogEntry[] {
  const allowed = schema.$defs?.['operation']?.properties?.['op']?.enum ?? [];
  const out: OpCatalogEntry[] = [];
  for (const op of implemented) {
    const allowedByPrefix = AI_OP_PREFIXES.some((prefix) => op.startsWith(prefix));
    if (!allowedByPrefix && !AI_OP_ALLOW.includes(op)) continue;
    if (!allowed.includes(op)) continue;
    const params = schema.$defs?.[`params.${op}`];
    if (!params) continue;
    out.push({ op, label: OP_LABELS[op] ?? op, params });
  }
  return out.sort((a, b) => a.op.localeCompare(b.op));
}

/**
 * 拼出发给模型的那段提示词。
 *
 * 这段文本**就是**要发送的内容 —— 界面上的「本次将发送什么」预览直接展示它，
 * 不另写一份"预览版"，免得两边说的不是一回事。
 */
export function buildPlanPrompt(input: {
  readonly context: PlanContext;
  readonly instruction: string;
  readonly catalog: readonly OpCatalogEntry[];
}): string {
  const catalog = input.catalog.map((entry) => ({
    op: entry.op,
    label: entry.label,
    params: entry.params,
  }));
  return [
    '你是一个制图操作提议器：把用户的要求翻译成一份**操作计划**（JSON）。',
    '',
    '【铁律】',
    '1. 只输出一个 JSON 对象，不要解释文字，不要 Markdown 代码块。',
    '2. 只能从下面的「可用操作清单」里选 op。清单里没有的操作不要硬凑：',
    '   把 ops 写成空数组，并在 intent 里写明「该操作尚未支持」。',
    '   用户的要求里缺少必要信息时也一样（没说清是哪一列、哪个图层、哪个文件）：',
    '   把 ops 写成空数组，并在 intent 里写明缺什么 —— 不要猜。',
    '3. 计划格式固定为：{"version":"1.0","intent":"一句话说明要做什么","ops":[{"op":"...","params":{...}}]}',
    '4. params 必须严格符合该 op 的参数契约：字段名照抄契约，多余字段一律不给，',
    '   必填字段不能少。',
    '5. 路径类参数（target / source / clip / output / mosaic 的 inputs）只能写成',
    '   "dataset://<工作区相对路径>"（如 "dataset://底图/current.tff"）。',
    '   引擎只认这一种：图层标识 "layer://<图层 id>" 不是文件路径，引擎会直接拒掉，',
    '   写它等于把一条跑不动的计划交上来。',
    '   裸路径（"底图/current.tff"）不符合契约，会被第一道闸门直接拒掉。',
    '   不要写盘符路径、绝对路径或任何本机信息。',
    '6. region（要改动的区域）**不是**引用，只能是下面两种形状之一：',
    '   ① 像元坐标对象 {"minX":4,"minY":3,"maxX":10,"maxY":8}：左上角为原点，maxX/maxY 不含；',
    '   ② 地理范围数组 [minX,minY,maxX,maxY]：与目标图层同一坐标系的地理范围。',
    '   你拿不到像元坐标就用 ②（画布框选给出的才是 ①）。',
    '   绝对不要写 "layer://…" 或 "dataset://…"：引擎无法把图层引用解析成区域。',
    '7. 没有把握的参数宁可不给，也不要编：引擎会逐条校验，编错的值比缺的值更糟。',
    '8. ops 最多 50 条，通常 1~3 条就够。',
    '',
    '【可用操作清单】',
    JSON.stringify(catalog, null, 2),
    '',
    '【本次可见的项目上下文】（已裁剪到最小必要范围）',
    JSON.stringify(input.context, null, 2),
    '',
    '【用户的要求】',
    input.instruction.trim() || '（用户没有写具体要求，请从上下文里挑一件最该做的事）',
    '',
    '【输出】',
    '只输出 JSON。',
  ].join('\n');
}

/* ────────────────────────────────────────────────────────────
 * §5 调模型与解析
 * ──────────────────────────────────────────────────────────── */

export type PlanErrorKind =
  | 'llm_not_configured'
  | 'llm_unreachable'
  | 'llm_unauthorized'
  | 'llm_http'
  | 'bad_request';

/** 提议层的错误：带类别与官方错误码，界面据此区分"连不上"与"密钥不对" */
export class PlanRequestError extends Error {
  readonly kind: PlanErrorKind;
  /** 官方返回的错误码（如 1004 = authorized_error） */
  readonly providerCode: number | null;
  readonly status: number;

  constructor(kind: PlanErrorKind, message: string, providerCode: number | null = null, status = 0) {
    super(message);
    this.name = 'PlanRequestError';
    this.kind = kind;
    this.providerCode = providerCode;
    this.status = status;
  }
}

export interface ChatJsonOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly effort?: string | undefined;
  readonly prompt: string;
  readonly maxTokens?: number | undefined;
  /** 注入的 fetch（测试用） */
  readonly fetchImpl?: MinimaxFetch | undefined;
}

export interface ChatJsonResult {
  readonly reply: string;
  readonly model: string;
  readonly elapsedMs: number;
}

/**
 * 发一次对话请求（比 `chatOnce` 大的 token 上限：一份计划不止一句话）。
 *
 * 错误分类是硬需求：界面必须能分清「连不上 MiniMax」与「密钥不对」——
 * 这两件事的处理方式完全不同（前者查网络，后者换密钥）。
 */
export async function chatJson(options: ChatJsonOptions): Promise<ChatJsonResult> {
  const doFetch = options.fetchImpl ?? defaultFetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const payload: Record<string, unknown> = {
    model: options.model,
    messages: [{ role: 'user', content: options.prompt }],
    max_tokens: options.maxTokens ?? MINIMAX_MAX_TOKENS,
  };
  if (options.effort) payload['reasoning_effort'] = options.effort;

  const started = Date.now();
  let res: { ok: boolean; status: number; text(): Promise<string> };
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new PlanRequestError(
      'llm_unreachable',
      scrub(`连不上模型服务 ${options.baseUrl}：${(err as Error).message}`),
    );
  }
  const elapsedMs = Date.now() - started;
  const text = await res.text();
  if (!res.ok) {
    const code = extractErrorCode(text);
    const detail = extractErrorMessageSafe(text);
    const message = detail
      ? `模型服务返回 ${res.status}：${detail}${code === null ? '' : `（code ${code}）`}`
      : `模型服务返回 ${res.status}${code === null ? '' : `（code ${code}）`}`;
    const kind: PlanErrorKind =
      res.status === 401 || res.status === 403 || code === 1004 ? 'llm_unauthorized' : 'llm_http';
    throw new PlanRequestError(kind, scrub(message), code, res.status);
  }
  const parsed = parseChatReply(text);
  if (!parsed.reply) {
    throw new PlanRequestError('llm_http', '模型服务返回了响应，但没能读出回话内容', null, res.status);
  }
  return { reply: parsed.reply, model: parsed.model || options.model, elapsedMs };
}

const defaultFetch: MinimaxFetch = async (url, init) => {
  const res = await fetch(url, init as unknown as RequestInit);
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

/** 官方错误体里的错误码：OpenAI 兼容形态是 error.code，原生形态是 base_resp.status_code */
export function extractErrorCode(raw: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const err = parsed['error'];
  if (isPlainObject(err) && typeof err['code'] === 'number') return err['code'];
  const baseResp = parsed['base_resp'];
  if (isPlainObject(baseResp) && typeof baseResp['status_code'] === 'number') {
    return baseResp['status_code'];
  }
  return null;
}

function extractErrorMessageSafe(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const err = parsed['error'];
  if (isPlainObject(err) && typeof err['message'] === 'string' && err['message'].trim()) {
    return err['message'].trim();
  }
  const baseResp = parsed['base_resp'];
  if (isPlainObject(baseResp) && typeof baseResp['status_msg'] === 'string' && baseResp['status_msg'].trim()) {
    return baseResp['status_msg'].trim();
  }
  return null;
}

/** 从模型的回话里抠出 JSON */
export function parsePlanReply(reply: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const cleaned = reply
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  if (!cleaned) return { ok: false, message: '模型没有返回任何内容' };
  try {
    return { ok: true, value: JSON.parse(cleaned) as unknown };
  } catch {
    /* 继续尝试：模型常在 JSON 前后加说明文字 */
  }
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return { ok: true, value: JSON.parse(cleaned.slice(first, last + 1)) as unknown };
    } catch {
      /* 确实不是 JSON */
    }
  }
  return { ok: false, message: '模型返回的内容不是可解析的 JSON 操作计划' };
}

/**
 * 提示词铁律②约定的「做不了」说法。
 *
 * 匹配的是**协议里写死的那个短语**（提示词让模型照着写），
 * 不是在猜模型的意思 —— 模型换了说法就会漏判，那时退回「请你补充一句」，
 * 不会把它误报成「引擎做不了」。
 */
const UNSUPPORTED_HINT = /尚未支持|不支持|没有实现|无法支持/;

/**
 * 计划里 ops 为空、intent 有话 —— 模型在**回话**，不是在给计划。
 *
 * 返回那句 intent（模型自己的话）；不是这种形状就返回 null。
 */
export function readEmptyPlanIntent(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  const ops = value['ops'];
  if (!Array.isArray(ops) || ops.length !== 0) return null;
  const intent = value['intent'];
  if (typeof intent !== 'string') return null;
  const trimmed = intent.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* ────────────────────────────────────────────────────────────
 * §6 编排
 * ──────────────────────────────────────────────────────────── */

/** 引擎前置校验的结论（由 app.ts 注入引擎能力后回传） */
export interface PrecheckOutcome {
  readonly ok: boolean;
  readonly error: string | null;
  readonly unimplemented: boolean;
}

export type PrecheckFn = (spec: OperationSpec) => Promise<PrecheckOutcome>;

export type PrecheckStatus = 'pass' | 'fail' | 'unimplemented' | 'unpreviewable';

export interface PrecheckEntry {
  readonly opIndex: number;
  readonly op: string;
  readonly status: PrecheckStatus;
  readonly message: string | null;
}

/** 「本次将发送什么」的预览 */
export interface ContextPreview {
  readonly context: PlanContext;
  /** 真正发出去的那段文本 */
  readonly prompt: string;
  readonly bytes: number;
  readonly model: string | null;
  readonly effort: string | null;
}

export interface PlanResponseBody {
  readonly ok: boolean;
  readonly error: string | null;
  /** 官方错误码（如 1004） */
  readonly code: number | null;
  readonly message: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly elapsedMs: number | null;
  readonly plan: PlanDocument | null;
  /** 闸门①：Schema 校验的问题 */
  readonly schemaIssues: readonly PlanSchemaIssue[];
  /** 闸门②：引擎尚未实现的 op */
  readonly unsupported: readonly UnsupportedOp[];
  /** 闸门②：引擎前置校验的逐条结论 */
  readonly precheck: readonly PrecheckEntry[];
  /** 本次将发送的内容（裁剪后的上下文 + 提示词） */
  readonly context: ContextPreview | null;
}

export interface PlanRequestInput {
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  /** 用哪条接入线（厂商 × 端点）；不给就用当前选中的那条 */
  readonly providerId?: string | undefined;
  /** 前端交来的原始上下文（会被裁剪到白名单） */
  readonly context?: unknown;
  /** 项目根（绝对路径）；给了才能补齐字段名、要素数量、坐标系 */
  readonly root?: string | null;
  /** 引擎前置校验（由 app.ts 注入） */
  readonly precheck?: PrecheckFn | undefined;
  /** 注入的 fetch（测试用） */
  readonly fetchImpl?: MinimaxFetch | undefined;
}

/** 把引擎前置校验的结论归类 */
export function classifyPrecheck(outcome: PrecheckOutcome): PrecheckStatus {
  if (outcome.unimplemented) return 'unimplemented';
  if (outcome.ok) return 'pass';
  const message = outcome.error ?? '';
  // 引擎对"预演不了影响面"的 op 也会给 ok:false，但那是**能力边界**不是校验失败
  if (message.startsWith('该操作无法预演影响面')) return 'unpreviewable';
  return 'fail';
}

/**
 * 提议一份操作计划。
 *
 * 顺序是硬约束：
 *   裁剪上下文 → 拼提示词 → 调模型 → 闸门① Schema 校验 → 闸门② 未实现 op →
 *   闸门② 引擎前置校验 → 原样返回。
 *
 * 任何一步没过就**带着原因返回**，不往下走，也不假装成功。
 */
export async function createPlan(input: PlanRequestInput): Promise<PlanResponseBody> {
  const schema = readOpsSchema();
  const catalog = opCatalog(schema, implementedOps());
  const context = await enrichContext(buildPlanContext(input.context), input.root ?? null);
  const promptText = buildPlanPrompt({
    context,
    instruction: input.prompt,
    catalog,
  });
  const preview: ContextPreview = {
    context,
    prompt: promptText,
    bytes: Buffer.byteLength(promptText, 'utf8'),
    model: input.model ?? null,
    effort: input.effort ?? null,
  };

  const base: PlanResponseBody = {
    ok: false,
    error: null,
    code: null,
    message: null,
    model: input.model ?? null,
    effort: input.effort ?? null,
    elapsedMs: null,
    plan: null,
    schemaIssues: [],
    unsupported: [],
    precheck: [],
    context: preview,
  };

  const providerId = input.providerId ?? undefined;
  const creds = await resolveCredentials(providerId);
  if (!creds?.apiKey) {
    return {
      ...base,
      error: 'llm_not_configured',
      message: '还没有配置 API Key：先在「密钥来源」里粘贴，或用启动脚本从本机密文注入。',
    };
  }
  // 自定义接入线可能还没填地址 —— 这时不能"退回默认端点"：
  // 拿 MiniMax 的端点去发别家的 key，报错会指不到真正的原因。
  if (!creds.baseUrl) {
    return {
      ...base,
      error: 'llm_not_configured',
      message: '还没填端点地址：先在「密钥来源」里选好接入线并填入地址。',
    };
  }
  // 思考深度只在**认这个参数**的接入线上发：多发一个不认的参数会让整次请求失败。
  const effortSupported = findProvider(providerId ?? currentProviderId())?.effortSupported === true;

  let reply: ChatJsonResult;
  try {
    reply = await chatJson({
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
      model: input.model?.trim() || creds.model,
      ...(effortSupported && input.effort ? { effort: input.effort } : {}),
      prompt: promptText,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
  } catch (err) {
    if (err instanceof PlanRequestError) {
      return {
        ...base,
        error: err.kind,
        code: err.providerCode,
        message: err.message,
      };
    }
    return { ...base, error: 'llm_http', message: scrub((err as Error).message) };
  }

  const parsed = parsePlanReply(reply.reply);
  if (!parsed.ok) {
    return {
      ...base,
      error: 'plan_not_json',
      model: reply.model,
      elapsedMs: reply.elapsedMs,
      message: parsed.message,
    };
  }

  // 空计划不是「计划不合法」，是模型在回话。
  //
  // 提示词铁律②教模型把「做不了」写成 ops: [] + intent 说明，
  // 但契约要求 ops 至少一条 —— 模型照做反而会被判「不合规矩」。
  // 实测（2026-10-24，真 key）：用户说「把这一列改名叫…」，
  // 模型拒绝对不指明的列乱猜（这是对的），回话却被闸门①判成
  // 「计划里一条操作都没有」，界面上只剩一句用户看不懂的话。
  const emptyIntent = readEmptyPlanIntent(parsed.value);
  if (emptyIntent !== null) {
    return {
      ...base,
      // 「做不了」与「你没说清」给不同的下场：前者换个操作，后者补一句信息
      error: UNSUPPORTED_HINT.test(emptyIntent) ? 'op_not_supported' : 'plan_needs_clarification',
      model: reply.model,
      elapsedMs: reply.elapsedMs,
      message: emptyIntent,
    };
  }

  const schemaIssues = validatePlanSchema(parsed.value, schema);
  const plan = asPlanDocument(parsed.value);
  if (schemaIssues.length > 0) {
    return {
      ...base,
      error: 'plan_schema_invalid',
      model: reply.model,
      elapsedMs: reply.elapsedMs,
      plan,
      schemaIssues,
      message: `模型返回的计划不符合操作契约：${schemaIssues[0]?.message ?? ''}`,
    };
  }

  const unsupported = findUnsupportedOps(parsed.value, implementedOps());
  if (unsupported.length > 0) {
    return {
      ...base,
      error: 'op_not_supported',
      model: reply.model,
      elapsedMs: reply.elapsedMs,
      plan,
      unsupported,
      message: unsupported[0]?.message ?? '该操作尚未支持',
    };
  }

  // 闸门②：引擎前置校验（逐条）
  const precheck: PrecheckEntry[] = [];
  if (input.precheck && plan) {
    for (let i = 0; i < plan.ops.length; i++) {
      const spec = plan.ops[i];
      if (!spec) continue;
      let outcome: PrecheckOutcome;
      try {
        outcome = await input.precheck(spec);
      } catch (err) {
        outcome = { ok: false, error: scrub((err as Error).message), unimplemented: false };
      }
      const status = classifyPrecheck(outcome);
      precheck.push({
        opIndex: i,
        op: spec.op,
        status,
        message:
          status === 'pass'
            ? null
            : status === 'unimplemented'
              ? `该操作尚未支持：${spec.op}`
              : outcome.error,
      });
    }
  }

  return {
    ...base,
    ok: true,
    model: reply.model,
    elapsedMs: reply.elapsedMs,
    plan,
    precheck,
    message: null,
  };
}

/**
 * 只算「本次将发送什么」，不发请求。
 *
 * 用户在按下发送之前就该看到这段内容 —— 这是「最小必要披露」能被
 * 拿去做合规举证的前提（docs/01 §4.4）。
 */
export async function buildContextPreview(input: {
  readonly context?: unknown;
  readonly prompt?: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly root?: string | null;
}): Promise<ContextPreview> {
  const schema = readOpsSchema();
  const catalog = opCatalog(schema, implementedOps());
  const context = await enrichContext(buildPlanContext(input.context), input.root ?? null);
  const promptText = buildPlanPrompt({
    context,
    instruction: input.prompt ?? '',
    catalog,
  });
  return {
    context,
    prompt: promptText,
    bytes: Buffer.byteLength(promptText, 'utf8'),
    model: input.model ?? null,
    effort: input.effort ?? null,
  };
}

/**
 * 用 GDAL 补齐上下文里"允许发送但前端不一定有"的字段：字段名、字段类型、
 * 要素数量、坐标系标识。
 *
 * 补的是**元数据**，不是数据本身 —— 原始像元、原始要素表一律不发。
 * 探查失败就保持原样，不因此让整个请求失败。
 */
export async function enrichContext(context: PlanContext, root: string | null): Promise<PlanContext> {
  if (!root) return context;
  const loc = resolveGdal();
  if (!loc) return context;
  const layers: PlanLayerContext[] = [];
  for (const layer of context.layers) {
    const abs = resolve(root, layer.path);
    if (!isInside(root, abs)) {
      layers.push(layer);
      continue;
    }
    try {
      const probe = await probeDataset(loc, abs);
      const ds = probe.dataset;
      if (!ds) {
        layers.push(layer);
        continue;
      }
      if (ds.kind === 'vector') {
        layers.push({
          ...layer,
          fields: ds.fields.map((f) => ({ name: f.name, type: f.type })),
          featureCount: ds.featureCount,
          crs: layer.crs ?? crsLabel(ds.crs),
        });
      } else {
        layers.push({ ...layer, crs: layer.crs ?? crsLabel(ds.crs) });
      }
    } catch {
      layers.push(layer);
    }
  }
  return { ...context, layers };
}

/* ────────────────────────────────────────────────────────────
 * §7 内部工具
 * ──────────────────────────────────────────────────────────── */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function number(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function countOrNull(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v);
}

function clipText(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** 坐标数组：只能含数字，且总数不超上限 */
function allNumbers(value: unknown, budget: { left: number }): boolean {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    budget.left -= 1;
    return budget.left >= 0;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!allNumbers(item, budget)) return false;
    }
    return true;
  }
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** 把模型产物认成一份计划（认不出来就给 null，不猜） */
function asPlanDocument(value: unknown): PlanDocument | null {
  if (!isPlainObject(value)) return null;
  const ops = value['ops'];
  if (!Array.isArray(ops)) return null;
  const list: OperationSpec[] = [];
  for (const op of ops) {
    if (!isPlainObject(op)) return null;
    const name = op['op'];
    if (typeof name !== 'string') return null;
    const params = isPlainObject(op['params']) ? op['params'] : {};
    list.push({
      op: name,
      params,
      ...(isPlainObject(op['preconditions']) ? { preconditions: op['preconditions'] } : {}),
      ...(isPlainObject(op['expect']) ? { expect: op['expect'] } : {}),
      ...(typeof op['requireUserConfirm'] === 'boolean'
        ? { requireUserConfirm: op['requireUserConfirm'] }
        : {}),
    });
  }
  return {
    version: '1.0',
    ...(typeof value['intent'] === 'string' ? { intent: value['intent'] } : {}),
    ops: list,
  };
}

/** 路径是否落在 root 之下（Windows 上不区分大小写） */
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

/** 密钥绝不出现在错误里（兜底：即使上游忘了 scrub） */
export function scrubSecret(text: string, apiKey: string | null | undefined): string {
  return redactSecrets(text, [apiKey]);
}
