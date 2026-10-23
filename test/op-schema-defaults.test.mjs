/**
 * 契约里声明的 `default` 必须真的生效。
 *
 * 2026-10-23 实测的洞：
 *   校验器（validateNode）实现的是 required / allOf / type / enum 这些**约束**，
 *   不实现 JSON Schema 的 `default`（那是"缺省时该取什么值"的注解）。
 *   于是 `ops.schema.json` 里写着
 *     "requireUserConfirm": { "type": "boolean", "default": true }
 *   而引擎按「没写就不拦」执行 —— **契约与行为不同向**，
 *   而这条恰好是删除 / 重命名这类破坏性操作的安全网。
 *   同一个毛病也让「声明了 default 又列进 required」的字段自相矛盾：
 *   缺了就该报错，可它明明有缺省值。
 *
 * 修法：归一化时把契约声明的 default 补进计划（applySchemaDefaults）。
 * 注入的值与引擎自己的缺省逐个核对过（brightness 0 / contrast 1 /
 * method linear-stretch / gamma 2.2 / radiusPx 4 / featherPx 0），
 * 所以对已实现的 8 个栅格 op 是**行为不变**的。
 *
 * 本文件不造栅格，用的是纯计划对象。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 环境变量必须在导入之前设好（服务端模块加载时就会读配置目录）。 */
process.env.ENGINE_WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), 'cartouche-defaults-ws-'));
process.env.CARTOUCHE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cartouche-defaults-cfg-'));

const { applySchemaDefaults, checkPlanAgainstContract } = await import(
  pathToFileURL(join(root, 'server', 'src', 'llm-plan.ts')).href
);

test('缺省的 requireUserConfirm 必须按契约补成 true（破坏性操作的安全网）', () => {
  const plan = {
    version: '1.0',
    ops: [{ op: 'feature.delete', params: { target: 'dataset://a.shp', where: { id: 1 } } }],
  };
  const out = applySchemaDefaults(plan);
  // requireUserConfirm 声明在 operation 层（与 op / params 平级），不在 params 里
  assert.equal(out.ops[0].requireUserConfirm, true, '契约声明 default: true，缺省就该是 true');
  // 原对象不能被就地改（归一化必须返回新对象）
  assert.equal(plan.ops[0].requireUserConfirm, undefined, '不能就地改调用方的对象');
});

test('缺省值与引擎自己的缺省一致（对已实现的栅格 op 是行为不变的）', () => {
  const plan = {
    version: '1.0',
    ops: [{ op: 'raster.adjustLevels', params: { target: 'dataset://a.tff' } }],
  };
  const p = applySchemaDefaults(plan).ops[0].params;
  assert.equal(p.brightness, 0);
  assert.equal(p.contrast, 1);
  assert.equal(p.method, 'linear-stretch');
  assert.equal(p.gamma, 2.2);
});

test('显式写了值的参数不被默认值覆盖', () => {
  const plan = {
    version: '1.0',
    ops: [
      { op: 'raster.adjustLevels', params: { target: 'dataset://a.tff', brightness: 0.3, contrast: 1.8, method: 'gamma', gamma: 1.4 } },
    ],
  };
  const p = applySchemaDefaults(plan).ops[0].params;
  assert.equal(p.brightness, 0.3);
  assert.equal(p.contrast, 1.8);
  assert.equal(p.method, 'gamma');
  assert.equal(p.gamma, 1.4);
});

test('补完缺省之后，闸门①仍然通过（缺省不能把正常计划打死）', () => {
  const plan = {
    version: '1.0',
    ops: [{ op: 'raster.adjustLevels', params: { target: 'dataset://a.tff' } }],
  };
  const gate = checkPlanAgainstContract(plan);
  assert.deepEqual(gate.schemaIssues, [], '补完缺省后不该有契约问题');
});

test('契约没声明 default 的属性不会被凭空加进来', () => {
  const plan = {
    version: '1.0',
    ops: [{ op: 'raster.paint', params: { target: 'dataset://a.tff', region: [0, 0, 4, 4], color: '#00FF00' } }],
  };
  const p = applySchemaDefaults(plan).ops[0].params;
  assert.equal(p.requireUserConfirm, undefined, 'paint 的契约里没有这个属性，不该被塞进来');
});
