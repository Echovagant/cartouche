/**
 * 规则模板引擎。
 *
 * 为什么需要它：很多"改图"任务其实是**固定形状**的（批量改属性、按图层裁切、
 * 编码修复……），用确定性模板做，100% 可控、可复现、零幻觉；
 * AI 只需要把用户的自然语言映射到模板参数上。
 *
 * 模板产出的东西和 AI 直接产出的东西是**同一种东西**——操作计划，
 * 所以两者可以混用：模板负责确定性，AI 负责"用户到底想要哪个模板"。
 */
export type ParamType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'layerRef'
  | 'bbox'
  | 'object'
  | 'stringArray';

export interface TemplateParamSpec {
  readonly name: string;
  readonly label: string;
  readonly type: ParamType;
  readonly required: boolean;
  readonly description?: string;
  readonly options?: readonly string[];
}

export interface OperationPlan {
  readonly op: string;
  readonly params: Record<string, unknown>;
}

export interface OperationTemplate {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly op: string;
  readonly params: readonly TemplateParamSpec[];
  /** 示例输入，用于生成模板说明与自检 */
  readonly example: Record<string, unknown>;
  build(input: Record<string, unknown>): OperationPlan;
}

export interface TemplateParamSummary {
  readonly name: string;
  readonly label: string;
  readonly type: ParamType;
  readonly required: boolean;
  readonly description?: string;
  readonly options?: readonly string[];
}

export interface TemplateSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly op: string;
  readonly required: readonly string[];
  readonly params: readonly TemplateParamSummary[];
}

export class TemplateError extends Error {
  readonly templateId: string;
  constructor(templateId: string, message: string) {
    super(`[${templateId}] ${message}`);
    this.name = 'TemplateError';
    this.templateId = templateId;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkType(spec: TemplateParamSpec, value: unknown): void {
  const bad = (): never => {
    throw new TemplateError(
      '',
      `参数 "${spec.name}"（${spec.label}）类型应为 ${spec.type}，实际收到 ${typeof value}`,
    );
  };
  switch (spec.type) {
    case 'number':
      if (typeof value !== 'number') bad();
      return;
    case 'boolean':
      if (typeof value !== 'boolean') bad();
      return;
    case 'string':
    case 'layerRef':
      if (typeof value !== 'string') bad();
      return;
    case 'object':
      if (!isPlainObject(value)) bad();
      return;
    case 'stringArray':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) bad();
      return;
    case 'bbox':
      if (!Array.isArray(value) || value.length !== 4 || value.some((v) => typeof v !== 'number')) bad();
      return;
  }
}

export class TemplateRegistry {
  readonly #templates = new Map<string, OperationTemplate>();

  constructor(templates: readonly OperationTemplate[] = []) {
    for (const t of templates) this.register(t);
  }

  register(template: OperationTemplate): void {
    if (this.#templates.has(template.id)) {
      throw new TemplateError(template.id, '模板 id 重复');
    }
    this.#templates.set(template.id, template);
  }

  get(id: string): OperationTemplate {
    const t = this.#templates.get(id);
    if (!t) throw new TemplateError(id, '未登记的模板');
    return t;
  }

  /** 给 AI 看的精简清单 */
  list(): TemplateSummary[] {
    return [...this.#templates.values()].map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      op: t.op,
      required: t.params.filter((p) => p.required).map((p) => p.name),
      params: t.params.map((p) => ({
        name: p.name,
        label: p.label,
        type: p.type,
        required: p.required,
        ...(p.description ? { description: p.description } : {}),
        ...(p.options ? { options: p.options } : {}),
      })),
    }));
  }

  /** 按关键词检索模板（AI 选模板用） */
  search(keyword: string): OperationTemplate[] {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return [];
    return [...this.#templates.values()].filter((t) => {
      const haystack = [
        t.id,
        t.title,
        t.description,
        ...t.params.map((p) => `${p.label} ${p.name} ${p.description ?? ''}`),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(kw);
    });
  }

  /** 校验并构建操作计划 */
  build(id: string, input: Record<string, unknown>): OperationPlan {
    const template = this.get(id);
    const known = new Set(template.params.map((p) => p.name));

    for (const key of Object.keys(input)) {
      if (!known.has(key)) {
        throw new TemplateError(id, `未知参数 "${key}"，可用参数：${[...known].join('、')}`);
      }
    }

    for (const spec of template.params) {
      const value = input[spec.name];
      // 注意：false / 0 是合法值，不能当成"没传"
      const missing = value === undefined || value === null;
      if (spec.required && missing) {
        throw new TemplateError(id, `缺少必填参数 "${spec.name}"（${spec.label}）`);
      }
      if (!missing) checkType(spec, value);
    }

    return template.build(input);
  }
}

/* ─────────────────────── 内置模板 ─────────────────────── */

function template(
  id: string,
  title: string,
  description: string,
  op: string,
  params: readonly TemplateParamSpec[],
  example: Record<string, unknown>,
  extra?: (input: Record<string, unknown>) => Record<string, unknown>,
): OperationTemplate {
  return {
    id,
    title,
    description,
    op,
    params,
    example,
    build(input) {
      const out: Record<string, unknown> = {};
      for (const p of params) {
        if (input[p.name] !== undefined) out[p.name] = input[p.name];
      }
      const extraParams = extra?.(input) ?? {};
      return { op, params: { ...out, ...extraParams } };
    },
  };
}

const LAYER = (required = true): TemplateParamSpec => ({
  name: 'target',
  label: '目标图层',
  type: 'layerRef',
  required,
  description: '形如 dataset://a.shp 或 layer://某图层',
});

export const builtinTemplates: readonly OperationTemplate[] = [
  template(
    'health-check',
    '数据体检',
    '检查坐标系统、编码、几何、字段等问题，找出算错但看不出来的隐患',
    'dataset.healthCheck',
    [
      LAYER(),
      {
        name: 'checks',
        label: '检查项',
        type: 'stringArray',
        required: true,
        description: '如 crs-present / encoding / null-geometry',
      },
    ],
    { target: 'dataset://parcel.shp', checks: ['crs-present', 'encoding'] },
  ),
  template(
    'batch-set-attr',
    '批量修改属性',
    '按条件批量修改字段值',
    'feature.setAttributes',
    [
      LAYER(),
      { name: 'where', label: '筛选条件', type: 'string', required: true, description: 'SQL 条件，如 状态 = \'待核查\'' },
      { name: 'set', label: '要改的字段', type: 'object', required: true, description: '字段名 → 新值' },
    ],
    { target: 'dataset://parcel.shp', where: "状态 = '待核查'", set: { 状态: '已核查' } },
  ),
  template(
    'delete-by-filter',
    '按条件删除要素',
    '删除满足条件的要素，删除前会自动备份并要求确认',
    'feature.delete',
    [
      LAYER(),
      { name: 'where', label: '筛选条件', type: 'string', required: true },
      {
        name: 'keep',
        label: '重复时保留',
        type: 'string',
        required: false,
        options: ['none', 'first', 'last', 'largest'],
      },
    ],
    { target: 'dataset://building.shp', where: "编号 IN ('A-013')" },
  ),
  template(
    'rename-fields',
    '重命名字段',
    '把乱码或拼音字段名改成规范名',
    'vector.renameFields',
    [
      LAYER(),
      { name: 'mapping', label: '新旧对应', type: 'object', required: true, description: '旧字段名 → 新字段名' },
    ],
    { target: 'dataset://survey.shp', mapping: { gxbh: '更新编号' } },
  ),
  template(
    'recode-encoding',
    '修复属性表编码',
    '解决 DBF 中文乱码（GBK ↔ UTF-8）',
    'vector.recode',
    [
      LAYER(),
      { name: 'from', label: '原编码', type: 'string', required: false, options: ['auto', 'GBK', 'UTF-8', 'LATIN1'] },
      { name: 'to', label: '目标编码', type: 'string', required: true, options: ['GBK', 'UTF-8', 'LATIN1'] },
    ],
    { target: 'dataset://old.shp', from: 'GBK', to: 'UTF-8' },
  ),
  template(
    'repair-geometry',
    '修复几何',
    '修自相交、未闭合环、零面积等几何问题',
    'vector.repairGeometry',
    [
      LAYER(),
      {
        name: 'rules',
        label: '修复规则',
        type: 'stringArray',
        required: false,
        options: ['self-intersection', 'duplicate-vertex', 'ring-orientation', 'unclosed-ring', 'spike', 'collapsed-ring'],
      },
      { name: 'snapTolerance', label: '容差', type: 'number', required: true, description: '过大会吃掉真实缝隙；0 表示不吸附' },
    ],
    { target: 'dataset://land.shp', rules: ['self-intersection'], snapTolerance: 0 },
  ),
  template(
    'clip-by-layer',
    '按图层裁切栅格',
    '用某个图层的范围裁切影像或批量裁切',
    'raster.clip',
    [
      { name: 'inputs', label: '待裁切影像', type: 'string', required: true, description: '单个引用或通配路径，如 batch/*.tif' },
      { name: 'clip', label: '裁切范围', type: 'layerRef', required: true },
      { name: 'mode', label: '保留范围', type: 'string', required: false, options: ['inside', 'outside'] },
    ],
    { inputs: 'dataset://scan.tff', clip: 'dataset://frame.shp', mode: 'inside' },
  ),
  template(
    'replace-region',
    '用另一张图替换指定区域',
    '把某个区域替换成另一期影像或另一图层的同范围内容',
    'raster.replaceRegion',
    [
      { name: 'source', label: '来源图', type: 'layerRef', required: true },
      LAYER(),
      { name: 'region', label: '替换范围', type: 'layerRef', required: false },
      { name: 'bbox', label: '替换范围(坐标)', type: 'bbox', required: false },
      { name: 'featherPx', label: '边缘过渡(像素)', type: 'number', required: false },
    ],
    { source: 'dataset://scan-2024.tff', target: 'dataset://scan-2019.tff', region: 'layer://parcel' },
    (input) => {
      if (input.region === undefined && input.bbox === undefined) {
        throw new TemplateError('replace-region', '必须给出替换范围（region 或 bbox）');
      }
      return {};
    },
  ),
  template(
    'erase-markup',
    '擦除标注色块',
    '把图上误画的填充色块擦掉，露出下面内容',
    'raster.erase',
    [
      LAYER(),
      { name: 'region', label: '要擦除的范围', type: 'layerRef', required: true },
      { name: 'fill', label: '填充方式', type: 'string', required: false, options: ['underlying', 'transparent', 'color'] },
      { name: 'keepAnnotations', label: '保留其它标注', type: 'boolean', required: true, description: '是否保留范围内的其它标注' },
    ],
    { target: 'dataset://scan.tff', region: 'layer://markup', fill: 'underlying', keepAnnotations: false },
  ),
  template(
    'summarize-by-field',
    '分类统计并导出',
    '按字段分组统计数量与面积',
    'feature.summarize',
    [
      LAYER(),
      { name: 'groupBy', label: '分组字段', type: 'stringArray', required: true },
      {
        name: 'aggregates',
        label: '统计项',
        type: 'stringArray',
        required: true,
        options: ['count', 'area', 'length', 'sum', 'mean', 'min', 'max', 'distinct'],
      },
      { name: 'areaUnit', label: '面积单位', type: 'string', required: false, options: ['m2', 'ha', 'mu', 'km2'] },
    ],
    { target: 'dataset://parcel.shp', groupBy: ['用途'], aggregates: ['count', 'area'], areaUnit: 'm2' },
  ),
  template(
    'reproject',
    '坐标系转换',
    '把图层转到另一个坐标系',
    'vector.reproject',
    [
      LAYER(),
      { name: 'to', label: '目标坐标系', type: 'string', required: true, description: '如 EPSG:CGCS2000_3_Degree' },
      { name: 'output', label: '输出文件名', type: 'string', required: false },
    ],
    { target: 'dataset://b.shp', to: 'EPSG:CGCS2000_3_Degree' },
  ),
  template(
    'export-image',
    '导出图片',
    '把指定范围导出成 PNG / PDF 等',
    'export.image',
    [
      LAYER(),
      { name: 'format', label: '格式', type: 'string', required: true, options: ['png', 'jpeg', 'pdf', 'tif'] },
      { name: 'region', label: '导出范围', type: 'layerRef', required: false },
      { name: 'dpi', label: '分辨率', type: 'number', required: false },
    ],
    { target: 'dataset://scan.tff', format: 'png', dpi: 300 },
  ),
];
