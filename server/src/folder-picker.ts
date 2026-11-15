/**
 * 文件夹选择对话框：让用户在图形界面里挑工作区，不用手打绝对路径。
 *
 * ## 为什么要有这个
 *
 * 「打开项目」这一屏原来只有一个输入框，让用户手打一长串绝对路径。
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 代号要不要**跨重启**存活？要。
 *
 * 「最近打开的项目」存在浏览器 localStorage 里，条目里放的是代号 ——
 * 如果代号只活在进程内存里，引擎一重启最近列表就全变成了死条目。
 * 所以代号表落盘到配置目录（与 roots.json 同一套约定）：
 * 文件里只有「代号 → 目录」的对应，绝对路径照旧不出引擎。
 * 读不到 / 读坏了就当空表 —— 配置坏了不该挡住服务起来。
 */
const configDir =
  process.env.CARTOUCHE_CONFIG_DIR ??
  join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '.', 'cartouche');
const handlesFile = join(configDir, 'handles.json');

/** 引擎进程内记住的「代号 → 绝对路径」表 */
const handles = new Map<string, string>();
/** 绝对路径 → 代号（同一个目录不重复发代号） */
const byPath = new Map<string, string>();
let seq = 0;

/* ── 落盘 / 灌回 ─────────────────────────────────────────────── */

function saveHandles(): void {
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      handlesFile,
      JSON.stringify(Object.fromEntries(handles), null, 2),
      'utf8',
    );
  } catch {
    // 配置写不了只影响「跨重启的最近列表」，不该挡住选文件夹本身
  }
}

(function loadHandles() {
  try {
    if (!existsSync(handlesFile)) return;
    const raw = JSON.parse(readFileSync(handlesFile, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^folder-\d+$/.test(key) || typeof value !== 'string' || value === '') continue;
      handles.set(key, value);
      byPath.set(value.toLowerCase(), key);
      const n = Number(key.slice('folder-'.length));
      if (Number.isFinite(n)) seq = Math.max(seq, n);
    }
  } catch {
    // 坏文件当空表，与 roots.json 同一态度
  }
})();

/**
 * 生成弹文件夹选择框的 PowerShell 脚本。
 *
 * ⚠️ 输出编码：脚本里 `chcp 65001` + `[Console]::OutputEncoding`，
 * 否则中文路径经过 GBK 解码会变成乱码 —— 路径乱了就选错目录。
 */
export function buildFolderPickerScript(): string {
  // ⚠️ 2026-11-15 裁定：不用 .NET FolderBrowserDialog（旧树形界面，用户说"廉价"），
  // 改用 Windows 原生 IFileOpenDialog COM —— 与 VS Code / Chrome 文件选择器完全相同的
  // 现代界面（有地址栏、快速访问、搜索框）。通过 Add-Type 加载 C# 代码调用 COM。
  // 对话框以非模态方式弹出（Show(IntPtr.Zero)），独立于引擎进程窗口，出现在前台。
  const cs = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class ModernFolderPicker {',
    '  [DllImport("ole32.dll")]',
    '  static extern int CoCreateInstance(ref Guid clsid, IntPtr pUnkOuter, uint dwClsContext, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IFileOpenDialog ppv);',
    '  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]',
    '  class FileOpenDialogCOM { }',
    '  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D96953287B4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    '  interface IFileOpenDialog {',
    '    [PreserveSig] int Show(IntPtr hwndOwner);',
    '    [PreserveSig] int SetFileTypes(uint c, IntPtr p);',
    '    [PreserveSig] int SetFileTypeIndex(uint i);',
    '    [PreserveSig] int GetFileTypeIndex(out uint i);',
    '    [PreserveSig] int Advise(IntPtr f, out uint c);',
    '    [PreserveSig] int Unadvise(uint c);',
    '    [PreserveSig] int SetOptions(uint o);',
    '    [PreserveSig] int GetOptions(out uint o);',
    '    [PreserveSig] int SetDefaultFolder(IntPtr i);',
    '    [PreserveSig] int SetFolder(IntPtr i);',
    '    [PreserveSig] int GetFolder(out IntPtr i);',
    '    [PreserveSig] int GetCurrentSelection(IntPtr i);',
    '    [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n);',
    '    [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);',
    '    [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);',
    '    [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);',
    '    [PreserveSig] int GetResult(out IntPtr i);',
    '    [PreserveSig] int AddPlace(IntPtr i, int f);',
    '    [PreserveSig] int SetNavigationRoot(IntPtr i);',
    '  }',
    '  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    '  interface IShellItem {',
    '    [PreserveSig] int GetDisplayName(uint n, [MarshalAs(UnmanagedType.LPWStr)] out string p);',
    '  }',
    '  public static string Pick(string title) {',
    '    var clsid = new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7");',
    '    var iid = new Guid("D57C7288-D4AD-4768-BE02-9D96953287B4");',
    '    IFileOpenDialog dialog;',
    '    CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out dialog);',
    '    dialog.SetTitle(title);',
    '    dialog.SetOptions(0x60);',
    '    if (dialog.Show(IntPtr.Zero) != 0) return null;',
    '    IntPtr ppsi;',
    '    dialog.GetResult(out ppsi);',
    '    var item = (IShellItem)Marshal.GetObjectForIUnknown(ppsi);',
    '    string path;',
    '    item.GetDisplayName(0x80058000, out path);',
    '    return path;',
    '  }',
    '}',
  ].join('\n');

  return [
    "$cs = @'",
    cs,
    "'@",
    'Add-Type -TypeDefinition $cs',
    'chcp 65001 > $null',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$r = [ModernFolderPicker]::Pick("选一个放图件的文件夹")',
    'if ($r) { [Console]::Out.Write($r) } else { exit 1 }',
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
      // ⚠️ windowsHide 不能为 true：引擎进程本身是隐藏启动的，
      //    子进程如果也隐藏，Windows 会把 COM 对话框放到 Z-Order 最底层 ——
      //    用户看到的是"点击没反应"，实际上对话框被压在了所有窗口后面
      //    （2026-11-15 实测：设为 false 后对话框正确出现在前台）。
      { encoding: 'utf8', windowsHide: false, timeout: 600000, maxBuffer: 1024 * 1024 },
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
  saveHandles();
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
