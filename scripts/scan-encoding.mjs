// Scan for "UTF-8 bytes decoded as GBK, then re-encoded as UTF-8" pollution.
// Detection rule (deterministic, reversible when no U+FFFD is present):
//   s.encode('gbk').decode('utf-8') succeeds AND round-trip differs AND the result
//   contains CJK AND the original contains no CJK-looking mojibake CJK.
// Guards against false positives on normal Chinese (职位/状态 style).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'out', 'coverage', 'fixtures', '.turbo', '.cache']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.yml', '.yaml', '.ps1', '.cmd', '.txt', '.svg']);

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const NON_CJK_FOREIGN = /[\u0590-\u05ff\u0370-\u03ff\u0300-\u036f\u0591-\u05bd]/;

function tryFix(chunk) {
  let buf;
  try {
    buf = Buffer.from(chunk, 'gbk');
  } catch {
    return null;
  }
  const fixed = buf.toString('utf-8');
  if (fixed === chunk) return null;
  if (fixed.includes('\uFFFD')) return { fixed, lossy: true };
  return { fixed, lossy: false };
}

function scanText(text, rel) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!CJK.test(line)) continue;
    if (/[\uFFFD]/.test(line)) {
      hits.push({ rel, line: i + 1, kind: 'REPLACEMENT_CHAR', sample: line.trim().slice(0, 120), fixed: null });
      continue;
    }
    // only try lines that look like mojibake: contain CJK but also suspicious rare CJK
    // heuristic: try fixing; require result to be mostly CJK and different
    const res = tryFix(line);
    if (!res) continue;
    const { fixed, lossy } = res;
    if (!CJK.test(fixed)) continue;
    if (NON_CJK_FOREIGN.test(fixed)) continue;
    // original must not already be "clean" - if fixing yields something and original
    // contains chars outside common CJK+ASCII punctuation, treat as polluted
    const cjkCount = (fixed.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjkCount < 2) continue;
    const weird = (line.match(/[\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    if (weird === 0 && !lossy) continue;
    hits.push({ rel, line: i + 1, kind: lossy ? 'POLLUTED_LOSSY' : 'POLLUTED', sample: line.trim().slice(0, 120), fixed: fixed.trim().slice(0, 120) });
  }
  return hits;
}

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(p);
    } else {
      if (TEXT_EXT.has(extname(entry.name))) files.push(p);
    }
  }
}
walk(ROOT);

let total = 0;
const allHits = [];
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, 'utf-8');
  } catch {
    continue;
  }
  const hits = scanText(text, relative(ROOT, f));
  if (hits.length) {
    allHits.push(...hits);
    total += hits.length;
  }
}

console.log(`scanned ${files.length} files, found ${total} suspect line(s)`);
for (const h of allHits) {
  console.log(`\n[${h.kind}] ${h.rel}:${h.line}`);
  console.log(`  bad : ${h.sample}`);
  if (h.fixed) console.log(`  good: ${h.fixed}`);
}
process.exitCode = total > 0 ? 1 : 0;
