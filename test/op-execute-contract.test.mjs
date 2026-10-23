/**
 * `/api/op/execute` 也必须过契约（闸门①）。
 *
 * 2026-10-23 实测的洞：
 *   闸门①（validatePlanSchema + findUnsupportedOps）只挂在 `/api/llm/plan` 上，
 *   `/api/op/execute` 是 `normalizePlan → prepareOps → executePlan`，全程无契约校验。
 *   也就是说：一份过不了闸门①的计划，只要直接打这个端点就能执行。
 *
 * 这里用**同一个**校验器（服务端 llm-plan.ts 里的 checkPlanAgainstContract），
 * 不另写一套 —— 两套校验器各说各话，测出来的「绿」是假的。
 *
 * 本文件里造出来的栅格（16×12 三波段、像元值由公式生成）**是构造数据**，
 * 不对应任何真实数据。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listenSafe } from './helpers/listen-safe.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 环境变量必须在导入 app.ts **之前**设好：
 * app.ts 在模块加载时就确定了工作区根，roots.ts 也在加载时读配置目录。 */
const wsRoot = await mkdtemp(join(tmpdir(), 'cartouche-exec-contract-ws-'));
const cfgRoot = await mkdtemp(join(tmpdir(), 'cartouche-exec-contract-cfg-'));
process.env.ENGINE_WORKSPACE_ROOT = wsRoot;
process.env.CARTOUCHE_CONFIG_DIR = cfgRoot;

const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
const { tools } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'runner.ts')).href);
const { createEngineServer } = await import(pathToFileURL(join(root, 'server', 'src', 'app.ts')).href);

const loc = resolveGdal();
const gdal = tools(loc);

/** 造一张 16x12 的三波段影像（构造数据） */
async function makeRaster(dir, name) {
  const w = 16, h = 12, bands = 3;
  const raw = new Uint8Array(w * h * bands);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let b = 0; b < bands; b++) {
        raw[(y * w + x) * bands + b] = (x * 7 + y * 3 + b * 40 + 11) % 200;
      }
    }
  }
  const bin = join(dir, `${name}.bin`);
  const hdr = join(dir, `${name}.hdr`);
  await writeFile(bin, raw);
  await writeFile(
    hdr,
    [
      'ENVI',
      `samples = ${w}`,
      `lines   = ${h}`,
      `bands   = ${bands}`,
      'header offset = 0',
      'file type = ENVI Standard',
      'data type = 1',
      'interleave = bip',
      'byte order = 0',
      '',
    ].join('\n'),
    'utf8',
  );
  const tif = join(dir, `${name}.tif`);
  await gdal.translate([
    '-of', 'GTiff',
    '-a_srs', 'EPSG:4326',
    '-a_ullr', '120.30', '30.532', '120.316', '30.52',
    bin, tif,
  ]);
  return tif;
}

let server = null;
let base = '';
let targetFile = '';

before(async () => {
  targetFile = await makeRaster(wsRoot, 'target');
  server = createEngineServer();
  const port = await listenSafe(server);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await rm(wsRoot, { recursive: true, force: true });
  await rm(cfgRoot, { recursive: true, force: true });
});

async function postExecute(body) {
  const res = await fetch(`${base}/api/op/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** 目录里有没有备份文件 */
async function backupsOf(dir) {
  const entries = await readdir(dir);
  return entries.filter((n) => n.includes('.bak.'));
}

test('过不了闸门①的计划打 /api/op/execute → 400，且没有任何写盘副作用', async () => {
  const before = await readFile(targetFile);
  const backupsBefore = await backupsOf(wsRoot);

  // region 与 color 都不给 —— 契约里这两个是必填
  const { status, json } = await postExecute({
    plan: {
      version: '1.0',
      ops: [{ op: 'raster.paint', params: { target: 'dataset://target.tif' } }],
    },
    projectRoot: wsRoot,
    confirmed: true,
  });

  assert.equal(status, 400, '不合契约的计划必须 400');
  assert.equal(json?.error, 'bad_request');
  assert.match(json?.message ?? '', /契约/, '报错要说清是契约问题');
  assert.ok((json?.schemaIssues ?? []).length > 0, '要把不合契约的地方列出来');

  // 关键：**一个字节都不许写**
  const after = await readFile(targetFile);
  assert.deepEqual(after, before, '目标文件必须一个字节都不动');
  assert.deepEqual(await backupsOf(wsRoot), backupsBefore, '不该生成备份');
});

test('引擎还没实现的 op 打 /api/op/execute → 400（不是执行了才说没实现）', async () => {
  const { status, json } = await postExecute({
    plan: {
      version: '1.0',
      ops: [
        {
          // 用**仍未实现**的那个 op（feature.create / feature.editGeometry /
          // vector.overlay / vector.repairGeometry 还没做）。
          // 早先这里用的是 feature.setAttributes —— 它 2026-10-24 起已经实现了，
          // 拿它当"还没实现"的例子，这条测试就变成了假绿。
          op: 'feature.create',
          params: { target: 'layer://survey.shp', geometry: { type: 'Point', coordinates: [1, 2] } },
        },
      ],
    },
    projectRoot: wsRoot,
    confirmed: true,
  });
  assert.equal(status, 400);
  assert.match(json?.message ?? '', /尚未支持/);
  assert.ok((json?.unsupported ?? []).length > 0, '要把没实现的 op 列出来');
});

test('绝对路径目标打 /api/op/execute → 400（不许借它逃出工作区）', async () => {
  const { status } = await postExecute({
    op: 'raster.paint',
    params: {
      target: 'C:/Windows/System32/drivers/etc/hosts',
      region: { minX: 0, minY: 0, maxX: 2, maxY: 2 },
      color: '#00FF00',
    },
    projectRoot: wsRoot,
    confirmed: true,
  });
  assert.equal(status, 400);
});

test('合法的计划照常执行（闸门别把正常流程堵死）', async () => {
  const { status, json } = await postExecute({
    op: 'raster.paint',
    params: {
      target: 'target.tif',
      region: { minX: 2, minY: 2, maxX: 6, maxY: 6 },
      color: '#00FF00',
    },
    projectRoot: wsRoot,
    confirmed: true,
  });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json?.ok, true, JSON.stringify(json));
  assert.equal(json?.completed, 1);
  assert.ok(json?.results?.[0]?.impact?.affectedPixels > 0, '要报出真实的影响像元数');
});

test('requireUserConfirm：没确认就不许动手，确认了就照常执行', async () => {
  // 造一张新的目标文件，避免上一条测试已经改过它
  const file = await makeRaster(wsRoot, 'confirm-target');
  const before = await readFile(file);

  const denied = await postExecute({
    plan: {
      version: '1.0',
      ops: [
        {
          op: 'raster.paint',
          params: {
            target: 'dataset://confirm-target.tif',
            region: { minX: 1, minY: 1, maxX: 4, maxY: 4 },
            color: '#00FF00',
          },
          requireUserConfirm: true,
        },
      ],
    },
    projectRoot: wsRoot,
  });
  assert.equal(denied.json?.ok, false, '没确认就不该执行成功');
  assert.match(denied.json?.results?.[0]?.error ?? '', /人工确认/, '要说清是缺确认');
  assert.deepEqual(await readFile(file), before, '没确认时文件必须一个字节都不动');

  const allowed = await postExecute({
    plan: {
      version: '1.0',
      ops: [
        {
          op: 'raster.paint',
          params: {
            target: 'dataset://confirm-target.tif',
            region: { minX: 1, minY: 1, maxX: 4, maxY: 4 },
            color: '#00FF00',
          },
          requireUserConfirm: true,
        },
      ],
    },
    projectRoot: wsRoot,
    confirmed: true,
  });
  assert.equal(allowed.json?.ok, true, JSON.stringify(allowed.json));
  assert.equal(allowed.json?.completed, 1);
  assert.notDeepEqual(await readFile(file), before, '确认后必须真的改到文件');
});
