#!/usr/bin/env node
/**
 * 准备便携包自带的**教学示例数据**。
 *
 * 为什么要有这一步：
 *   上一版便携包双击打开就是一块空白画布。对不懂技术的人来说，
 *   空画布和"软件坏了"长得一模一样 —— 分不清"还没加载"与"不能用"，
 *   第一次体验就废了。带一份能立刻点开的公开数据，新用户第一眼就知道这东西是活的。
 *
 * 数据从哪来：
 *   Natural Earth 的 50m 比例尺**物理**图层（陆地 / 海洋 / 海岸线 / 湖泊 /
 *   河湖中心线 / 城市点位）与 50m 灰度地形晕渲栅格。
 *   Natural Earth 的矢量与栅格数据全部是**公共领域**（Public Domain），
 *   可自由使用、可商用、无需署名 —— 但我们仍然在 README.txt 里写明出处，
 *   因为"可商用"不等于"不用说明来源"。
 *
 * 为什么在**打包时**准备，而不是把数据提交进仓库：
 *   ① 第三方数据受自己的许可约束，不该混进本仓库的许可体系；
 *   ② 二十几 MB 的二进制躺在 git 历史里，谁都删不掉；
 *   ③ 下载源偶尔抽风 —— 本地缓存 + 可重跑，比"祈祷 CDN 活着"可靠。
 *
 * 产物落在 release/ 下（已被 .gitignore 排除），不进版本库。
 *
 * 用法：
 *   node scripts/prepare-portable-samples.mjs
 *   node scripts/prepare-portable-samples.mjs --gdal-bin "<GDAL 的 bin 目录>"
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGdalBin, runTool } from './lib/env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 下载缓存：原始 zip 与解压结果放这里，重跑时不重复下载 */
const CACHE_DIR = join(root, 'release', '.cache', 'portable-samples');

/** 打包暂存区：pack-portable.mjs 从这里把示例数据装进 zip */
const STAGE_DIR = join(root, 'release', 'portable-stage');

/** 包内与工作区里的示例数据目录名（中文，顺便覆盖中文路径这一场景） */
export const SAMPLE_DIR_NAME = '示例数据';

/** 示例数据总预算（MB）。超了就是准备脚本没控制住，不该让它悄悄涨。 */
const SIZE_BUDGET_MB = 30;

const NE_BASE = 'https://naciscdn.org/naturalearth';

/**
 * 要进包的矢量层。
 *
 * 全部取 50m 比例尺：10m 的河流细节更好，但整个示例集会翻两倍，
 * 而教学场景要的是"打开就快"，不是"细节最多"。
 *
 * `keep` 列出随图层一起进包的侧车文件：Shapefile 是一套文件，
 * 少一个 .dbf 就没属性、少一个 .prj 就没坐标系。
 * `select` 非空表示**只保留这些字段**（用于去掉与教学无关的行政字段）。
 */
const VECTOR_LAYERS = [
  {
    id: 'ne_50m_land',
    url: `${NE_BASE}/50m/physical/ne_50m_land.zip`,
    group: '陆地与海洋',
    title: '陆地',
    kind: '面',
    desc: '全球陆地轮廓，多边形。适合试：面填充、简化、裁切。',
    keep: ['.shp', '.shx', '.dbf', '.prj', '.cpg'],
  },
  {
    id: 'ne_50m_ocean',
    url: `${NE_BASE}/50m/physical/ne_50m_ocean.zip`,
    group: '陆地与海洋',
    title: '海洋',
    kind: '面',
    desc: '全球海洋范围，多边形。适合试：与陆地对叠、按图层顺序控制压盖。',
    keep: ['.shp', '.shx', '.dbf', '.prj', '.cpg'],
  },
  {
    id: 'ne_50m_coastline',
    url: `${NE_BASE}/50m/physical/ne_50m_coastline.zip`,
    group: '陆地与海洋',
    title: '海岸线',
    kind: '线',
    desc: '陆地与海洋的分界线。适合试：线宽、线型、描边、缓冲。',
    keep: ['.shp', '.shx', '.dbf', '.prj', '.cpg'],
  },
  {
    id: 'ne_50m_lakes',
    url: `${NE_BASE}/50m/physical/ne_50m_lakes.zip`,
    group: '河流与湖泊',
    title: '湖泊',
    kind: '面',
    desc: '全球主要湖泊，多边形。适合试：按面积分级设色。',
    keep: ['.shp', '.shx', '.dbf', '.prj', '.cpg'],
  },
  {
    id: 'ne_50m_rivers_lake_centerlines',
    url: `${NE_BASE}/50m/physical/ne_50m_rivers_lake_centerlines.zip`,
    group: '河流与湖泊',
    title: '河流与湖泊中心线',
    kind: '线',
    desc: '河网中心线，线条极细长且多段。适合试：线要素选择、节点捕捉、抽稀。',
    keep: ['.shp', '.shx', '.dbf', '.prj', '.cpg'],
  },
  {
    id: 'ne_50m_populated_places_simple',
    url: `${NE_BASE}/50m/cultural/ne_50m_populated_places_simple.zip`,
    group: '城市点位',
    title: '城市点位',
    kind: '点',
    desc: '世界主要城市位置与人口规模。适合试：点符号、按人口分级、属性表浏览。',
    keep: ['.shp', '.shx', '.dbf', '.prj', '.cpg'],
    // 只留"这个城市在哪、多大"这类与教学有关的字段；
    // 行政归属、主权一类的字段与教学无关，还会把无关内容带进包里。
    select: 'scalerank,natscale,labelrank,featurecla,name,nameascii,worldcity,megacity,latitude,longitude,pop_max,pop_min',
  },
];

/** 栅格层：灰度地形晕渲（50m）。压成 DEFLATE 后约 9 MB。 */
const RASTER_LAYER = {
  id: 'GRAY_50M_SR_W',
  url: `${NE_BASE}/50m/raster/GRAY_50M_SR_W.zip`,
  group: '地形晕渲',
  title: '灰度地形晕渲',
  kind: '栅格',
  desc: '全球灰度地形晕渲，10800×5400，8 位灰度，WGS 84。适合试：出图、像素查询、重采样、拼接。',
  // 随栅格一起走的侧车：世界文件（定位）与坐标系定义
  sidecars: ['.tfw', '.prj'],
};

/**
 * 敏感词闸门用的词表（**字节**形式，不是字符串）。
 *
 * 为什么存字节而不是直接写字：
 *   ① 这些词串本身不该出现在本仓库的任何文件里（包括这个脚本）；
 *   ② 数据里的中文可能是 UTF-8，也可能是 GBK（本仓库的合成样本里就有 GBK 的
 *      Shapefile），只按一种编码去比，另一种编码下的命中就漏了。
 *      两种编码的字节都存下来，按字节找，两种都拦得住。
 *
 * g = GBK（代码页 936）字节；u = UTF-8 字节。
 * label 只写码点：报告里要说清是哪一条，但不必把词本身打出来。
 *
 * 覆盖范围：数据内容、字段名、图层名、文件夹名与文件名。
 */
const FORBIDDEN_BYTE_PATTERNS = [
  { label: 'U+519B', g: [0xbe, 0xfc], u: [0xe5, 0x86, 0x9b] },
  { label: 'U+5175 U+56E2', g: [0xb1, 0xf8, 0xcd, 0xc5], u: [0xe5, 0x85, 0xb5, 0xe5, 0x9b, 0xa2] },
  { label: 'U+90E8 U+961F', g: [0xb2, 0xbf, 0xb6, 0xd3], u: [0xe9, 0x83, 0xa8, 0xe9, 0x98, 0x9f] },
  { label: 'U+8D77 U+4E49', g: [0xc6, 0xf0, 0xd2, 0xe5], u: [0xe8, 0xb5, 0xb7, 0xe4, 0xb9, 0x89] },
  { label: 'U+6218 U+5F79', g: [0xd5, 0xbd, 0xd2, 0xdb], u: [0xe6, 0x88, 0x98, 0xe5, 0xbd, 0xb9] },
  { label: 'U+4F1A U+6218', g: [0xbb, 0xe1, 0xd5, 0xbd], u: [0xe4, 0xbc, 0x9a, 0xe6, 0x88, 0x98] },
  { label: 'U+6218 U+4E89', g: [0xd5, 0xbd, 0xd5, 0xf9], u: [0xe6, 0x88, 0x98, 0xe4, 0xba, 0x89] },
  { label: 'U+56F4 U+527F', g: [0xce, 0xa7, 0xbd, 0xcb], u: [0xe5, 0x9b, 0xb4, 0xe5, 0x89, 0xbf] },
  { label: 'U+654C U+540E', g: [0xb5, 0xd0, 0xba, 0xf3], u: [0xe6, 0x95, 0x8c, 0xe5, 0x90, 0x8e] },
  { label: 'U+6297 U+65E5', g: [0xbf, 0xb9, 0xc8, 0xd5], u: [0xe6, 0x8a, 0x97, 0xe6, 0x97, 0xa5] },
  { label: 'U+89E3 U+653E U+6218 U+4E89', g: [0xbd, 0xe2, 0xb7, 0xc5, 0xd5, 0xbd, 0xd5, 0xf9], u: [0xe8, 0xa7, 0xa3, 0xe6, 0x94, 0xbe, 0xe6, 0x88, 0x98, 0xe4, 0xba, 0x89] },
  { label: 'U+89E3 U+653E U+533A', g: [0xbd, 0xe2, 0xb7, 0xc5, 0xc7, 0xf8], u: [0xe8, 0xa7, 0xa3, 0xe6, 0x94, 0xbe, 0xe5, 0x8c, 0xba] },
  { label: 'U+5185 U+6218', g: [0xc4, 0xda, 0xd5, 0xbd], u: [0xe5, 0x86, 0x85, 0xe6, 0x88, 0x98] },
  { label: 'U+8C0D', g: [0xb5, 0xfd], u: [0xe8, 0xb0, 0x8d] },
  { label: 'U+9605 U+5175', g: [0xd4, 0xc4, 0xb1, 0xf8], u: [0xe9, 0x98, 0x85, 0xe5, 0x85, 0xb5] },
  { label: 'U+527F', g: [0xbd, 0xcb], u: [0xe5, 0x89, 0xbf] },
  { label: 'U+5BC6 U+7EA7', g: [0xc3, 0xdc, 0xbc, 0xb6], u: [0xe5, 0xaf, 0x86, 0xe7, 0xba, 0xa7] },
  { label: 'U+673A U+5BC6', g: [0xbb, 0xfa, 0xc3, 0xdc], u: [0xe6, 0x9c, 0xba, 0xe5, 0xaf, 0x86] },
  { label: 'U+7EDD U+5BC6', g: [0xbe, 0xf8, 0xc3, 0xdc], u: [0xe7, 0xbb, 0x9d, 0xe5, 0xaf, 0x86] },
  { label: 'U+6D89 U+5BC6', g: [0xc9, 0xe6, 0xc3, 0xdc], u: [0xe6, 0xb6, 0x89, 0xe5, 0xaf, 0x86] },
  { label: 'U+79D8 U+5BC6', g: [0xc3, 0xd8, 0xc3, 0xdc], u: [0xe7, 0xa7, 0x98, 0xe5, 0xaf, 0x86] },
];

/* ── 下载与解压 ─────────────────────────────────────────────────── */

function argOf(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function download(url, dest) {
  if (existsSync(dest)) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  console.log(`  下载 ${url}`);

  // 重试三次：CDN 与本机 DNS 都会偶发抽风，一次失败不该毁掉整个构建。
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // 少于 1 KB 一定是拿到了错误页而不是数据 —— 宁可失败也别把错误页装进包里
      if (buf.length < 1024) throw new Error(`结果只有 ${buf.length} 字节，多半被拦截`);
      writeFileSync(dest, buf);
      return dest;
    } catch (err) {
      lastErr = err;
      console.log(`  第 ${attempt} 次失败（${err.message}）`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  throw new Error(`下载失败（重试 3 次）：${url} —— ${lastErr?.message ?? '未知原因'}`);
}

/**
 * 解压 zip。
 *
 * 用 Windows 自带的 Expand-Archive：仓库里既有的取样脚本也是这么解的，
 * 不引入新的工具依赖。
 */
function unzip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force`,
    ],
    { stdio: 'inherit' },
  );
}

/* ── DBF 解析（闸门要用：不靠 ogrinfo 也能读字段名与文本值） ────── */

/**
 * 读一个 dBASE 文件的字段定义与文本字段内容。
 *
 * 为什么要自己解析：闸门要在**不启动 GDAL** 的前提下也能跑（打包机上
 * GDAL 偶尔不可用时，示例数据仍应能被检查）。dBASE 的头是定长结构，读起来很短。
 *
 * 返回的是**原始字节**而不是解码后的字符串：DBF 的编码由旁边的 .cpg 决定，
 * 可能是 UTF-8 也可能是 GBK（本仓库的合成样本里就有 GBK 的），
 * 闸门要对两种编码都成立，就不能在这里替它选一种。
 *
 * @param {Buffer} buf
 * @returns {{fields: {name: string, type: string, length: number, nameBytes: Buffer}[],
 *            records: Buffer[][]}} records 里是各字符串字段的原始字节
 */
function parseDbf(buf) {
  const recordCount = buf.readUInt32LE(4);
  const headerLength = buf.readUInt16LE(8);
  const recordLength = buf.readUInt16LE(10);

  const fields = [];
  let offset = 32;
  while (offset < headerLength - 1) {
    const rawName = buf.subarray(offset, offset + 11);
    const zero = rawName.indexOf(0);
    const name = rawName.subarray(0, zero === -1 ? 11 : zero).toString('latin1').trim();
    const type = String.fromCharCode(buf[offset + 11]);
    const length = buf[offset + 16];
    fields.push({ name, type, length, nameBytes: rawName.subarray(0, zero === -1 ? 11 : zero) });
    offset += 32;
  }

  const records = [];
  let pos = headerLength;
  for (let i = 0; i < recordCount && pos + recordLength <= buf.length; i++) {
    // 每条记录第一个字节是删除标志：'*' 表示已删除，跳过
    const deleted = buf[pos] === 0x2a;
    let cursor = pos + 1;
    const values = [];
    for (const f of fields) {
      const raw = buf.subarray(cursor, cursor + f.length);
      values.push(f.type === 'C' ? raw : Buffer.alloc(0));
      cursor += f.length;
    }
    if (!deleted) records.push(values);
    pos += recordLength;
  }
  return { fields, records };
}

/* ── 敏感词闸门 ─────────────────────────────────────────────────── */

/**
 * 扫一遍打包出去的数据，任何一处命中就拒绝出包。
 *
 * 为什么是硬闸门而不是提醒：这类内容一旦进了 zip 就已经扩散了，
 * 事后补救的成本远高于构建时直接失败。
 *
 * @param {string} dir 待检查目录
 * @returns {{file: string, where: string, term: string}[]} 命中项
 */
export function scanForbidden(dir) {
  const hits = [];

  /** 在字节序列里找一段模式 */
  const containsBytes = (haystack, needle) => {
    if (needle.length === 0 || haystack.length < needle.length) return false;
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
      for (let k = 0; k < needle.length; k++) {
        if (haystack[i + k] !== needle[k]) continue outer;
      }
      return true;
    }
    return false;
  };

  /** 一段字节里有没有命中任一词条（UTF-8 与 GBK 两种编码都试） */
  const checkBytes = (bytes, where, file) => {
    for (const p of FORBIDDEN_BYTE_PATTERNS) {
      if (containsBytes(bytes, p.g) || containsBytes(bytes, p.u)) {
        hits.push({ file, where, term: p.label });
      }
    }
  };

  // 1. 文件名与文件夹名（文件系统给的是字符串，按 UTF-8 编码成字节再比）
  const walkNames = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      checkBytes(Buffer.from(entry.name, 'utf8'), '文件名', entry.name);
      if (entry.isDirectory()) walkNames(join(d, entry.name));
    }
  };
  walkNames(dir);

  // 2. 字段名与文本属性值（dbf）、整份内容（geojson）
  const walkContent = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        walkContent(p);
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (ext === '.dbf') {
        let parsed;
        try {
          parsed = parseDbf(readFileSync(p));
        } catch {
          continue;
        }
        for (const f of parsed.fields) {
          checkBytes(f.nameBytes, `字段名 ${f.name}`, entry.name);
        }
        for (const rec of parsed.records) {
          for (const v of rec) {
            checkBytes(v, '属性值', entry.name);
          }
        }
      } else if (ext === '.geojson') {
        checkBytes(readFileSync(p), '内容', entry.name);
      }
    }
  };
  walkContent(dir);

  return hits;
}

/* ── README.txt（交给最终用户看的那一份） ───────────────────────── */

function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/**
 * 生成示例数据自带的说明。
 *
 * 写给**不懂技术的人**：先说"这是什么、能拿它试什么"，再说来源与许可。
 * 一份只列文件名的清单没人会用。
 */
function buildReadme(layers, rasterInfo, files) {
  const total = files.reduce((a, f) => a + f.size, 0);
  const lines = [];
  lines.push('图签 Cartouche · 示例数据');
lines.push('='.repeat(60));
lines.push('');
  lines.push('这些数据是**给你练手用的**，不是你的正式成果。');
  lines.push('它们全部来自 Natural Earth（公开的免费地图数据），');
  lines.push('属于公共领域（Public Domain），可自由使用、可商用。');
  lines.push('');
  lines.push('怎么打开：');
  lines.push('  1. 双击便携包根目录的 START.cmd，等画布自己打开；');
  lines.push('  2. 画布第一屏是「打开一个项目」——把**工作区路径**填进去，');
  lines.push('     点「登记并新建」。工作区路径就是 START.cmd 窗口里那一行');
  lines.push('     「工作区 : …」显示的路径，照抄即可；');
  lines.push('  3. 左侧「工作区文件」里点「示例数据」进入，再点「陆地与海洋」进入；');
  lines.push('  4. 找到 ne_50m_land.shp，点它右边的「加载」，地图就出来了。');
  lines.push('');
  lines.push('  路径都是相对于工作区根目录的，例如：');
  lines.push('    示例数据/陆地与海洋/ne_50m_land.shp');
  lines.push('');
  lines.push('  同一份数据给了两种格式（.shp 与 .geojson）：');
  lines.push('  用哪一种都行，GeoJSON 是纯文本，用记事本就能打开看内容。');
  lines.push('');
  lines.push('  旁边的「附属」是 Shapefile 的配套文件（属性表、坐标系等），');
  lines.push('  不用单独点 —— 加载 .shp 时会自动带上。');
  lines.push('');
  lines.push('-'.repeat(60));
  lines.push('每个文件是什么');
  lines.push('-'.repeat(60));
  for (const l of layers) {
    lines.push('');
    lines.push(`【${l.group}】${l.title}（${l.kind}）`);
    lines.push(`  ${l.desc}`);
    lines.push(`  来源：${l.url}`);
    for (const f of files.filter((x) => x.layer === l.id)) {
      lines.push(`    ${f.name}  ${human(f.size)}`);
    }
  }
  lines.push('');
  lines.push(`【${RASTER_LAYER.group}】${RASTER_LAYER.title}（${RASTER_LAYER.kind}）`);
  lines.push(`  ${RASTER_LAYER.desc}`);
  lines.push(`  来源：${RASTER_LAYER.url}`);
  for (const f of files.filter((x) => x.layer === RASTER_LAYER.id)) {
    lines.push(`    ${f.name}  ${human(f.size)}`);
  }
  lines.push('');
  lines.push('-'.repeat(60));
  lines.push('拿它们可以试什么');
  lines.push('-'.repeat(60));
  lines.push('  · 面图层（陆地 / 海洋 / 湖泊）：填色、按面积分级、裁切、简化；');
  lines.push('  · 线图层（海岸线 / 河网）：线宽线型、描边、节点捕捉、抽稀；');
  lines.push('  · 点图层（城市点位）：点符号、按人口分级、浏览属性表；');
  lines.push('  · 栅格（地形晕渲）：出图、像素取值、重采样、拼接。');
  lines.push('');
  lines.push('  你可以随便改这些文件 —— 它们只是工作区里的副本，');
  lines.push('  改坏了也不影响便携包里的原件（重新解压就回来了）。');
  lines.push('');
  lines.push('-'.repeat(60));
  lines.push('许可与归属');
  lines.push('-'.repeat(60));
  lines.push('  Natural Earth — 公共领域（Public Domain）');
  lines.push('  矢量与栅格数据均可自由使用、可商用、无需署名。');
  lines.push('  归属标注：Made with Natural Earth. Free vector and raster map data');
  lines.push('  @ naturalearthdata.com');
  lines.push('  官网：https://www.naturalearthdata.com/');
  lines.push('');
  lines.push(`  GeoJSON 由上面的 Shapefile 转换而来，坐标保留 6 位小数（约 0.1 米精度，`);
  lines.push('  对这份 1:5000 万比例尺的数据绰绰有余）；这样能显著减小示例数据的体积。');
  if (rasterInfo.derived) {
    lines.push('');
    lines.push('  栅格 .tif 由原始文件用 DEFLATE 压缩重写而来（像素与原图一致，只是体积更小），');
    lines.push('  并附上原版的世界文件与坐标系文件。');
  }
  lines.push('');
  lines.push(`  本目录共 ${files.length} 个数据文件，合计 ${human(total)}（不含本说明文件）。`);
  lines.push('');
  return lines.join('\r\n');
}

/* ── 主流程 ─────────────────────────────────────────────────────── */

export async function preparePortableSamples(options = {}) {
  const gdalBin = options.gdalBinDir ?? argOf('gdal-bin') ?? resolveGdalBin();
  if (!gdalBin) {
    throw new Error(
      '找不到 GDAL 命令行工具。请设置 GDAL_BIN 环境变量，或用 --gdal-bin "<目录>" 指定。',
    );
  }

  const sampleRoot = join(STAGE_DIR, SAMPLE_DIR_NAME);
  // 每次重跑都从干净目录开始：上一次留下的半成品比没有更麻烦
  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(sampleRoot, { recursive: true });

  const files = [];

  console.log(`[samples] GDAL：${gdalBin}`);

  for (const layer of VECTOR_LAYERS) {
    const zipName = basename(layer.url);
    const zipPath = join(CACHE_DIR, zipName);
    const unpackDir = join(CACHE_DIR, layer.id);

    await download(layer.url, zipPath);
    if (!existsSync(unpackDir)) unzip(zipPath, unpackDir);

    const srcShp = join(unpackDir, `${layer.id}.shp`);
    if (!existsSync(srcShp)) {
      throw new Error(`解压后找不到 ${layer.id}.shp：${unpackDir}`);
    }

    const destDir = join(sampleRoot, layer.group);
    mkdirSync(destDir, { recursive: true });

    if (layer.select) {
      // 字段需要裁剪：Shapefile 与 GeoJSON 都从**上游原始文件**重新导出，
      // 这样两侧字段完全一致，不会出现"shp 有、geojson 没有"的错位。
      const outShp = join(destDir, `${layer.id}.shp`);
      runTool(gdalBin, 'ogr2ogr', [
        '-q',
        '-f', 'ESRI Shapefile',
        '-lco', 'ENCODING=UTF-8',
        '-select', layer.select,
        outShp,
        srcShp,
      ]);
      runTool(gdalBin, 'ogr2ogr', [
        '-q',
        '-f', 'GeoJSON',
        '-lco', 'COORDINATE_PRECISION=6',
        '-select', layer.select,
        join(destDir, `${layer.id}.geojson`),
        srcShp,
      ]);
    } else {
      // 上游原始 Shapefile 原样保留：它是最容易对着官网核对的形态
      for (const ext of layer.keep) {
        const src = join(unpackDir, `${layer.id}${ext}`);
        if (!existsSync(src)) continue;
        copyFileSync(src, join(destDir, `${layer.id}${ext}`));
      }
      runTool(gdalBin, 'ogr2ogr', [
        '-q',
        '-f', 'GeoJSON',
        '-lco', 'COORDINATE_PRECISION=6',
        join(destDir, `${layer.id}.geojson`),
        srcShp,
      ]);
    }

    console.log(`[samples] ${layer.id} → ${layer.group}`);
  }

  // ── 栅格 ───────────────────────────────────────────────────────
  const rasterZip = join(CACHE_DIR, basename(RASTER_LAYER.url));
  await download(RASTER_LAYER.url, rasterZip);
  const rasterUnpack = join(CACHE_DIR, RASTER_LAYER.id);
  if (!existsSync(rasterUnpack)) unzip(rasterZip, rasterUnpack);

  const rasterDest = join(sampleRoot, RASTER_LAYER.group);
  mkdirSync(rasterDest, { recursive: true });
  // 上游的 GeoTIFF 是 58 MB 未压缩的，包里放不下；用 DEFLATE 重写一遍，
  // 像素一个不改，只是体积降到 9 MB 左右。
  runTool(gdalBin, 'gdal_translate', [
    '-q',
    '-co', 'COMPRESS=DEFLATE',
    '-co', 'PREDICTOR=2',
    '-co', 'TILED=YES',
    join(rasterUnpack, `${RASTER_LAYER.id}.tif`),
    join(rasterDest, `${RASTER_LAYER.id}.tif`),
  ]);
  for (const ext of RASTER_LAYER.sidecars) {
    const src = join(rasterUnpack, `${RASTER_LAYER.id}${ext}`);
    if (existsSync(src)) copyFileSync(src, join(rasterDest, `${RASTER_LAYER.id}${ext}`));
  }
  console.log(`[samples] ${RASTER_LAYER.id} → ${RASTER_LAYER.group}`);

  // ── README 与清单 ──────────────────────────────────────────────
  // 只遍历一次：几个图层共用同一个中文文件夹（如「陆地与海洋」下有三个图层），
  // 按图层分别遍历会把同一批文件重复计入，体积统计直接翻倍。
  const layerIds = [...VECTOR_LAYERS.map((l) => l.id), RASTER_LAYER.id];
  const collect = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        collect(p);
        continue;
      }
      const owner = layerIds.find((id) => entry.name.startsWith(id)) ?? '';
      files.push({
        layer: owner,
        name: entry.name,
        rel: p.slice(sampleRoot.length + 1).split('\\').join('/'),
        size: statSync(p).size,
      });
    }
  };
  collect(sampleRoot);

  const readme = buildReadme(VECTOR_LAYERS, { derived: true }, files);
  // 带 BOM：记事本在没有 BOM 时会按系统代码页猜，中文就变乱码了
  writeFileSync(join(sampleRoot, 'README.txt'), '\uFEFF' + readme, 'utf8');

  // ── 闸门 ───────────────────────────────────────────────────────
  const hits = scanForbidden(sampleRoot);
  if (hits.length > 0) {
    console.error(`[samples] 拒绝出包：示例数据里有 ${hits.length} 处敏感词`);
    for (const h of hits) console.error(`        ${h.file}  ${h.where}  ${h.term}`);
    const err = new Error('示例数据未通过敏感词检查');
    err.code = 'SAMPLE_FORBIDDEN_TERM';
    throw err;
  }

  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const totalMb = totalBytes / 1024 / 1024;
  if (totalMb > SIZE_BUDGET_MB) {
    const err = new Error(
      `示例数据 ${totalMb.toFixed(1)} MB，超过 ${SIZE_BUDGET_MB} MB 预算`,
    );
    err.code = 'SAMPLE_TOO_BIG';
    throw err;
  }

  console.log(`[samples] ${files.length} 个文件，合计 ${totalMb.toFixed(1)} MB（预算 ${SIZE_BUDGET_MB} MB）`);
  console.log(`[samples] 暂存目录：${sampleRoot}`);

  return { sampleRoot, files, totalBytes };
}

// 直接运行时：只准备，不打包
if (process.argv[1] && process.argv[1].endsWith('prepare-portable-samples.mjs')) {
  try {
    await preparePortableSamples();
  } catch (err) {
    console.error(`[samples] 失败：${err.message}`);
    process.exitCode = 1;
  }
}
