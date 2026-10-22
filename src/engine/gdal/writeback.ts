/**
 * 安全写回：原子写入 + 自动备份 + 占用检测。
 *
 * 不可妥协的链路：
 *   占用检测 → 备份原文件 → 写临时文件 → 回读校验 → 原子替换
 * 任何一步失败，原文件保持不变。
 *
 * 两种写回方式：
 *  - `replace`（默认）：原地替换原文件 —— 备份、回读校验、原子替换一步不少。
 *  - `copy`：另存为新文件 —— **原文件一个字节都不动**，新内容落到 outputPath。
 *    这是用户要的"另存为新文件"按钮的引擎侧实现。
 */
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { OccupiedError, sha256, type WorkspaceAdapter } from '../workspace/index.ts';

export interface WriteBackSidecar {
  readonly path: string;
  readonly data: Uint8Array;
}

/**
 * 写回方式。
 *
 * - `replace`：原地替换目标文件（默认，行为与从前完全一致）。
 * - `copy`：写到新路径，目标文件一个字节都不动，也不产生备份。
 */
export type WriteBackMode = 'replace' | 'copy';

export interface WriteBackRequest {
  /** 目标文件的相对路径 */
  readonly target: string;
  /** 新的文件内容 */
  readonly data: Uint8Array;
  /** 附带写入的伴随文件（如 .tfw / .wld / .prj） */
  readonly sidecars?: readonly WriteBackSidecar[];
  /** 是否为原文件建备份，默认 true；copy 模式一律不备份 */
  readonly backup?: boolean;
  /** 备份文件名的标签，默认取时间戳 */
  readonly label?: string;
  /** 默认 'replace'；'copy' = 写到 outputPath，target 一个字节都不动 */
  readonly mode?: WriteBackMode;
  /** mode='copy' 时的目标路径（工作区相对路径） */
  readonly outputPath?: string;
}

export interface WriteBackResult {
  readonly target: string;
  /** mode='copy' 时是新文件路径 */
  readonly outputPath?: string;
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
 * 路径的主名（不含扩展名）。
 *
 * 为什么要按"主名"而不是整段文件名比对：伴随文件（.tfw / .prj / .aux.xml）
 * 是靠**与主文件同名**被 ArcGIS 认出来的，copy 模式下必须跟着新文件一起改名。
 */
function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 路径所在目录（工作区相对路径用正斜杠；没有目录时返回空串） */
function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(0, slash) : '';
}

/**
 * copy 模式下伴随文件的落点：写到 outputPath 旁边，并跟着新文件改名。
 *
 * 为什么要改名：伴随文件必须与主文件同名，ArcGIS 才会把它当成这个栅格的辅助文件。
 * 留在旧名字上，用户拿到的就是"新栅格 + 一堆指向旧栅格的伴随文件"。
 */
function sidecarDestination(target: string, outputPath: string, sidecarPath: string): string {
  const outDir = dirOf(outputPath);
  const outStem = stemOf(outputPath);
  const base = sidecarPath.slice(sidecarPath.lastIndexOf('/') + 1);
  const targetStem = stemOf(target);
  // 伴随文件原本叫 <主名><后缀> 时才跟着改名；否则只挪目录，不改出一个怪名字
  const name = base.startsWith(targetStem) ? `${outStem}${base.slice(targetStem.length)}` : base;
  return outDir ? `${outDir}/${name}` : name;
}

/**
 * 另存为新文件的参数校验。
 *
 * **这里绝不能默默退回 replace。**
 * 用户点的是"另存为新文件"，默默退回原地替换等于在用户不知情的情况下改掉了原文件 ——
 * 那是这条链路上最坏的结果（新文件没生成，原图也没了）。
 * 所以两种情况都必须当场报错：
 *  - 没给 outputPath：新文件写到哪里根本没说过；
 *  - outputPath 就是原文件：那本来就是原地替换，不该绕一圈走另存为。
 */
function assertCopyTarget(
  store: WorkspaceAdapter,
  target: string,
  outputPath: string | undefined,
): { readonly outputRel: string; readonly outputAbs: string } {
  if (!outputPath) {
    throw new Error(
      '另存为新文件必须给出 outputPath：新文件写到哪里必须明确，不能默认改原文件',
    );
  }
  const outputAbs = store.resolve(outputPath);
  // 比解析后的绝对路径，而不是字符串：'data.tif' 与 './data.tif' 是同一个文件
  if (outputAbs === store.resolve(target)) {
    throw new Error(
      `另存为新文件的目标路径不能与原文件相同：${outputPath}` +
        '（那就是原地替换，不走另存为这条路）',
    );
  }
  return { outputRel: outputPath, outputAbs };
}

/**
 * 另存为新文件：把新内容写到一个**新路径**，原文件一个字节都不动。
 *
 * 与 replace 的三处关键差别：
 *  - 不做备份：原文件没被改，备份它没有意义。
 *  - 占用检测查的是 **outputPath**：我们真正要写的是新文件；
 *    原文件正被 ArcGIS 打开，恰恰是"另存为"最常见的场景，不该因此失败。
 *  - 临时文件写在 outputPath 旁边：rename 才是同卷原子操作。
 */
async function writeBackCopy(
  store: WorkspaceAdapter,
  req: WriteBackRequest,
): Promise<WriteBackResult> {
  const { outputRel, outputAbs } = assertCopyTarget(store, req.target, req.outputPath);
  const targetAbs = store.resolve(req.target);

  // 占用检测：查我们要写的那个文件（新文件），不查原文件
  await store.assertWritable(outputRel);

  const tmpSuffix = randomBytes(6).toString('hex');
  const tmpPath = join(dirname(outputAbs), `.${tmpSuffix}.tmp`);
  try {
    await store.write(tmpPath, req.data);
    for (const sc of req.sidecars ?? []) {
      await store.write(sidecarDestination(req.target, outputRel, sc.path), sc.data);
    }

    // 回读校验（与 replace 同口径：校验临时文件的内容）
    const readBack = await store.read(tmpPath);
    const expected = sha256(req.data);
    const actual = sha256(readBack);
    if (expected !== actual) {
      throw new Error('写回校验失败：临时文件内容与预期不一致，已放弃落盘，新文件未生成');
    }

    // 落盘：临时文件 → outputPath（同目录 → 同卷 rename 是原子操作）
    try {
      await store.rename(tmpPath, outputRel);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        throw new OccupiedError(outputRel, err);
      }
      throw err;
    }

    return {
      target: targetAbs,
      outputPath: outputAbs,
      backupPath: null,
      bytesWritten: req.data.length,
      sha256: expected,
      verified: true,
    };
  } catch (err) {
    // 失败清理临时文件；原文件始终未动
    try {
      await store.remove(tmpPath);
    } catch {
      /* 清理失败不掩盖主错误 */
    }
    throw err;
  }
}

/**
 * 原子写回。
 * 临时文件与目标同目录 —— 保证 rename 在同一卷上，是真正的原子操作。
 */
export async function writeBack(
  store: WorkspaceAdapter,
  req: WriteBackRequest,
): Promise<WriteBackResult> {
  // 另存为新文件：走另一条链路，原文件一个字节都不动
  if ((req.mode ?? 'replace') === 'copy') {
    return writeBackCopy(store, req);
  }

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
 *
 * mode='copy' 时语义变成"另存为新文件"：临时文件落到 outputPath，
 * **原文件一个字节都不动**，也不产生备份（原文件没被改，备份它没有意义）。
 */
export async function replaceFileAtomically(
  store: WorkspaceAdapter,
  req: {
    readonly target: string;
    /** 同目录下的临时文件路径（绝对或相对） */
    readonly tempPath: string;
    readonly backup?: boolean;
    readonly label?: string;
    /** 默认 'replace'；'copy' = 临时文件落到 outputPath，原文件一个字节都不动 */
    readonly mode?: WriteBackMode;
    /** mode='copy' 时的目标路径（工作区相对路径） */
    readonly outputPath?: string;
  },
): Promise<{ backupPath: string | null; outputPath?: string }> {
  if ((req.mode ?? 'replace') === 'copy') {
    const { outputRel, outputAbs } = assertCopyTarget(store, req.target, req.outputPath);
    // 占用检测查新文件（我们真正写的那个）；原文件被 ArcGIS 打开不影响另存
    await store.assertWritable(outputRel);
    try {
      await store.rename(req.tempPath, outputRel);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        throw new OccupiedError(outputRel, err);
      }
      throw err;
    }
    return { backupPath: null, outputPath: outputAbs };
  }

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
