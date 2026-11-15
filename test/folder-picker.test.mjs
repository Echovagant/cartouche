/**
 * 「选文件夹」对话框：让用户在图形界面里挑工作区，不用手打绝对路径。
 *
 * ## 为什么要有这个
 *
 * 「打开项目」这一屏原来只有一个输入框，让用户手打一长串绝对路径。
 * 手打绝对路径对不熟悉电脑的人是**真门槛**（盘符、中文、反斜杠），
 * 也是 2026-10-22 那份评审里的「100% 流失点」。
 *
 * 浏览器给不了文件夹选择器（`showDirectoryPicker` 拿到的是句柄，
 * **没有绝对路径**，引擎按路径定位工作区，用不上），所以这条路走不通。
 *
 * 但这个工具是**跑在用户自己电脑上的本机服务**（127.0.0.1:8787）——
 * 让它弹一个 Windows 原生的文件夹选择框，是最合身也最省事的做法。
 *
 * ## 这些断言锁的是「实测踩过的坑」，别照着记忆改
 *
 * 2026-11-15 实测：这台机器上手写 COM `IFileOpenDialog` **创建不出对话框**
 * （`CoCreateInstance` 返回 `E_NOINTERFACE`），用户点按钮只会看到「点了没反应」。
 * 现在用的是 WinForms `OpenFileDialog` + `ValidateNames = false`，
 * 路径从对话框自己的编辑框读回来（`IShellItem::GetDisplayName` 这台机器上是坏的）。
 *
 * ## 安全边界
 *
 * - 引擎只监听回环地址，外部网页打不到这个端点；
 * - 但**本机上任何页面**都能打（Origin 只需是 http://127.0.0.1:*）——
 *   所以这个端点**必须要求 application/json**（强制走 CORS 预检），
 *   跟登记工作区那道闸是同一个道理；
 * - 对话框是**模态**的，用户不点就拿不到路径 —— 跨站页面弹出来的是
 *   一个空对话框，用户不会误点，等于自己挡住了。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFolderPickerScript,
  parseFolderPickerOutput,
  isFolderPickerSupported,
  interpretPickerExit,
} from '../server/src/folder-picker.ts';

describe('文件夹选择对话框', () => {
  test('生成的 PowerShell 脚本必须用 WinForms 的现代对话框', () => {
    const ps = buildFolderPickerScript();
    assert.match(ps, /System\.Windows\.Forms\.OpenFileDialog/);
    assert.match(ps, /Add-Type -AssemblyName System\.Windows\.Forms/);
    // ValidateNames=false + CheckFileExists=false = 「选文件夹」模式
    assert.match(ps, /ValidateNames = \$false/);
    assert.match(ps, /CheckFileExists = \$false/);
    // 老式的 Shell.Application BrowseForFolder 在 PowerShell 5.1 下实测调不起来
    assert.ok(!ps.includes('Shell.Application'), '不要用 Shell.Application（实测在本机调不起来）');
    // 本机的 .NET 版本没有 UseDescriptionForTitle，设了会直接报错
    assert.ok(!ps.includes('UseDescriptionForTitle'), '本机 .NET 没有 UseDescriptionForTitle 属性');
  });

  test('不许改回手写 COM IFileOpenDialog——实测在这台机器上创建不出来', () => {
    const ps = buildFolderPickerScript();
    assert.ok(
      !ps.includes('IFileOpenDialog'),
      '不要用手写 COM IFileOpenDialog（实测 CoCreateInstance 返回 E_NOINTERFACE，对话框根本弹不出来）',
    );
    assert.ok(
      !ps.includes('GetDisplayName'),
      '不要从 IShellItem 取路径（实测 GetDisplayName 返回 RPC_E_INVALID_REFERENCE，裸 vtable 直接访问冲突）',
    );
  });

  test('脚本必须是纯 ASCII：C# 源码按 ANSI 代码页解码，中文会让编译失败', () => {
    const ps = buildFolderPickerScript();
    const nonAscii = [...ps].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x7f);
    assert.equal(
      nonAscii.length,
      0,
      `脚本里出现了非 ASCII 字符：${JSON.stringify(nonAscii.join(''))}`,
    );
  });

  test('中文标题走环境变量，不能写进脚本源码', () => {
    const ps = buildFolderPickerScript();
    assert.match(ps, /\$env:CARTOUCHE_PICK_TITLE/);
    assert.match(ps, /\$env:CARTOUCHE_PICK_HINT/);
  });

  test('对话框要归到前台窗口名下，否则会被浏览器压住看不见', () => {
    const ps = buildFolderPickerScript();
    assert.match(ps, /GetForegroundWindow/);
    assert.match(ps, /ShowDialog\(\[/);
  });

  test('用户取消必须用独立退出码 3，不能和脚本出错混在一起', () => {
    const ps = buildFolderPickerScript();
    assert.match(ps, /exit 3/);
    // 退出码 1 是 PowerShell 脚本自己报错时用的，引擎要把它当成错误抛出去
    assert.ok(!/\bexit 1\b/.test(ps), '不要用 exit 1 表示取消（那和脚本报错撞码了）');
  });

  test('退出码 3 = 用户取消；其它非 0 = 脚本出错，必须把原因带出去', () => {
    assert.deepEqual(interpretPickerExit(3, ''), { kind: 'cancelled' });

    const failed = interpretPickerExit(1, "At line:1 char:1\n+ // x\n+ ~~\n    The term '//' is not recognized");
    assert.equal(failed.kind, 'failed');
    assert.match(failed.message, /没能正常打开/);
    // 报错内容要出现在消息里，否则前端只剩一句「选文件夹失败」
    assert.match(failed.message, /not recognized/);

    const noStderr = interpretPickerExit(1, '');
    assert.equal(noStderr.kind, 'failed');
    assert.match(noStderr.message, /退出码 1/);
  });

  test('路径必须以 UTF-8 写出，且 PowerShell 注释用 #（// 不是 PowerShell 注释）', () => {
    const ps = buildFolderPickerScript();
    assert.match(ps, /OutputEncoding/);
    // C# 块之外的部分才是 PowerShell：那里出现 // 会被当成命令去执行。
    // 实测踩过：`// 对话框归到…` 直接报「The term '//' is not recognized」。
    const [beforeCsharp, afterCsharp] = ps.split("'@ -ReferencedAssemblies System.Windows.Forms");
    const powershellPart = beforeCsharp.split("Add-Type -TypeDefinition @'")[0] + afterCsharp;
    assert.ok(
      !powershellPart.includes('//'),
      `PowerShell 部分的注释要用 # ：${powershellPart}`,
    );
  });

  test('用户选了就返回绝对路径', () => {
    const out = parseFolderPickerOutput('C:\\Users\\someone\\图件项目\r\n');
    assert.equal(out, 'C:\\Users\\someone\\图件项目');
  });

  test('用户取消（空输出）返回 null，不是空字符串', () => {
    assert.equal(parseFolderPickerOutput(''), null);
    assert.equal(parseFolderPickerOutput('   \r\n'), null);
  });

  test('输出里有多余空行与 \r 时取第一行非空的', () => {
    assert.equal(parseFolderPickerOutput('\r\n\r\nD:\\a\\b\r\n\r\n'), 'D:\\a\\b');
  });

  test('解析结果必须是真的绝对路径（盘符开头），相对路径一律丢弃', () => {
    assert.equal(parseFolderPickerOutput('相对\\路径'), null);
    assert.equal(parseFolderPickerOutput('C:\\ok'), 'C:\\ok');
  });

  test('Windows 之外不支持时明确说不支持', () => {
    assert.equal(isFolderPickerSupported('linux'), false);
    assert.equal(isFolderPickerSupported('win32'), true);
  });
});
