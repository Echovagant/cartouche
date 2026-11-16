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
 * ## 用哪个对话框（2026-11-15 全部实测过，别凭记忆改）
 *
 * 目标是「资源管理器里那个现代对话框」：地址栏、面包屑、搜索框都在，
 * 跟 VS Code / Chrome 的文件选择器长得一样。
 *
 * - ✅ **WinForms `OpenFileDialog` + `ValidateNames = false`** —— **本实现用的**。
 *   把对话框切到「选文件夹」模式：路径从对话框自己的编辑框读回来，
 *   实测能拿到绝对路径（`C:\Users\<用户名>\Documents`）。
 * - ❌ **手写 COM `IFileOpenDialog`** —— 实测**在这台机器上根本创建不出来**：
 *   `CoCreateInstance` 返回 `E_NOINTERFACE (0x80004002)`，
 *   `CLSID_FileOpenDialog` **不实现 `IID_IFileOpenDialog`**，只实现 `IID_IFileDialog`。
 *   （`IID_IUnknown` / `IID_IFileDialog` 都查得到，只有 `IID_IFileOpenDialog` 查不到。）
 *   于是 `dialog` 是 null，下一行就 NullReferenceException，
 *   引擎把它当成「用户取消」→ **前端什么都不显示，用户只看到「点了没反应」**。
 *   顺带一提：那段代码的 vtable 也漏了 `GetFileName`（第 13 格），
 *   导致 `SetTitle` 之后的每个方法都错位一格；`IShellItem.GetDisplayName`
 *   还按 `out string` 封送，参数形状也不对。三处都得改，不是改一处就行的。
 * - ❌ **`IShellItem::GetDisplayName` 这台机器上是坏的** —— 实测对任何 shell item
 *   （连 `SHCreateItemFromParsingName("C:\Windows")` 拿到的普通项）都返回
 *   `RPC_E_INVALID_REFERENCE (0x800401E5)`，走裸 vtable 直接访问冲突。
 *   而同一个进程里 `SHGetKnownFolderPath`（PWSTR* 出参）完全正常，
 *   所以坏的不是出参封送，是**这台机器上的 shell item 这一层**。
 *   结论：**路径不能从 `IShellItem` 取**，只能从对话框自己的编辑框取。
 * - ❌ `Shell.Application` 的 `BrowseForFolder` —— 实测在 PowerShell 5.1 下
 *   **调不起来**（New-Object 成功，但调用时进程挂死/失败）。
 * - ❌ `UseDescriptionForTitle` —— 本机的 .NET 版本没有这个属性，设了会直接报错。
 *
 * ## 界面是原生那套，但必须先让子进程 DPI-aware
 *
 * 弹出来确实是资源管理器同款的现代对话框（地址栏 / 面包屑 / 搜索框 / DirectUI），
 * 但它由 `powershell.exe` 这个子进程渲染，而它没有 manifest → 默认 **DPI-unaware**：
 * 对话框按 96 DPI 画，再由 DWM 按显示器缩放（本机 150%）拉伸位图 → **看着发虚**。
 * 实测：修复前对话框 `GetDpiForWindow` = 96，窗口 853x533（实际被拉到 1280x800）；
 * 弹框前调 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` 之后 = 144，
 * 由系统按原生分辨率绘制，字和图标都是清楚的。
 *
 * ## 两个必须记住的坑
 *
 * 1. **C# 源码里不能有中文。** `Add-Type` 把源码写成临时 .cs 文件，
 *    `csc` 在没有 BOM 时按**系统 ANSI 代码页**读它 —— 中文会被拆成乱码，
 *    乱码里可能出现让编译器误判的字节，直接**编译失败**（实测报
 *    「类、结构或接口成员声明中的标记"catch"无效」这种看不懂的错）。
 *    所以本文件里的 C# 一律 ASCII；中文标题走**环境变量**传进去（UTF-16，无损）。
 * 2. **对话框会被浏览器窗口压住。** 引擎是隐藏启动的独立进程，
 *    新弹的窗口默认不一定抢到前台，用户就只看到「点了没反应」。
 *    解法：把**点击那一刻的前台窗口**（就是用户的浏览器）当作对话框的 owner，
 *    对话框就成了它的模态子窗口，必然浮在它上面。实测前台窗口就是对话框本身。
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
 * ⚠️ **整个脚本必须只有 ASCII**（包括注释）：
 * 脚本里有 C#（`Add-Type`），而 `csc` 读没有 BOM 的源码时按系统 ANSI 代码页解码 ——
 * 中文会变成乱码，乱码里的字节可能让编译器报错（实测直接编译失败）；
 * 同样的道理，PowerShell 自己读中文时也可能把行尾吃掉。
 * 中文标题与提示语走**环境变量**（`CARTOUCHE_PICK_TITLE` / `CARTOUCHE_PICK_HINT`），
 * 那是 UTF-16，不会有这个问题。
 *
 * 界面用 WinForms 的 `OpenFileDialog`，靠 `ValidateNames = false` +
 * `CheckFileExists = false` 切到「选文件夹」模式：弹出来是资源管理器那套
 * 现代界面（地址栏 / 面包屑 / 搜索框），路径从对话框自己的编辑框读回来。
 *
 * ⚠️ 别改回手写 COM `IFileOpenDialog`：实测这台机器上 `CoCreateInstance`
 * 返回 `E_NOINTERFACE`，对话框根本创建不出来（详见文件头的实测记录）。
 */
export function buildFolderPickerScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    '',
    'public class CartouchePickerOwner',
    '{',
    '    [DllImport("user32.dll")]',
    '    public static extern IntPtr GetForegroundWindow();',
    '',
    '    // DPI: the child process (powershell.exe) has no manifest, so it starts',
    '    // DPI-unaware. The shell dialog then renders at 96 DPI and DWM stretches',
    '    // that bitmap by the monitor scale (150% here) -> visibly blurry.',
    '    // Opting the process into Per-Monitor V2 before any window exists makes',
    '    // the dialog render natively at the monitor resolution.',
    '    [DllImport("user32.dll")]',
    '    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);',
    '    [DllImport("user32.dll")]',
    '    public static extern bool SetProcessDPIAware();',
    '',
    '    public static string MakeDpiAware() {',
    '        // -4 == DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2',
    '        if (SetProcessDpiAwarenessContext(new IntPtr(-4))) { return "PerMonitorAwareV2"; }',
    '        if (SetProcessDPIAware()) { return "SystemAware"; }',
    '        return "unaware";',
    '    }',
    '',
    '    // IWin32Window only needs a Handle property, so the dialog can be owned',
    '    // by any existing window (the browser the user just clicked in).',
    '    public class OwnerWindow : System.Windows.Forms.IWin32Window',
    '    {',
    '        private readonly IntPtr _handle;',
    '        public OwnerWindow(IntPtr handle) { _handle = handle; }',
    '        public IntPtr Handle { get { return _handle; } }',
    '    }',
    '}',
    "'@ -ReferencedAssemblies System.Windows.Forms",
    '',
    // 必须在创建任何窗口之前调用，否则 SetProcessDpiAwarenessContext 会失败
    '[void][CartouchePickerOwner]::MakeDpiAware()',
    '',
    // 标题与提示语从环境变量来（UTF-16），不写进源码（源码必须是 ASCII）
    "$title = $env:CARTOUCHE_PICK_TITLE",
    "if (-not $title) { $title = 'Pick a folder' }",
    "$hint = $env:CARTOUCHE_PICK_HINT",
    "if (-not $hint) { $hint = 'choose this folder' }",
    '',
    '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
    '$dlg.Title = $title',
    // ValidateNames=false + CheckFileExists=false = 「选文件夹」模式：
    // 可以停在文件夹上直接确定，路径从编辑框回读。
    '$dlg.ValidateNames = $false',
    '$dlg.CheckFileExists = $false',
    '$dlg.CheckPathExists = $true',
    '$dlg.Multiselect = $false',
    '$dlg.FileName = $hint',
    '$dlg.RestoreDirectory = $true',
    '',
    '# Own the dialog by the window that was foreground when the user clicked',
    '# (the browser). Then it is a modal child of that window, so it shows up',
    '# on top of it instead of being buried behind every other window.',
    '$owner = [CartouchePickerOwner]::GetForegroundWindow()',
    'try {',
    '  if ($owner -ne [IntPtr]::Zero) {',
    '    $r = $dlg.ShowDialog([CartouchePickerOwner+OwnerWindow]::new($owner))',
    '  } else {',
    '    $r = $dlg.ShowDialog()',
    '  }',
    '} finally {',
    '  $dlg.Dispose()',
    '}',
    '',
    '# Exit codes: 0 = a folder was picked; 3 = the user closed the dialog',
    '# (not an error); anything else means the script itself broke and PowerShell',
    '# exits with 1 plus a message on stderr - the engine must report that.',
    'if ($r -ne [System.Windows.Forms.DialogResult]::OK) { exit 3 }',
    '',
    '$full = $dlg.FileName',
    'if (-not $full) { exit 3 }',
    '',
    '# The user picked a folder in the list -> that is the path.',
    '# The user typed a name instead -> the folder they are standing in is it.',
    'if (Test-Path -LiteralPath $full -PathType Container) {',
    '  $path = $full',
    '} else {',
    '  $path = [System.IO.Path]::GetDirectoryName($full)',
    '}',
    'if (-not $path) { exit 3 }',
    '',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::Out.Write($path)',
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
 * 对话框脚本退出码 → 结果。
 *
 * ⚠️ 这条区分是实测换来的：早期版本把**所有**非 0 退出码都当成「用户取消」，
 * 结果 PowerShell 自己报错（连 `//` 不是 PowerShell 注释这种低级错）被吞成
 * 「用户取消」，用户点按钮只看到「点了没反应」，没有任何线索。
 * 现在：只有退出码 3 是取消；别的都是出错，**必须把原因带出去**。
 */
export type PickerExit =
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/**
 * 解释对话框脚本的退出码。
 *
 * @param code   进程退出码（0 = 成功，不走这里）
 * @param stderr 脚本写到 stderr 的内容
 */
export function interpretPickerExit(code: number, stderr: string): PickerExit {
  if (code === 3) return { kind: 'cancelled' };
  const lines = stderr
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  // 取最后几行：PowerShell 的报错是「异常行 + 位置行 + 分类行」，原因在头几行，
  // 但头几行常带一堆路径噪声；这里留最后 3 行，前端看个大概。
  const detail = lines.slice(-3).join(' ');
  return {
    kind: 'failed',
    message: detail
      ? `文件夹选择对话框没能正常打开：${detail}`
      : `文件夹选择对话框没能正常打开（脚本退出码 ${code}）`,
  };
}

/**
 * 弹对话框让用户选一个文件夹，返回**代号**。
 *
 * @returns {Promise<{ handle: string; label: string } | null>}
 *   用户取消返回 null。
 */
export async function pickFolder(
  title = '选一个放图件的文件夹',
  hint = '选择此文件夹',
): Promise<{ handle: string; label: string } | null> {
  if (!isFolderPickerSupported()) {
    throw new Error('这个系统暂时不支持图形化的文件夹选择，请手动填写路径');
  }
  const ps = buildFolderPickerScript();
  let stdout: string;
  try {
    const r = await execFileAsync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-Command', ps],
      {
        encoding: 'utf8',
        // ⚠️ windowsHide 不能为 true：引擎进程本身是隐藏启动的，
        //    子进程如果也隐藏，Windows 会把新窗口放到 Z-Order 最底层 ——
        //    用户看到的是"点击没反应"。
        windowsHide: false,
        timeout: 600000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          // 中文走环境变量（UTF-16），不进源码（源码必须是 ASCII）
          CARTOUCHE_PICK_TITLE: title,
          CARTOUCHE_PICK_HINT: hint,
        },
      },
    );
    stdout = r.stdout;
  } catch (err) {
    // 退出码可能是数字，也可能是超时被杀时那种非数字值（ETIMEDOUT 之类）——
    // 统一归成 -1，别让消息里出现「退出码 NaN」。
    const raw = (err as { code?: unknown }).code;
    const code = typeof raw === 'number' ? raw : -1;
    const stderr = String((err as { stderr?: string }).stderr ?? '');
    const outcome = interpretPickerExit(code, stderr);
    if (outcome.kind === 'cancelled') return null;
    throw new Error(outcome.message);
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
