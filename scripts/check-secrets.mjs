// 密钥扫描门禁：防止 API Key 被提交进仓库。
//
// 检查四类问题：
//   R1 厂商格式的密钥（sk-xxx / eyJ... JWT 形态）出现在任何文本文件里
//   R2 apiKey / api_key / *_API_KEY 之类的赋值带上了"看起来像真值"的长字符串
//   R3 仓库里存在 .env / secrets/ 之类会装明文密钥的路径
//   R4 DPAPI 密文文件出现在仓库内（说明存错地方了）
//
// 占位符不算命中：your- / placeholder / example / xxx / changeme / <...> / ${...} 等。
// 输出时**一律脱敏**，只回显前缀，绝不回显完整密钥。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, basename } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.turbo', '.cache', 'samples', 'fixtures']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.yml', '.yaml', '.ps1', '.cmd', '.txt', '.env', '.example', '.sh']);

const PLACEHOLDER = /(your[-_ ]?|placeholder|example|sample|dummy|fake|test[-_ ]?key|changeme|replace[-_ ]?me|insert[-_ ]?here|<[^>]+>|\{\{[^}]+\}\}|\$\{[^}]+\}|xxx+|<redacted>|none|null|undefined|not[-_ ]?a[-_ ]?real)/i;

/**
 * 显式豁免标记：同一行里出现 `secret-scan:allow` 就跳过这一行。
 *
 * 用于**测试夹具**——测试里必须放"长得像真 Key 的假 Key"才能验证脱敏逻辑，
 * 但它们不是泄露。加豁免必须显式写出来，而不是默认放行整个目录（那样门禁就形同虚设）。
 */
const ALLOW_MARKER = /secret-scan\s*:\s*allow/i;

/** 候选值：长度 >= 16 且不是占位符 */
function looksReal(v) {
  const t = v.trim().replace(/^["']|["']$/g, '');
  if (t.length < 16) return false;
  if (PLACEHOLDER.test(t)) return false;
  // 全是同一个字符 / 明显递增序列 → 不是密钥
  if (/^(.)\1+$/.test(t)) return false;
  return true;
}

function mask(v) {
  const t = v.trim().replace(/^["']|["']$/g, '');
  if (t.length <= 8) return '***';
  return `${t.slice(0, 4)}***${t.slice(-2)} (len=${t.length})`;
}

const findings = [];
const add = (rule, file, line, col, sample, detail) =>
  findings.push({ rule, file, line, col, sample, detail });

/* ── R1 / R2：逐文件扫描 ───────────────────────────────────── */
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.env.example') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p);
    } else if (TEXT_EXT.has(extname(e.name)) || basename(e.name).startsWith('.env')) {
      files.push(p);
    }
  }
})(ROOT);

const R1 = [
  /\bsk-[A-Za-z0-9_\-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
const R2 = [
  /\b(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|bearer)\b\s*[:=]\s*["']([^"'\n]{8,})["']/gi,
  /\b[A-Z][A-Z0-9_]*_API_KEY\b\s*[:=]\s*["']([^"'\n]{8,})["']/g,
];

for (const f of files) {
  const rel = relative(ROOT, f);
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (ALLOW_MARKER.test(line)) return; // 显式豁免（测试夹具）
    for (const re of R1) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (PLACEHOLDER.test(m[0])) continue;
        add('R1', rel, i + 1, m.index, mask(m[0]), '厂商格式的密钥');
      }
    }
    for (const re of R2) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const v = m[1] ?? '';
        if (!looksReal(v)) continue;
        add('R2', rel, i + 1, m.index, mask(v), '疑似把密钥写进了配置');
      }
    }
  });
}

/* ── R3 / R4：路径级检查 ────────────────────────────────────── */
const BAD_PATHS = ['.env', '.env.local', '.env.production', 'secrets', 'keys'];
for (const p of BAD_PATHS) {
  const full = join(ROOT, p);
  if (existsSync(full)) {
    add('R3', p, 0, 0, p, '仓库内存在可能存放明文密钥的路径（应改用 scripts\\set-key.ps1 的 DPAPI 存储）');
  }
}
const DPAPI_NAMES = ['llm-key.txt', 'key.dpapi', 'llm-key.dpapi'];
for (const n of DPAPI_NAMES) {
  if (existsSync(join(ROOT, n))) {
    add('R4', n, 0, 0, n, 'DPAPI 密文文件出现在仓库内（应放在 %LOCALAPPDATA%\\cartouche）');
  }
}

/* ── 报告 ───────────────────────────────────────────────────── */
if (findings.length === 0) {
  console.log(`scanned ${files.length} files, no secret-like content found`);
  process.exitCode = 0;
} else {
  console.error(`scanned ${files.length} files, found ${findings.length} potential secret leak(s):\n`);
  for (const f of findings) {
    console.error(`[${f.rule}] ${f.file}${f.line ? `:${f.line}:${f.col + 1}` : ''}`);
    console.error(`  ${f.detail}`);
    console.error(`  value: ${f.sample}`);
  }
  console.error('\n处理方式：把密钥改用 scripts\\set-key.ps1 存进 %LOCALAPPDATA%（DPAPI 加密），并从仓库里删掉这个文件。');
  process.exitCode = 1;
}
