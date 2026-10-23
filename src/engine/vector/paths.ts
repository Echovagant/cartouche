/**
 * 矢量模块的路径与临时文件规矩。
 *
 * 两条硬规矩：
 *  1. **工作区相对路径**：op 的 target 只能是工作区里的相对路径。
 *     绝对路径与 `..` 一律拒绝 —— 这道闸门在操作计划这一层最要紧，
 *     否则一条"把 C 盘某个文件改了"的计划就能跑通。
 *  2. **临时文件不落系统盘**：临时目录优先建在**目标文件旁边**。
 *     同目录 → 同一个卷 → 最后的 rename 才是原子替换；
 *     也不往系统临时目录堆（那台机器的 C 盘很紧）。
 *     环境变量 CARTOUCHE_TMP_DIR 可以指定别的落点。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 把 `dataset://x.shp` 这类引用剥成工作区相对路径。
 *
 * `layer://` / `summary://` 指的是图层标识，不是文件路径 —— 这里不猜，
 * 直接报错让调用方给一个能落地的路径。
 */
export function toRelPath(raw: string, key = 'target'): string {
  const m = /^(?:dataset|layer|summary):\/\/(.+)$/.exec(raw);
  if (m) {
    if (!/^dataset:\/\//.test(raw)) {
      throw new Error(
        `${key} 不是文件路径（${raw}）；引擎只能处理 dataset:// 开头的工作区相对路径`,
      );
    }
    return m[1]!;
  }
  return raw;
}

/** 相对路径 + 路径闸门：绝对路径与 `..` 都不放过。 */
export function toRelPathChecked(raw: string, key = 'target'): string {
  const rel = toRelPath(raw, key);
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) {
    throw new Error(
      `${key} 必须是相对路径，不能是绝对路径：${raw}（绝对路径不在已登记的工作区根之下）`,
    );
  }
  if (rel.split(/[\\/]/).includes('..')) {
    throw new Error(`${key} 不能包含 .. ：${raw}（这样的路径不在已登记的工作区根之下）`);
  }
  return rel;
}

/** 时间戳（与引擎里备份文件名的口径一致：20261023-200000）。 */
export function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 建一个临时目录。
 *
 * 落点顺序：环境变量指定的目录 → 目标文件所在目录 → 系统临时目录（兜底）。
 * 兜底那条只在目标目录根本不可写时才走（正常的写回流程里目标目录一定是可写的）。
 */
export function makeTempDir(targetPath: string, prefix = '.cartouche-tmp-'): string {
  const fromEnv = process.env.CARTOUCHE_TMP_DIR;
  if (fromEnv && fromEnv.trim() !== '') {
    try {
      return mkdtempSync(join(fromEnv, prefix));
    } catch {
      /* 指定目录不可用就往下走 */
    }
  }
  try {
    // 与目标同目录：同卷 → rename 是原子操作
    return mkdtempSync(join(dirname(targetPath), prefix));
  } catch {
    return mkdtempSync(join(tmpdir(), prefix));
  }
}
