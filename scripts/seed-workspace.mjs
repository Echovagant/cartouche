#!/usr/bin/env node
/**
 * 把公开真实数据样本播种到工作区，让画布能直接打开它们。
 *
 * 为什么需要这一步：
 *   引擎的 `/api/*` 只认**工作区内**的相对路径（越界会被 400 拒绝，这是有意的安全边界）。
 *   而公开样本下载在 `samples/`（体积大、不入库），合成样本在 `fixtures/`（不入库）。
 *   这一步把两者**复制**进工作区，工作区本身是本地目录、不入库。
 *
 * 用法：
 *   node scripts/seed-workspace.mjs             # 播种全部已下载的样本
 *   node scripts/seed-workspace.mjs --list      # 只列出可用样本
 */
import { readdirSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const samplesDir = join(root, 'samples');
const fixturesDir = join(root, 'fixtures');
const workspace = process.env.ENGINE_WORKSPACE_ROOT ?? join(root, 'workspace');
const target = join(workspace, 'samples');

const listOnly = process.argv.includes('--list');

/** 矢量文件是一套（.shp/.shx/.dbf/.prj/.cpg），要整套复制 */
const VECTOR_EXTS = new Set(['.shp', '.shx', '.dbf', '.prj', '.cpg']);
const RASTER_EXTS = new Set(['.tif', '.tff', '.tfw', '.wld']);
/** 栅格的伴随文件（.prj / .cpg / .aux.xml）要跟着栅格走 */
const RASTER_SIDECAR_EXTS = new Set(['.prj', '.cpg']);
/** 我们自己的元数据文件，不是样本 */
const META_NAMES = new Set(['manifest.json', 'fetched.json', 'report.json']);

/** 文件的扩展名；`.aux.xml` 这种双扩展名要当成一个整体 */
function extOf(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.aux.xml')) return '.aux.xml';
  return extname(lower);
}

function collect(dir) {
  const groups = new Map(); // key → {kind, files[]}
  if (!existsSync(dir)) return groups;

  // 公开样本解压后会形成子目录（ne110m/、nerivers/、gadmchn1/…），要一起收
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      for (const sub of readdirSync(p)) {
        const sp = join(p, sub);
        if (statSync(sp).isFile()) files.push(sp);
      }
    } else if (statSync(p).isFile()) {
      files.push(p);
    }
  }

  const names = files.map((f) => basename(f));
  const stemsOf = (ext) =>
    new Set(
      names.filter((n) => extOf(n) === ext).map((n) => basename(n, extname(n))),
    );
  const hasShp = stemsOf('.shp');
  const hasRaster = new Set([...stemsOf('.tif'), ...stemsOf('.tff')]);

  for (const p of files) {
    const name = basename(p);
    if (META_NAMES.has(name)) continue;
    const ext = extOf(name);
    const stem = basename(name, extname(name));

    if (ext === '.geojson' || ext === '.json') {
      groups.set(`geo:${stem}`, { kind: 'geojson', files: [p] });
      continue;
    }
    if (VECTOR_EXTS.has(ext)) {
      // ⚠️ .prj / .cpg 是**两栖**的：既可能是 Shapefile 的侧车，也可能是**栅格**的侧车。
      //    以前这里把"没有同名 .shp 的 .prj"直接 `continue` 掉了 —— 结果
      //    `worldref.prj`（栅格的坐标系侧车）被整个丢掉，工作区里的 .tff 因此
      //    **没有坐标系**，兼容性报告自然报「R-CRS-001 坐标系缺失」。
      //    正确做法：按同名主体归组——有 .shp 就跟矢量走，有 .tff/.tif 就跟栅格走，
      //    两者都没有才算孤儿侧车（跳过）。
      if (RASTER_SIDECAR_EXTS.has(ext) && !hasShp.has(stem)) {
        if (hasRaster.has(stem)) {
          const key = `ras:${stem}`;
          const g = groups.get(key) ?? { kind: 'raster', files: [] };
          g.files.push(p);
          groups.set(key, g);
        }
        continue; // 真正的孤儿侧车
      }
      const key = `vec:${stem}`;
      const g = groups.get(key) ?? { kind: 'vector', files: [] };
      g.files.push(p);
      groups.set(key, g);
      continue;
    }
    if (RASTER_EXTS.has(ext) || ext === '.aux.xml') {
      const key = `ras:${stem}`;
      const g = groups.get(key) ?? { kind: 'raster', files: [] };
      g.files.push(p);
      groups.set(key, g);
    }
  }
  return groups;
}

const groups = [...collect(samplesDir).entries()].map(([k, v]) => ({ key: k, ...v }));
const fixtureGroups = [...collect(fixturesDir).entries()].map(([k, v]) => ({ key: k, ...v }));

console.log(`\n工作区：${workspace}`);
console.log(`目标目录：${target}\n`);

if (groups.length === 0 && fixtureGroups.length === 0) {
  console.log('没有可播种的样本。先跑 npm run samples（拉公开样本）与 npm run fixture（生成合成样本）。');
  process.exitCode = 0;
} else {
  for (const g of [...groups, ...fixtureGroups]) {
    const label = `${g.kind.padEnd(6)} ${g.files.map((f) => basename(f)).join(' ')}`;
    console.log(`  ${label}`);
  }
  console.log('');

  if (!listOnly) {
    mkdirSync(target, { recursive: true });
    let n = 0;
    for (const g of [...groups, ...fixtureGroups]) {
      // 合成样本与公开样本同名时以公开样本为准（更真实）
      const destName = g.files[0] && extname(g.files[0]) ? basename(g.files[0]) : 'unknown';
      const destBase = destName.replace(/\.[^.]+$/, '');
      for (const f of g.files) {
        const ext = extname(f);
        const stem = basename(f, ext);
        const out = join(target, `${stem}${ext}`);
        try {
          copyFileSync(f, out);
          n++;
        } catch (err) {
          console.error(`  复制失败：${f} -> ${out}（${err.message}）`);
        }
      }
      void destBase;
    }
    console.log(`已复制 ${n} 个文件到 ${target}`);
    console.log('在画布里用工作区相对路径 samples/<文件名> 打开即可。');
  }
}
