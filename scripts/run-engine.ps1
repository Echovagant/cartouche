# 启动图签引擎（开发态与便携包两用）。
#
# 两种场景只差两件事：用什么跑、工作区在哪。
#
#   便携包：包里有 node.exe 与预构建好的 server/dist，直接跑，不依赖 npm。
#           工作区固定在 %LOCALAPPDATA%\cartouche\workspace —— 便携包是「程序」，
#           用户的数据是「另一件事」，删掉包目录不该丢图件。
#   开发态：仓库里是 TypeScript 源码，要走 `npm -w server run dev` 实时编译。
#           工作区仍在仓库下的 workspace/，与仓库其它脚本保持一致。
#
# 密钥：本机存的 DPAPI 密文解进这个进程的环境变量，交给子进程。
#       从不落盘明文，从不回显。
#
# 编码：本文件是 UTF-8 with BOM。Windows PowerShell 5.1 读无 BOM 的 .ps1 时
#       按系统代码页解，中文注释会变乱码 —— 乱码的注释等于没有注释。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-engine.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-engine.ps1 -Port 8787

param(
  [int]$Port = 0,
  [switch]$NoKey
)

$ErrorActionPreference = 'Stop'
$pkgRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = Join-Path $pkgRoot 'runtime\node\node.exe'
$serverEntry = Join-Path $pkgRoot 'server\dist\index.js'

# LOCALAPPDATA 理论上一定有，但老系统/精简系统上可能没有 —— 别在这里炸掉
$localAppData = $env:LOCALAPPDATA
if (-not $localAppData) { $localAppData = Join-Path $env:USERPROFILE 'AppData\Local' }
$keyFile = Join-Path $localAppData 'cartouche\llm-key.txt'

# 端口优先取环境变量：启动器（start-portable.cmd）已经把 ENGINE_PORT 设好了，
# 这里再写死一个默认值会把启动器的设置覆盖掉 —— 实测踩到过：
# 启动器让引擎跑在 18787，引擎却去抢 8787，直接 EADDRINUSE 起不来。
if ($Port -le 0) {
  if ($env:ENGINE_PORT) { $Port = [int]$env:ENGINE_PORT } else { $Port = 8787 }
}

# 是不是便携包：有自带 node 且有预构建产物，就算便携包。
# 用「有没有」判断而不是「当前目录叫什么」—— 同一份脚本在两种场景都能跑。
$isPortable = (Test-Path $nodeExe) -and (Test-Path $serverEntry)

# 工作区根：外部指定了就听外部的（启动器会指到 %LOCALAPPDATA%\cartouche\workspace），
# 没指定才按场景自己定。
if (-not $env:ENGINE_WORKSPACE_ROOT -or $env:ENGINE_WORKSPACE_ROOT.Trim() -eq '') {
  if ($isPortable) {
    $env:ENGINE_WORKSPACE_ROOT = Join-Path $localAppData 'cartouche\workspace'
  } else {
    $env:ENGINE_WORKSPACE_ROOT = Join-Path $pkgRoot 'workspace'
  }
}
# 目录不存在就建出来：引擎第一次写文件时才会发现，届时报错很难懂
try {
  New-Item -ItemType Directory -Force -Path $env:ENGINE_WORKSPACE_ROOT | Out-Null
} catch {
  Write-Output "[workspace] cannot create $($env:ENGINE_WORKSPACE_ROOT) -> $($_.Exception.Message)"
}

if (-not $NoKey -and (Test-Path $keyFile)) {
  $enc = [IO.File]::ReadAllText($keyFile).Trim()
  try {
    $sec = ConvertTo-SecureString $enc
  } catch {
    Write-Output "[key] cannot decrypt (was it saved by a different Windows user?) -> $keyFile"
    $sec = $null
  }
  if ($sec) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try {
      $env:MINIMAX_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
      # 只报在不在，绝不报值
      Write-Output ("[key] loaded from DPAPI store, length={0}" -f $env:MINIMAX_API_KEY.Length)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
} elseif (-not $NoKey) {
  Write-Output "[key] not configured. Run: scripts\set-key.ps1"
}

$env:ENGINE_PORT = "$Port"
$env:ENGINE_HOST = '127.0.0.1'

Write-Output "[engine] starting on http://127.0.0.1:$Port (workspace root: $env:ENGINE_WORKSPACE_ROOT)"
Set-Location $pkgRoot
if ($isPortable) {
  & $nodeExe $serverEntry
} else {
  & npm -w server run dev
}
