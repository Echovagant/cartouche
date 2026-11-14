/**
 * 文件夹选择对话框：让用户在图形界面里挑工作区，不用手打绝对路径。
 *
 * ## 为什么要有这个
 *
 * 「打开项目」这一屏原来只有一个输入框，让用户手打 `D:\任务\2026改图`。
 * 手打绝对路径对不熟悉电脑的人是**真门槛**（盘符、中文、反斜杠），
 * 也是 2026-10-22 那份评审里的「100% 流失点」。
 *
 * 浏览器给不了文件夹选择器：`showDirectoryPicker()` 拿到的是**句柄**，
 * 没有绝对路径；而引擎按路径定位工作区，用不上句柄。所以这条路走不通。
 *
 * 但这个工具是**跑在用户自己电脑上的本机服务**（127.0.0.1:8787）——
 * 让它弹一个 Windows 原生的文件夹选择框，是最合身也最省事的做法。
 *
 * ## 用哪个对话框（都实测过）
 *
 * - ✅ `.NET FolderBrowserDialog`（WinForms）—— **本实现用的**。
 *   弹出来就是资源管理器里那个「选择文件夹」框：左侧导航树、右上角
 *   「新建文件夹」、底部「选择文件夹 / 取消」。实测：能创建、能弹、能拿到路径。
 * - ❌ `Shell.Application` 的 `BrowseForFolder` —— 实测在 PowerShell 5.1 下
 *   **调不起来**（New-Object 成功，但调用时进程挂死/失败）。
 * - ❌ `UseDescriptionForTitle` —— 本机的 .NET 版本没有这个属性，设了会直接报错。
 *
 * ## 隐私：不把绝对路径交给前端
 *
 * 绝对路径里带着**用户名**（形如 `C:\Users\<用户名>\…`）。把它送到浏览器、
 * 存进 localStorage、或者出现在界面上，都等于把用户身份写进了前端。
 * 所以这里的做法是：
 *
 *   引擎选完目录 → **自己记住它**（存到进程内的表里）→ 只给前端一个**代号**
 *
 * 前端拿到的 `folder-3` 这样的代号，反查时引擎才知道是哪个目录。
 * 界面上要显示路径时，也是**引擎按需返回**（且前端可以选择不显示完整路径）。
 *
 * 这样绝对路径只存在于两处：本机引擎的内存与配置文件（都在用户自己电脑上），
 * 以及用户主动要求显示的那一刻。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 引擎进程内记住的「代号 → 绝对路径」表 */
const handles = new Map<string, string>();
/** 绝对路径 → 代号（同一个目录不重复发代号） */
const byPath = new Map<string, string>();
let seq = 0;

/**
 * 生成弹文件夹选择框的 PowerShell 脚本。
 *
 * ⚠️ 输出编码：脚本里 `chcp 65001` + `[Console]::OutputEncoding`，
 * 否则中文路径经过 GBK 解码会变成乱码 —— 路径乱了就选错目录。
 */
export function buildFolderPickerScript(): string {
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    'chcp 65001 > $null',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$d.Description = "选一个放图件的文件夹"',
    // 允许在对话框里直接新建文件夹 —— 用户经常是「先建一个再放图件」
    '$d.ShowNewFolderButton = $true',
    '$r = $d.ShowDialog()',
    'if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) } else { exit 1 }',
    'exit 0',
  ].join('\n');
}

/**
 * 解析对话框脚本的输出，得到绝对路径。
 *
 * @returns {string | null} 用户取消或输出不可信时返回 null
 */
export function parseFolderPickerOutput(raw: string): string | null {
  if (!raw) return null;
  // 取第一行非空（PowerShell 可能多带换行）
  const line = raw.split(/\r?\n/).map((s) => s.trim()).find((s) => s !== '');
  if (!line) return null;
  // 必须是绝对路径：盘符 + 冒号（Windows）
  if (!/^[A-Za-z]:\\/.test(line)) return null;
  return line;
}

/** 当前平台支不支持弹这个对话框 */
export function isFolderPickerSupported(platform: string = process.platform): boolean {
  return platform === 'win32';
}

/**
 * 弹对话框让用户选一个文件夹，返回**代号**。
 *
 * @returns {Promise<{ handle: string; label: string } | null>}
 *   用户取消返回 null。
 */
export async function pickFolder(
  title = '选一个放图件的文件夹',
): Promise<{ handle: string; label: string } | null> {
  if (!isFolderPickerSupported()) {
    throw new Error('这个系统暂时不支持图形化的文件夹选择，请手动填写路径');
  }
  const ps = buildFolderPickerScript().replace('选一个放图件的文件夹', title);
  let stdout: string;
  try {
    const r = await execFileAsync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024 },
    );
    stdout = r.stdout;
  } catch (err) {
    // 用户取消时 PowerShell 退出码 1；那不是错误
    const code = (err as { code?: number }).code;
    if (code === 1) return null;
    throw err;
  }
  const path = parseFolderPickerOutput(stdout);
  if (!path) return null;

  const existing = byPath.get(path.toLowerCase());
  if (existing) {
    return { handle: existing, label: labelOf(path) };
  }
  seq += 1;
  const handle = `folder-${seq}`;
  handles.set(handle, path);
  byPath.set(path.toLowerCase(), handle);
  return { handle, label: labelOf(path) };
}

/**
 * 按代号取回绝对路径。
 *
 * 只给**引擎内部**用（登记工作区时需要真实路径），前端拿不到 —— 前端只有代号。
 *
 * ⚠️ 这里**刻意没有**「带完整路径返回给前端」的接口：
 * 绝对路径里有用户名，一旦送到前端就会留在浏览器里。
 * 用户真要看完整路径，让他自己去资源管理器里看 —— 那是他的机器。
 */
export function pathForHandle(handle: string): string | null {
  return handles.get(handle) ?? null;
}

/** 路径的最后一段（文件夹名） */
function labelOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
