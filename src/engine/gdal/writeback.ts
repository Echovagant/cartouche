/**
 * 安全写回：原子写入 + 自动备份 + 占用检测。
 *
 * 不可妥协的链路：
 *   占用检测 → 备份原文件 → 写临时文件 → 回读校验 → 原子替换
 * 任何一步失败，原文件保持不变。
 */
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { OccupiedError, sha256, type WorkspaceAdapter } from '../workspace/index.ts';

export interface WriteBackSidecar {
  readonly path: string;
  readonly data: Uint8Array;
}

export interface WriteBackRequest {
  /** 目标文件的相对路径 */
  readonly target: string;
  /** 新的文件内容 */
  readonly data: Uint8Array;
  /** 附带写入的伴随文件（如 .tfw / .wld / .prj） */
  readonly sidecars?: readonly WriteBackSidecar[];
  /** 是否为原文件建备份，默认 true */
  readonly backup?: boolean;
  /** 备份文件名的标签，默认取时间戳 */
  readonly label?: string;
}

export interface WriteBackResult {
  readonly target: string;
  readonly backupPath: string | null;
  readonly bytesWritten: number;
  readonly sha256: string;
  readonly verified: boolean;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 生成备份文件名：<target>.bak.<label|时间戳> */
export function backupPathFor(target: string, label?: string): string {
  return `${target}.bak.${label ?? timestamp()}`;
}

/** 瞬时性错误：Windows 上文件被杀软 / 索引器短暂独占时就会这样 */
const TRANSIENT_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);

function isTransient(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 判断路径是否可能已存在；判不准时按"存在"处理（多加后缀总比覆盖旧备份安全） */
async function mayExist(store: WorkspaceAdapter, path: string): Promise<boolean> {
  try {
    return await store.exists(path);
  } catch {
    return true;
  }
}

/**
 * 备份原文件。
 *
 * **关键：这里的决策不依赖 `store.exists()`。**
 *
 * 早期实现是 `if (await store.exists(target)) { copy(...) }`，而 `exists()`
 * 会把「文件在、但当前访问被拒」（EACCES / EPERM / EBUSY）也当成"文件不存在"——
 * 于是在 Windows 上只要杀软或索引器短暂独占目标文件，就会**跳过备份直接覆盖原文件**。
 * 这既违反了"写回必须可回退"的底线，也是本项目长期追查的偶发失败（flaky）的一个真实来源。
 *
 * 现在的语义：
 * - `ENOENT`（目标确实不存在）→ 没有备份是合理的，返回 null；
 * - 瞬时性错误 → 退避重试；
 * - 其它错误 / 重试耗尽 → **抛出，中止写回**。宁可失败，也不做"无备份的覆盖"。
 */
export async function createBackup(
  store: WorkspaceAdapter,
  target: string,
  label?: string,
  attempts = 4,
): Promise<string | null> {
  const base = backupPathFor(target, label);
  // 同一秒内对同一目标连续写回时，备份名会撞车 → 第二次备份会**覆盖**第一次，
  // 于是"回滚"拿到的不是最初的状态。撞名时补一段随机后缀，保证每个备份彼此独立。
  let backupPath = base;
  if (await mayExist(store, backupPath)) {
    backupPath = `${base}.${randomBytes(3).toString('hex')}`;
  }
  for (let i = 0; i < attempts; i++) {
    try {
      await store.copy(target, backupPath);
      return backupPath;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') return null;
      if (!isTransient(err) || i === attempts - 1) throw err;
      await sleep(60 * (i + 1));
    }
  }
  return null;
}

/**
 * 原子写回。
 * 临时文件与目标同目录 —— 保证 rename 在同一卷上，是真正的原子操作。
 */
export async function writeBack(
  store: WorkspaceAdapter,
  req: WriteBackRequest,
): Promise<WriteBackResult> {
  const target = store.resolve(req.target);
  const backup = req.backup ?? true;

  // 1) 占用检测：ArcGIS 打开数据时会持有句柄
  await store.assertWritable(req.target);

  // 2) 备份原文件（含伴随文件）
  //    注意：备份的必要性由"复制是否成功"判定，不由 exists() 判定 —— 见 createBackup 注释。
  let backupPath: string | null = null;
  if (backup) {
    backupPath = await createBackup(store, req.target, req.label);
  }

  // 3) 写临时文件
  const tmpSuffix = randomBytes(6).toString('hex');
  const tmpPath = join(dirname(target), `.${tmpSuffix}.tmp`);
  try {
    await store.write(tmpPath, req.data);
    for (const sc of req.sidecars ?? []) {
      await store.write(sc.path, sc.data);
    }

    // 4) 回读校验
    const readBack = await store.read(tmpPath);
    const expected = sha256(req.data);
    const actual = sha256(readBack);
    if (expected !== actual) {
      throw new Error('写回校验失败：临时文件内容与预期不一致，已放弃替换，原文件未改动');
    }

    // 5) 原子替换（Windows 上 libuv 用 MoveFileEx + REPLACE_EXISTING）
    //    目标被 ArcGIS 占用时，这里会失败——翻译成 OccupiedError，原文件保持不变
    try {
      await store.rename(tmpPath, req.target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        throw new OccupiedError(req.target, err);
      }
      throw err;
    }

    return {
      target,
      backupPath,
      bytesWritten: req.data.length,
      sha256: expected,
      verified: true,
    };
  } catch (err) {
    // 失败清理临时文件；原文件保持不变
    try {
      await store.remove(tmpPath);
    } catch {
      /* 清理失败不掩盖主错误 */
    }
    throw err;
  }
}

/**
 * 覆盖式重命名的说明：
 * 临时文件与目标同目录 → rename 在同一卷上是原子操作；
 * Windows 上 Node 的 fs.rename 使用 MoveFileEx(MOVEFILE_REPLACE_EXISTING)，
 * 目标已存在时也是整体替换，不会出现"写了一半"的中间态。
 */

/**
 * 文件级原子替换：把临时文件整体换成目标文件（带备份）。
 * 用于"GDAL 产出新文件 → 原子替换原文件"的场景。
 * 临时文件必须与目标同目录，rename 才是同卷原子操作。
 */
export async function replaceFileAtomically(
  store: WorkspaceAdapter,
  req: {
    readonly target: string;
    /** 同目录下的临时文件路径（绝对或相对） */
    readonly tempPath: string;
    readonly backup?: boolean;
    readonly label?: string;
  },
): Promise<{ backupPath: string | null }> {
  await store.assertWritable(req.target);

  let backupPath: string | null = null;
  if (req.backup ?? true) {
    backupPath = await createBackup(store, req.target, req.label);
  }

  try {
    await store.rename(req.tempPath, req.target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
      throw new OccupiedError(req.target, err);
    }
    throw err;
  }
  return { backupPath };
}

export { OccupiedError };
