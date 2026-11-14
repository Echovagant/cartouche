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
 * 让它弹一个 Windows 原生的文件夹选择框，是最合身也最省事的做法：
 * 用户看到的是资源管理器里那个熟悉的树形选择框，选完直接拿到绝对路径。
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
} from '../server/src/folder-picker.ts';

describe('文件夹选择对话框', () => {
  test('生成的 PowerShell 脚本必须调起 WinForms 的文件夹选择框', () => {
    const ps = buildFolderPickerScript();
    assert.match(ps, /System\.Windows\.Forms\.FolderBrowserDialog/);
    assert.match(ps, /Add-Type -AssemblyName System\.Windows\.Forms/);
    // 老式的 Shell.Application BrowseForFolder 在 PowerShell 5.1 下实测调不起来
    assert.ok(!ps.includes('Shell.Application'), '不要用 Shell.Application（实测在本机调不起来）');
    // 本机的 .NET 版本没有 UseDescriptionForTitle，设了会直接报错
    assert.ok(!ps.includes('UseDescriptionForTitle'), '本机 .NET 没有 UseDescriptionForTitle 属性');
  });

  test('脚本必须以 UTF-8 写出中文提示，且不把路径编码坏', () => {
    const ps = buildFolderPickerScript();
    assert.match(ps, /chcp 65001|OutputEncoding/);
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
