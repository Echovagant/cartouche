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
  readFeatures,
  redactSecrets,
  resolveGdal,
  type GdalLocation,
  type MinimaxFetch,
  type OperationSpec,
  type PlanDocument,
} from '@cartouche/engine';
import { currentProviderId, resolveCredentials, scrub } from './llm.ts';
import { assertSafeLlmBaseUrl } from './llm-endpoint.ts';

/* ────────────────────────────────────────────────────────────
 * §1 上下文裁剪：白名单
 *
 * 依据 docs/01 §4.4「最小必要披露」：
 *   允许发送 —— 图层名 / 字段名 / 字段类型 / 要素数量 / 当前选中图层 /
 *                图层范围（4 个数字）/ 每列最多 4 个去重后的取值样本
 *                （只从前 50 条要素里取）/ 视窗内要素（几何简化 + 关键属性）/
 *                坐标系标识 / 用户提示词；
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
/** 每列最多带几个真实取值（让模型知道「耕地」「01」这种值确实存在） */
const MAX_FIELD_SAMPLES = 4;
/** 单个取值样本的长度上限 */
const MAX_SAMPLE_TEXT = 24;
/** 最多给几个图层取样本（读文件有成本，不铺开） */
const MAX_SAMPLE_LAYERS = 3;
/** 取样本时读多少条要素（不是全量，只是给模型看个大概） */
const SAMPLE_FEATURE_ROWS = 50;

export interface PlanFieldContext {
  readonly name: string;
  readonly type: string;
  /**
   * 这一列**真实出现过的值**（去重、截断）。
   *
   * 为什么要带：用户说「把地类里的耕地改成 01」时，模型只有列名和类型，
   * 不知道「耕地」到底存不存在、是原文还是编码；带上样本它才能判断
   * 该用 vector.reclassify 还是 vector.recode，而不是猜一个不存在的值。
   * 只取前几十条要素去重，不读全量，也不发原始几何。
   */
  readonly samples?: readonly string[];
}

/**
 * 送进模型的那份图层上下文（**逐字段挑出来的**，不是整个图层对象）。
 *
 * 为什么要挑：图层对象本身带着路径、显示名、引擎内部字段，
 * 整个丢给模型等于把本地文件系统信息发出去。留在这里的每一样
 * 都是"回答这句话用得上"的，其余一律不带。
 */
export interface PlanLayerContext {
  /** 图层 id（画布内的稳定标识，不含路径信息） */
  readonly id: string;
  /** 图层种类：栅格 / 矢量 */
  readonly kind: 'raster' | 'vector';
  /** 项目内相对路径（不含盘符、不含 `..`） */
  readonly path: string;
  /**
   * 图层地理范围 [minX, minY, maxX, maxY]（与图层同一坐标系）。
   *
   * 为什么要给：用户说「右上角那块」「对应范围」时，模型得有一个可换算的框；
   * 没有它就只能反问，或者瞎写一个 bbox。探测不到时为 null（不猜）。
   */
  readonly extent: readonly number[] | null;
  /** 该层当前是否可见（不可见的层不带要素） */
  readonly visible: boolean;
  /** 是否是用户当前选中的那一层（「这一层」指的就是它） */
  readonly active?: boolean;
  /** 不透明度 0~1 */
  readonly opacity: number;
  /** 字段清单（名字 + 类型）；没有字段的层给空数组 */
  readonly fields: readonly PlanFieldContext[];
  /** 要素总数；探测不到时为 null（null = 不知道，不是 0） */
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
  /**
   * 用户当前选中的图层 id（画布上的「这一层」）。
   *
   * 为什么要单独给：用户说「把这一层重投影」时，模型只能看到一堆可见图层，
   * 挑错层的代价是改错文件。这个字段把指代**在引擎侧就定死**，
   * 不让模型猜"这一层"是哪一层。没有明确选中时为 null。
   */
  readonly activeLayerId: string | null;
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
  const layers = buildLayers(o['layers']);
  // 指代只认「清单里真的存在的那一层」：前端传来一个不存在的 id 就当没选中，
  // 免得模型拿着一个空引用去编目标路径。
  const rawActive = clipText(text(o['activeLayerId']), MAX_NAME);
  const activeLayerId = layers.some((l) => l.id === rawActive) ? rawActive : null;
  return {
    projectName: clipText(text(o['projectName']), MAX_NAME),
    activeLayerId,
    layers: activeLayerId ? layers.map((l) => (l.id === activeLayerId ? { ...l, active: true } : l)) : layers,
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
      extent: buildExtent(item['extent']),
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
    const samples = clipSamples(item['samples']);
    out.push({
      name,
      type: clipText(text(item['type']), MAX_FIELD_TYPE),
      ...(samples.length > 0 ? { samples } : {}),
    });
    if (out.length >= 64) break;
  }
  return out;
}

/**
 * 把样本值裁成"能发出去"的形状：去重、去空、截断。
 *
 * 空串不发（会占位置又不带信息）；数字/布尔转成文字（模型看的是概念，
 * 不需要保留原始类型）；超过上限就截。
 */
function clipSamples(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
    const s = clipText(String(v).trim(), MAX_SAMPLE_TEXT);
    if (s === '' || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_FIELD_SAMPLES) break;
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

/** 图层范围：只收 4 个有限数字，其余一律当"不知道" */
function buildExtent(raw: unknown): readonly number[] | null {
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

/** 一次最多接受几步（模型拆得太碎反而更难确认） */
const MAX_PLAN_STEPS = 8;

export interface OpCatalogEntry {
  readonly op: string;
  readonly label: string;
  /** 一句话说清「什么事该用它」——模型据此选能力，而不是猜 op 名 */
  readonly use: string;
  /** 一份**合法**的参数示例（测试会真的送进闸门①） */
  readonly example: Readonly<Record<string, unknown>>;
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
  'vector.reclassify': '值重编码',
  'feature.summarize': '分组汇总',
};

/**
 * 每个 op 的一句话用途。
 *
 * 为什么不再把 params 的原始 JSON 丢给模型：那份 schema 是给**校验器**看的
 * （$ref / allOf / pattern），弱模型读不懂，经常抓错字段、把 $ref 当成值。
 * 这里先解决「这件事该用哪个 op」，参数形状交给紧凑的槽位说明。
 */
const OP_USAGE: Readonly<Record<string, string>> = {
  'raster.paint': '用纯色盖住一块区域（抹掉标注、画色块）',
  'raster.erase': '把一块区域擦掉；有干净底图时用底图填，没有就边界内插',
  'raster.replaceRegion': '把一张图的一块区域换成另一张图同一区域的内容',
  'raster.inpaint': '抹掉小块内容后自动补边界，让它看不出被改过',
  'raster.adjustLevels': '整体提亮/压暗、加对比或做伽马校正（只改整张图，没有区域参数；局部提亮目前做不到）',
  'raster.clip': '按矢量范围或地理范围把目标影像就地裁小（没有另存参数；要保留原图先复制）',
  'raster.resample': '改像元大小（重采样到指定分辨率）',
  'raster.mosaic': '把多张影像按地理位置拼成一张',
  'vector.query': '按条件查要素，只出结果表，不改文件',
  'vector.addField': '加一列，并按表达式/条件算值',
  'vector.spatialJoin': '把源图层的属性按空间关系汇总到目标图层',
  'vector.reproject': '换坐标系（重投影），可顺带对齐到另一层',
  'vector.renameFields': '给已有字段改名，不改值',
  'vector.recode': '字段内容乱码时换字符编码（GBK/UTF-8），不改字段名',
  'vector.reclassify': '按对照表把一列里的旧值换成新值（如 耕地→01）',
  'feature.summarize': '按字段分组汇总（计数、面积、求和等），只出结果表',
};

/**
 * 每个 op 的合法示例。
 *
 * 示例比文字描述更能约束模型：弱模型会照着形状抄。
 * 测试把每份示例都送进闸门①（validatePlanSchema），写错会当场红。
 */
const OP_EXAMPLES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'raster.paint': {
    target: 'dataset://影像.tif',
    region: { minX: 10, minY: 10, maxX: 40, maxY: 30 },
    color: '#d9480f',
  },
  'raster.erase': {
    target: 'dataset://影像.tif',
    region: { minX: 10, minY: 10, maxX: 40, maxY: 30 },
  },
  'raster.replaceRegion': {
    source: 'dataset://干净底图.tif',
    target: 'dataset://影像.tif',
    region: { minX: 10, minY: 10, maxX: 40, maxY: 30 },
  },
  'raster.inpaint': {
    target: 'dataset://影像.tif',
    region: { minX: 10, minY: 10, maxX: 40, maxY: 30 },
  },
  'raster.adjustLevels': { target: 'dataset://影像.tif', brightness: 0.1, contrast: 1.2 },
  'raster.clip': { target: 'dataset://影像.tif', bbox: [120.3, 30.5, 120.31, 30.51] },
  'raster.resample': {
    target: 'dataset://影像.tif',
    targetResolution: 0.5,
    resampleMethod: 'bilinear',
  },
  'raster.mosaic': {
    inputs: ['dataset://a.tif', 'dataset://b.tif'],
    output: 'dataset://拼接.tif',
  },
  'vector.query': { target: 'dataset://图层.shp', where: 'POP > 1000', limit: 50 },
  'vector.addField': { target: 'dataset://图层.shp', name: '面积', expression: 'AREA / 10000' },
  'vector.spatialJoin': {
    target: 'dataset://地块.shp',
    source: 'dataset://行政区.shp',
    relation: 'within',
    aggregate: 'count',
  },
  'vector.reproject': { target: 'dataset://图层.shp', to: 'EPSG:4547' },
  'vector.renameFields': { target: 'dataset://图层.shp', mapping: { OLD_NAME: '新名字' } },
  'vector.recode': { target: 'dataset://图层.shp', from: 'auto', to: 'UTF-8' },
  'vector.reclassify': {
    target: 'dataset://图层.shp',
    field: 'DLMC',
    mapping: [
      { from: '耕地', to: '01' },
      { from: '林地', to: '02' },
    ],
  },
  'feature.summarize': {
    target: 'dataset://图层.shp',
    groupBy: ['DLMC'],
    aggregates: ['count', 'area'],
    areaUnit: 'ha',
  },
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

/**
 * 列出这次允许模型提议的 op，以及它们各自的参数契约。
 *
 * 三道过滤缺一不可，少一道就会出静默的功能缺口：
 *   - 引擎注册表里**真的实现了**（implemented）：没实现的别塞进提示词，
 *     塞了模型就会提议一个跑不起来的操作；
 *   - 前缀白名单（raster./vector.）加逐个点名（feature.summarize）：
 *     把会删数据的 feature.delete 挡在外面；
 *   - schema 里有这个 op 的参数定义：没有契约就没法校验，模型写了也是白写。
 *
 * 契约直接取自 ops.schema.json —— 提示词里的参数说明与校验用的是同一份，
 * 两边不会走样。
 */
export function opCatalog(schema: SchemaNode, implemented: readonly string[]): OpCatalogEntry[] {
  const allowed = schema.$defs?.['operation']?.properties?.['op']?.enum ?? [];
  const out: OpCatalogEntry[] = [];
  for (const op of implemented) {
    const allowedByPrefix = AI_OP_PREFIXES.some((prefix) => op.startsWith(prefix));
    if (!allowedByPrefix && !AI_OP_ALLOW.includes(op)) continue;
    if (!allowed.includes(op)) continue;
    const params = schema.$defs?.[`params.${op}`];
    if (!params) continue;
    out.push({
      op,
      label: OP_LABELS[op] ?? op,
      use: OP_USAGE[op] ?? '',
      example: OP_EXAMPLES[op] ?? {},
      params,
    });
  }
  return out.sort((a, b) => a.op.localeCompare(b.op));
}

/**
 * 把 op 目录渲染成**给模型读的槽位清单**，而不是原始 JSON Schema。
 *
 * 每一条都回答三个问题：这件事该用哪个 op、参数要填什么、填出来长什么样。
 * 契约本身没有被改写 —— 校验仍然用 ops.schema.json，这里只是换了一种说法。
 */
function renderOpCatalog(catalog: readonly OpCatalogEntry[]): string {
  const root = readOpsSchema();
  const lines: string[] = [];
  for (const entry of catalog) {
    lines.push(`### ${entry.op} · ${entry.label}`);
    if (entry.use) lines.push(`用途：${entry.use}`);
    const desc = entry.params.description?.trim();
    if (desc) lines.push(`说明：${desc}`);
    const props = entry.params.properties ?? {};
    const required = entry.params.required ?? [];
    const names = Object.keys(props);
    if (names.length > 0) {
      lines.push('参数（带 * 为必填）：');
      for (const name of names) {
        const node = props[name];
        if (!node) continue;
        lines.push(`  - ${name}${required.includes(name) ? '*' : ''}：${describeSlot(node, root)}`);
      }
    }
    lines.push(`示例：${JSON.stringify(entry.example)}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** 一个参数的「槽位说明」：类型 + 描述 + 取值范围/默认值 */
function describeSlot(node: SchemaNode, root: SchemaNode): string {
  const bits: string[] = [];
  const type = slotType(node, root);
  if (type) bits.push(type);
  if (node.description?.trim()) bits.push(node.description.trim());
  const bounds = slotBounds(node);
  if (bounds) bits.push(bounds);
  if (node.default !== undefined) bits.push(`默认 ${JSON.stringify(node.default)}`);
  return bits.join('；');
}

function slotBounds(node: SchemaNode): string {
  if (node.minimum !== undefined && node.maximum !== undefined) {
    return `范围 ${node.minimum}~${node.maximum}`;
  }
  if (node.minimum !== undefined) return `不小于 ${node.minimum}`;
  if (node.exclusiveMinimum !== undefined) return `大于 ${node.exclusiveMinimum}`;
  if (node.maxLength !== undefined) return `最长 ${node.maxLength} 字`;
  return '';
}

const REF_HINTS: Readonly<Record<string, string>> = {
  pathRef: 'dataset://<工作区相对路径>',
  layerRef: 'dataset://<工作区相对路径>',
  bbox: '[minX,minY,maxX,maxY]',
  hexColor: '"#RRGGBB"',
  rgb: '[r,g,b]',
  pixelMask: '掩膜对象（由画布生成，不要手写）',
};

/** 把一个 schema 节点压缩成一句话（不展开整个契约） */
function slotType(node: SchemaNode, root: SchemaNode, depth = 0): string {
  if (depth > 4) return '';
  if (node.$ref) {
    const name = node.$ref.split('/').pop() ?? '';
    const hint = REF_HINTS[name];
    if (hint) return hint;
    const def = resolveRef(node.$ref, root);
    return def ? slotType(def, root, depth + 1) : '';
  }
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (node.allOf && node.allOf.length > 0) {
    const parts: string[] = [];
    for (const sub of node.allOf) {
      if (sub.if) {
        // 条件分支：把 then / else 两种形状都列出来（如 region 的两种写法）
        if (sub.then) parts.push(slotType(sub.then, root, depth + 1));
        if (sub.else) parts.push(slotType(sub.else, root, depth + 1));
      } else {
        parts.push(slotType(sub, root, depth + 1));
      }
    }
    const unique = [...new Set(parts.filter((p) => p !== ''))];
    if (unique.length > 0) return unique.join(' 或 ');
  }
  const type = node.type;
  if (Array.isArray(type)) {
    return [...new Set((type as readonly string[]).map(typeName))].join(' / ');
  }
  if (typeof type !== 'string') return '';
  if (type === 'array') {
    const item = node.items ? slotType(node.items, root, depth + 1) : '';
    return item ? `${item} 的数组` : '数组';
  }
  if (type === 'object') {
    const props = node.properties ? Object.keys(node.properties) : [];
    return props.length > 0 ? `对象 {${props.join(', ')}}` : '对象';
  }
  return typeName(type);
}

function typeName(raw: string): string {
  switch (raw) {
    case 'string':
      return '文字';
    case 'number':
      return '数字';
    case 'integer':
      return '整数';
    case 'boolean':
      return '布尔';
    case 'array':
      return '数组';
    case 'object':
      return '对象';
    default:
      return raw;
  }
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
  /** 本次只处理其中一步：直接出计划，不要再拆步骤 */
  readonly stepOnly?: boolean;
}): string {
  const catalogText = renderOpCatalog(input.catalog);
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
    '   （例外：一句话里有好几件事时，先按第 13 条只输出步骤清单，不要输出 ops。）',
    '4. params 必须严格符合该 op 的参数契约：字段名照抄契约，多余字段一律不给，',
    '   必填字段不能少。',
    '5. 路径类参数（target / source / clip / output / mosaic 的 inputs）只能写成',
    '   "dataset://<工作区相对路径>"（如 "dataset://底图/current.tff"）。',
    '   引擎只认这一种：图层标识 "layer://<图层 id>" 不是文件路径，引擎会直接拒掉，',
    '   写它等于把一条跑不动的计划交上来。',
    '   裸路径（"底图/current.tff"）不符合契约，会被第一道闸门直接拒掉。',
    '   输入类参数（target / source / clip）只能填上下文 layers 里出现过的 path；',
    '   用户点名一个不在清单里的文件时，不要出计划——请用户先确认文件名或把它加载进项目。',
    '   只有 output（另存为新文件）可以写一个当前不存在的新路径。',
    '   不要写盘符路径、绝对路径或任何本机信息。',
    '6. region（要改动的区域）**不是**引用，只能是下面两种形状之一：',
    '   ① 像元坐标对象 {"minX":4,"minY":3,"maxX":10,"maxY":8}：左上角为原点，maxX/maxY 不含；',
    '   ② 地理范围数组 [minX,minY,maxX,maxY]：与目标图层同一坐标系的地理范围。',
    '   你拿不到像元坐标就用 ②（画布框选给出的才是 ①）。',
    '   绝对不要写 "layer://…" 或 "dataset://…"：引擎无法把图层引用解析成区域。',
    '7. 没有把握的参数宁可不给，也不要编：引擎会逐条校验，编错的值比缺的值更糟。',
    '8. ops 最多 50 条，通常 1~3 条就够。',
    '9. 指代消解：「这一层」「当前图层」「这个文件」= 上下文里的 activeLayerId 那一层；',
    '   它同时也会在 layers 里标注 active=true。用户没点名图层时优先用它。',
    '   activeLayerId 为 null 且有多个可见层时，不要猜，把 ops 写成空数组并请用户指明是哪一层。',
    '10. fields[].samples 是这一列**真实出现过的值**（只取了前几十条的样本，不是全部）。',
    '   用户提到的旧值（要匹配、替换、筛选的值）要先在 samples 里对上（如「耕地」）。',
    '   对不上就不要出计划：把 ops 写成空数组，在 intent 里写明「样本里没有这个值，',
    '   请确认是不是写错了」——不要交一份一条都匹配不上的计划。',
    '   注意：这是「请用户补充/确认」，不是「该操作尚未支持」，别用后者来描述值写错。',
    '11. 目标是 .shp 时字段名有 10 字节上限（UTF-8 编码下最多 3 个汉字）：',
    '   addField 的 name、renameFields 的新名、spatialJoin 的 fieldPrefix + 汇总字段名',
    '   都要守这个限制。拿不准就把前缀缩到 1 个汉字，或省略前缀。',
    '   spatialJoin 往目标写回时，如果目标图层已经有同名的列（如两边都有「名称」），',
    '   必须给一个 1 个汉字的 fieldPrefix，否则一定会报重名错。',
    '12. layers[].extent 是该层的地理范围 [minX,minY,maxX,maxY]（与图层同一坐标系）。',
    '   用户说「右上角」「左上角」「中间」「对应范围」时按 extent 换算成 bbox / region；',
    '   两个图层的「对应范围」= 两者 extent 的重叠区（取交集）。extent 为 null 时不要猜。',
    '13. 先判断这件事一步能不能做完：',
    '    一个 op 能表达 → 直接输出计划；',
    '    要改两件以上不同的事（不同操作、不同文件、有先后顺序）→ 不要硬塞进一份计划，',
    '    先只输出步骤清单（**不要**输出 ops）：',
    '    {"version":"1.0","intent":"一句话总目标","steps":["第 1 步…","第 2 步…"]}',
    '    steps 2~5 条，按执行顺序，每条只做一件事，写清对象（哪一层、哪一列/哪个范围）。',
    '    用户会逐步确认；每一步再单独出计划。',
    '14. 用户只是**询问信息**（有多少要素、什么坐标系、有哪些字段、范围多大）而不是要求改数据：',
    '    不要硬凑操作。把 ops 写成空数组，在 intent 里用一句话直接回答。',
    '    这些信息 layers[] 里都有（featureCount / crs / fields / extent），照抄即可。',
    ...(input.stepOnly
      ? [
          '15. 本次只处理**其中一步**：直接输出计划，不要再拆 steps。',
        ]
      : []),
    '',
    '【可用操作清单】',
    catalogText,
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

/**
 * 一次「要 JSON」的对话请求参数。
 *
 * 单独于普通对话（chatOnce）的原因：一份计划不是一句话，是一份 JSON 文档，
 * token 上限与解析方式都不一样，所以另开一条路。
 */
export interface ChatJsonOptions {
  /** 调用的密钥（只在这一次请求里用一次，不落盘、不回显） */
  readonly apiKey: string;
  /** 端点根地址（不带路径，函数自己拼 /chat/completions） */
  readonly baseUrl: string;
  /** 模型名（须在可用清单内，换台机器才跑得动） */
  readonly model: string;
  /** 思考深度档位；只对认这个参数的接入线生效 */
  readonly effort?: string | undefined;
  /** 提示词全文（含裁剪后的上下文与 op 目录） */
  readonly prompt: string;
  /** 输出的 token 上限；不给就用引擎侧的默认值 */
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
  // 发送前再校验一次：就算调用方绕过了保存时的检查，也不让 http:// 外网地址拿到密钥。
  const url = `${assertSafeLlmBaseUrl(options.baseUrl).replace(/\/+$/, '')}/chat/completions`;
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

/**
 * 从模型的回话里抠出 JSON。
 *
 * ⚠️ 必须先剥掉 `<think>…</think>`：MiniMax-M3 会把推理过程写在 content 里，
 * 而推理里**也会出现 `{…}`**（它在心里先把 JSON 写一遍）。
 * 直接「从第一个 { 截到最后一个 }」会把整段思考当成 JSON —— 实测 10/27 条
 * 因此被判成「不是可解析的 JSON」，换个模型就全好了。这是模型形态差异，不是用户的问题。
 */
export function parsePlanReply(reply: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const withoutThinking = reply.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  const cleaned = withoutThinking
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
 * 模型在说「值/信息不对，请你确认」。
 *
 * 有些模型会把「样本里没有这个值，请确认」写成「……该操作尚未支持直接匹配」——
 * 里面同时带「尚未支持」。这时按澄清处理才对：用户该补的是信息，不是换功能。
 */
const CLARIFY_HINT = /样本(?:里|值中|中)没有|请确认|是否写错/;

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

/**
 * 模型先给步骤清单（复杂任务），而不是一份硬塞的计划。
 *
 * 形状：{"version":"1.0","intent":"总目标","steps":["第 1 步…","第 2 步…"]}
 * 只认**没有 ops** 的那种；带 ops 的按计划走，避免同一份回话里既给计划又给步骤。
 * 不是这种形状就返回 null。
 */
export function readStepOutline(value: unknown): string[] | null {
  if (!isPlainObject(value)) return null;
  if (value['version'] !== '1.0') return null;
  const raw = value['steps'];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const ops = value['ops'];
  if (Array.isArray(ops) && ops.length > 0) return null;
  const goals: string[] = [];
  for (const item of raw) {
    // 弱模型常把步骤写成 {"goal": "…"} —— 认这一种，不让整份回话作废
    const rawGoal = typeof item === 'string'
      ? item
      : isPlainObject(item)
        ? (item['goal'] ?? item['step'] ?? item['title'])
        : null;
    if (typeof rawGoal !== 'string') return null;
    const trimmed = rawGoal.trim();
    if (trimmed === '') return null;
    // 模型常自己带「第 1 步：」/「1.」前缀；界面会统一编号，这里去掉避免重复。
    // 去掉后什么都不剩就保留原文，宁可重复也不能把步骤弄丢。
    const goal = stripStepNumbering(trimmed) || trimmed;
    goals.push(clipText(goal, 200));
  }
  return goals;
}

/** 去掉步骤自带的编号前缀（中文「第 N 步：」或阿拉伯数字「1.」） */
function stripStepNumbering(text: string): string {
  const cleaned = text
    .replace(/^第\s*[0-9一二三四五六七八九十百]+\s*步\s*[：:、,.\-]?\s*/, '')
    .replace(/^步骤\s*[0-9一二三四五六七八九十百]+\s*[：:、,.\-]?\s*/, '')
    .replace(/^\s*\d+\s*[.、)）:：]\s*/, '')
    .trim();
  return cleaned;
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

/**
 * 引擎前置校验的入口：拿一条操作去问引擎"这条到底做不做得了"。
 *
 * 由 app.ts 注入（那边才握着 GDAL 运行时与调度器），本模块不直接依赖引擎 ——
 * 闸门逻辑因此可以脱离引擎单独测。
 */
export type PrecheckFn = (spec: OperationSpec) => Promise<PrecheckOutcome>;

/**
 * 前置校验的四种结论。
 *
 * `unpreviewable` 单独分出来：引擎对"预演不了影响面"的 op 也给 ok:false，
 * 那是**能力边界**不是校验失败 —— 混进 fail 会让界面误报"这条操作有错"。
 */
export type PrecheckStatus = 'pass' | 'fail' | 'unimplemented' | 'unpreviewable';

/** 计划里某一条操作的前置校验结论 */
export interface PrecheckEntry {
  /** 该操作在计划里的序号（对应 plan.ops 的下标） */
  readonly opIndex: number;
  /** 操作名（如 raster.paint） */
  readonly op: string;
  /** 结论 */
  readonly status: PrecheckStatus;
  /** 人话说明；status 为 pass 时为 null */
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

/**
 * 提议接口的返回体。
 *
 * 一次请求带回来的东西比"成功/失败"多得多：失败要带**原因**，
 * 成功要带**逐条校验结论**（哪条没过、为什么），
 * 外加"本次将发送什么"的预览 —— 前端只靠这一份就能决定怎么提示用户。
 */
export interface PlanResponseBody {
  /** 整体是否可用（没过任何一道闸门） */
  readonly ok: boolean;
  /** 机器可读的失败类别（llm_not_configured / plan_schema_invalid / …）；成功为 null */
  readonly error: string | null;
  /** 官方错误码（如 1004） */
  readonly code: number | null;
  /** 人话说明；成功为 null */
  readonly message: string | null;
  /** 实际使用的模型；模型没应答到就为 null */
  readonly model: string | null;
  /** 实际使用的思考深度 */
  readonly effort: string | null;
  /** 请求耗时（毫秒）；失败前就断了则为 null */
  readonly elapsedMs: number | null;
  /** 解析出来的计划；没过校验时可能为 null */
  readonly plan: PlanDocument | null;
  /**
   * 复杂任务的步骤清单（模型先拆步骤，还没出计划）。
   *
   * 非空时 `ok=true`、`plan=null`：这不是失败，是"先对齐步骤"。
   * 前端拿它逐步发回 `stepOnly` 的提议请求，每一步单独确认、单独执行。
   */
  readonly steps: readonly string[];
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
  /** 本次只处理其中一步：告诉模型直接出计划，不要再拆步骤 */
  readonly stepOnly?: boolean | undefined;
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
    ...(input.stepOnly ? { stepOnly: true } : {}),
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
    steps: [],
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

  // 复杂任务：模型先给步骤清单，还没出计划。
  //
  // 这不是失败：用户要先看到"这件事分几步、每步做什么"，再一步一步确认。
  // 每一步会被前端作为一次新的提议请求发回来（stepOnly=true），
  // 那一次只带一个目标，模型不用同时想三件事。
  const stepGoals = readStepOutline(parsed.value);
  if (stepGoals !== null) {
    if (input.stepOnly) {
      return {
        ...base,
        error: 'plan_needs_clarification',
        model: reply.model,
        elapsedMs: reply.elapsedMs,
        message:
          `模型把这一步又拆成了 ${stepGoals.length} 小步（${stepGoals.join('；')}）。` +
          '请把这一步写得更具体：哪一层、哪一列 / 哪个范围。',
      };
    }
    if (stepGoals.length > MAX_PLAN_STEPS) {
      return {
        ...base,
        error: 'plan_needs_clarification',
        model: reply.model,
        elapsedMs: reply.elapsedMs,
        message:
          `这件事被拆成了 ${stepGoals.length} 步（一次最多 ${MAX_PLAN_STEPS} 步）。` +
          '先把范围收窄到最关键的一两步，再让 AI 出计划。',
      };
    }
    return {
      ...base,
      ok: true,
      model: reply.model,
      elapsedMs: reply.elapsedMs,
      steps: stepGoals,
      message: null,
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
      // 「做不了」与「你没说清」给不同的下场：前者换个操作，后者补一句信息。
      // 同时带两种措辞时，以「请你确认」为准（见 CLARIFY_HINT 的说明）。
      error:
        !CLARIFY_HINT.test(emptyIntent) && UNSUPPORTED_HINT.test(emptyIntent)
          ? 'op_not_supported'
          : 'plan_needs_clarification',
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
  // 只有前几个「看得见的矢量层」取样本：每层一次小读取，不能让一次提议
  // 变成把整个项目翻一遍。其余层照旧只有字段名与类型。
  let sampled = 0;
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
        const fields = ds.fields.map((f) => ({ name: f.name, type: f.type }));
        const canSample = layer.visible && sampled < MAX_SAMPLE_LAYERS;
        const samples = canSample ? await sampleFieldValues(loc, abs, fields) : null;
        if (samples) sampled++;
        layers.push({
          ...layer,
          extent: layer.extent ?? ds.extent,
          fields: samples ? fields.map((f) => withSamples(f, samples)) : fields,
          featureCount: ds.featureCount,
          crs: layer.crs ?? crsLabel(ds.crs),
        });
      } else {
        layers.push({
          ...layer,
          extent: layer.extent ?? ds.extent,
          crs: layer.crs ?? crsLabel(ds.crs),
        });
      }
    } catch {
      layers.push(layer);
    }
  }
  return { ...context, layers };
}

/**
 * 读几十条要素，按列收集真实出现过的值。
 *
 * 只做**去重后的前几个值**：给模型的是「这一列长什么样」，
 * 不是把属性表发出去。读不出来就返回 null —— 样本是锦上添花，
 * 不能因为某个格式读不动就让整次提议失败。
 */
async function sampleFieldValues(
  loc: GdalLocation,
  abs: string,
  fields: readonly { name: string; type: string }[],
): Promise<Map<string, string[]> | null> {
  try {
    const read = await readFeatures(loc, { path: abs, limit: SAMPLE_FEATURE_ROWS });
    const collected = new Map<string, { values: string[]; seen: Set<string> }>();
    for (const field of fields.slice(0, 32)) {
      collected.set(field.name, { values: [], seen: new Set() });
    }
    for (const feature of read.features) {
      for (const [name, value] of Object.entries(feature.properties)) {
        const bucket = collected.get(name);
        if (!bucket || bucket.values.length >= MAX_FIELD_SAMPLES) continue;
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          continue;
        }
        const text = String(value).trim();
        if (!text) continue;
        const clipped = clipText(text, MAX_SAMPLE_TEXT);
        if (bucket.seen.has(clipped)) continue;
        bucket.seen.add(clipped);
        bucket.values.push(clipped);
      }
      // 所有列都凑够样本就不用再翻后面的要素了
      if ([...collected.values()].every((b) => b.values.length >= MAX_FIELD_SAMPLES)) break;
    }
    const out = new Map<string, string[]>();
    for (const [name, bucket] of collected) {
      if (bucket.values.length > 0) out.set(name, bucket.values);
    }
    return out;
  } catch {
    return null;
  }
}

function withSamples(
  field: { name: string; type: string },
  samples: ReadonlyMap<string, string[]>,
): PlanFieldContext {
  const values = samples.get(field.name);
  return values ? { ...field, samples: values } : field;
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
