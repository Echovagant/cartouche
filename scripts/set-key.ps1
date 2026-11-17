# 保存各接入线的 API Key —— Windows DPAPI 加密，磁盘上只有密文（2026-11-15 多厂商版）。
#
# 存放：
#   minimax-cn → %LOCALAPPDATA%\cartouche\llm-key.txt（旧路径，兼容已有部署）
#   其它接入线 → %LOCALAPPDATA%\cartouche\keys\<接入线id>.txt
# 引擎启动时按 scripts/run-engine.ps1 里同一份白名单解密注入 <大写ID>_API_KEY。
#
# 红线：不进仓库、不出现明文；密文绑定当前 Windows 用户，换机器/换账号都解不开。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-key.ps1 -Provider deepseek
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-key.ps1 -Provider glm -Clear
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-key.ps1 -Show
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-key.ps1 -Provider minimax-cn -Clear
#
# 本文件含中文，因此**必须存成 UTF-8 with BOM**（Windows PowerShell 5.1 的 .ps1 编码规则：无 BOM 时按 GBK 读会变乱码）。

param(
  [string]$Provider = 'minimax-cn',
  [switch]$Clear,
  [switch]$Show
)

$ErrorActionPreference = 'Stop'

# 与 server/src/llm.ts 的 PERSISTED_ENV、scripts/run-engine.ps1 是同一份清单（两边不许各说各话）
$PROVIDERS = @{
  'minimax-cn'   = 'MINIMAX_API_KEY'
  'minimax-intl' = 'MINIMAX_INTL_API_KEY'
  'glm'          = 'GLM_API_KEY'
  'dashscope'    = 'DASHSCOPE_API_KEY'
  'ark'          = 'ARK_API_KEY'
  'deepseek'     = 'DEEPSEEK_API_KEY'
  'moonshot'     = 'MOONSHOT_API_KEY'
  'siliconflow'  = 'SILICONFLOW_API_KEY'
}

if (-not $PROVIDERS.ContainsKey($Provider)) {
  Write-Output ("[key] 不认识的接入线：{0}" -f $Provider)
  Write-Output ("[key] 可选：{0}" -f (($PROVIDERS.Keys | Sort-Object) -join ', '))
  Write-Output '[key] 本机模型不用密钥；自定义端点的 key 在画布右侧的 AI 面板里粘贴（跟端点走）。'
  return
}

$storeDir = Join-Path $env:LOCALAPPDATA 'cartouche'
# minimax-cn 保持旧的单一文件路径（兼容已有部署与启动脚本）
$keyFile = if ($Provider -eq 'minimax-cn') {
  Join-Path $storeDir 'llm-key.txt'
} else {
  Join-Path (Join-Path $storeDir 'keys') ($Provider + '.txt')
}

if ($Clear) {
  if (Test-Path $keyFile) {
    Remove-Item $keyFile -Force
    Write-Output ("[key] removed: {0}" -f $keyFile)
  } else {
    Write-Output ("[key] {0}: 本来就没配" -f $Provider)
  }
  return
}

if ($Show) {
  if (-not (Test-Path $keyFile)) { Write-Output ("[key] {0}: 未配置" -f $Provider); return }
  $enc = [IO.File]::ReadAllText($keyFile).Trim()
  $sec = ConvertTo-SecureString $enc
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    # 只显示长度与前 4 位，不显示完整密钥
    $head = if ($plain.Length -ge 4) { $plain.Substring(0, 4) } else { '?' }
    Write-Output ("[key] {0}: length={1}  prefix={2}...  file={3}" -f $Provider, $plain.Length, $head, $keyFile)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  return
}

New-Item -ItemType Directory -Path (Split-Path $keyFile -Parent) -Force | Out-Null

$sec = Read-Host 'Paste API Key (input is not echoed, stored as DPAPI ciphertext)' -AsSecureString
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
Write-Output ("[key] 接入线：{0} → 环境变量：{1}" -f $Provider, $PROVIDERS[$Provider])
Write-Output '[key] start the engine with: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-engine.ps1'
