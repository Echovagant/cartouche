#!/usr/bin/env node
/**
 * 操作计划契约静态检查：确认 ops.schema.json 可解析、操作清单完整，并校验一份示例计划的关键字段。
 * 用法：node scripts/check-schema.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(root, 'src/engine/ops.schema.json'), 'utf8'));
const ops = schema.$defs.operation.properties.op.enum;

const OK = '\x1b[32m●\x1b[0m';
const BAD = '\x1b[31m■\x1b[0m';
const DIM = '\x1b[90m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

console.log(`\n${BOLD}操作计划契约 (Operation Plan) 自检${RESET}\n`);
console.log(`  ${OK} ops.schema.json 可解析`);
console.log(`  ${OK} 声明 ${ops.length} 个操作：`);
for (const op of ops) console.log(`       ${DIM}·${RESET} ${op}`);

// 必填操作是否齐全 —— 这些是 AI 基准要用到的最小集合
const required = ['dataset.open', 'dataset.healthCheck', 'raster.replaceRegion', 'feature.setAttributes', 'feature.editGeometry', 'vector.repairGeometry', 'vector.query', 'vector.addField', 'vector.spatialJoin'];
const missing = required.filter((r) => !ops.includes(r));
if (missing.length === 0) {
  console.log(`  ${OK} 核心操作集齐全（${required.length} 项）`);
} else {
  console.log(`  ${BAD} 缺少核心操作：${missing.join(', ')}`);
}

// 校验一份示例计划的结构（不做完整 JSON Schema 校验，只校验必填与枚举）
const sample = {
  version: '1.0',
  intent: '把 2024 底图对应区域替换到当前图件',
  ops: [
    {
      op: 'raster.replaceRegion',
      params: {
        source: 'dataset://scan-2024.tff',
        target: 'dataset://current.tff',
        bbox: [120.3, 30.52, 120.32, 30.54],
        featherPx: 8,
      },
      preconditions: { crsEqual: true, sourceExists: true },
      expect: { maxAffectedPixels: 500000 },
    },
  ],
};

const plan = sample.ops[0];
const checks = [
  ['version 固定为 1.0', sample.version === schema.properties.version.const],
  ['op 在枚举内', ops.includes(plan.op)],
  ['params 必填字段齐全', ['source', 'target', 'bbox'].every((k) => k in plan.params)],
  ['bbox 为 4 元数值数组', Array.isArray(plan.params.bbox) && plan.params.bbox.length === 4 && plan.params.bbox.every((n) => typeof n === 'number')],
  ['路径引用形如 dataset://（引擎只认这一种）', ['source', 'target'].every((k) => /^dataset:\/\/.+/.test(plan.params[k]))],
  ['preconditions 含 crsEqual', 'crsEqual' in plan.preconditions],
  ['expect 含影响上限', 'maxAffectedPixels' in plan.expect],
];
for (const [name, ok] of checks) {
  console.log(`  ${ok ? OK : BAD} 示例计划：${name}`);
}
const allOk = missing.length === 0 && checks.every(([, ok]) => ok);
console.log(`\n  ${allOk ? OK : BAD} 契约自检${allOk ? '通过' : '未通过'}${RESET}\n`);
process.exit(allOk ? 0 : 1);
