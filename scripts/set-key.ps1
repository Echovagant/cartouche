# 保存 MiniMax API Key —— 用 Windows DPAPI 加密，只留密文。
#
# 为什么不用 .env / 明文文件：
#   - 明文文件一旦进仓库，密钥就等于公开了；
#   - DPAPI 密文绑定当前 Windows 用户，别的账号、别的机器都解不开；
#   - 文件放在 %LOCALAPPDATA%，**在仓库之外**，不会被任何提交工具扫到。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-key.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-key.ps1 -Clear
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-key.ps1 -Show
#
# 本文件含中文，因此**必须存成 UTF-8 with BOM**（Windows PowerShell 5.1 的 .ps1 编码规则：无 BOM 时按 GBK 读会变乱码）。

param(
  [switch]$Clear,
  [switch]$Show
)

$ErrorActionPreference = 'Stop'
$storeDir = Join-Path $env:LOCALAPPDATA 'cartouche'
$keyFile = Join-Path $storeDir 'llm-key.txt'

if ($Clear) {
  if (Test-Path $keyFile) {
    Remove-Item $keyFile -Force
    Write-Output "[key] removed: $keyFile"
  } else {
    Write-Output "[key] nothing to remove"
  }
  return
}

if ($Show) {
  if (-not (Test-Path $keyFile)) {
    Write-Output "[key] not configured"
    return
  }
  $enc = [IO.File]::ReadAllText($keyFile).Trim()
  $sec = ConvertTo-SecureString $enc
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    # 只显示长度与前 4 位，不显示完整密钥
    $head = if ($plain.Length -ge 4) { $plain.Substring(0, 4) } else { '?' }
    Write-Output ("[key] configured  length={0}  prefix={1}...  file={2}" -f $plain.Length, $head, $keyFile)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  return
}

New-Item -ItemType Directory -Path $storeDir -Force | Out-Null

$sec = Read-Host 'Paste MiniMax API Key (input is not echoed, stored as DPAPI ciphertext)' -AsSecureString
if ($null -eq $sec) {
  Write-Output '[key] aborted'
  return
}

# SecureString 为空时 ConvertFrom-SecureString 会得到空串，这里做一次非空校验
$probe = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $len = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($probe).Trim().Length
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($probe)
}
if ($len -lt 8) {
  Write-Output '[key] aborted: key looks too short'
  return
}

$enc = ConvertFrom-SecureString -SecureString $sec
[IO.File]::WriteAllText($keyFile, $enc, (New-Object Text.UTF8Encoding($false)))

# 权限收紧：只允许当前用户访问
try {
  $acl = Get-Acl $keyFile
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $env:USERNAME, 'FullControl', 'Allow')
  $acl.SetAccessRule($rule)
  Set-Acl -Path $keyFile -AclObject $acl
} catch {
  Write-Output '[key] note: could not tighten ACL (not fatal, file is still DPAPI-encrypted)'
}

Write-Output ("[key] saved (DPAPI ciphertext) -> {0}" -f $keyFile)
Write-Output '[key] start the engine with: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-engine.ps1'
