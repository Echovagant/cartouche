$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $env:TEMP 'cartouche-mut2'
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $tmp | Out-Null

function Backup($rel) {
  $dst = Join-Path $tmp ($rel -replace '[\\/]', '__')
  Copy-Item (Join-Path $root $rel) $dst
  return $dst
}
function Restore($rel, $dst) { Copy-Item $dst (Join-Path $root $rel) -Force }
function Hash($rel) { (Get-FileHash (Join-Path $root $rel) -Algorithm SHA256).Hash }
function Mutate($rel, $from, $to) {
  $t = Get-Content (Join-Path $root $rel) -Raw -Encoding UTF8
  if ($t -notmatch [regex]::Escape($from)) { throw "pattern not found in ${rel}: $from" }
  $t = $t -replace [regex]::Escape($from), $to
  [System.IO.File]::WriteAllText((Join-Path $root $rel), $t, (New-Object System.Text.UTF8Encoding $false))
}
function RunTests {
  Push-Location $root
  $o = node --test 2>&1 | Out-String
  Pop-Location
  return $o
}
function Report($name, $out) {
  $failed = ($out -match 'fail 1') -or ($out -match 'fail 2') -or ($out -match 'fail 3')
  if ($failed) { Write-Host "  [PASS] $name -- 变异被测试抓到（测试有效）" }
  else { Write-Host "  [FAIL] $name -- 变异未被抓到，测试是假绿！" }
  ($out -split "`n" | Select-String -Pattern '✖' | Select-Object -First 3) | ForEach-Object { Write-Host ("      " + $_.ToString().Trim()) }
  return $failed
}

Write-Output "=== 变异测试：S3 新功能 ===`n"

# 1) 撤销栈：执行新命令时不清空重做栈
$rel = 'src\engine\undo\command-stack.ts'
$b = Backup $rel; $h = Hash $rel
Mutate $rel '    this.#redo.length = 0;' '    /* mutated: 不清空重做栈 */'
Write-Output "--- 变异 1：执行新命令不清空重做栈 ---"
$ok1 = Report '重做栈清空逻辑' (RunTests)
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 2) 撤销栈：撤销失败后仍然弹出命令
$rel = 'src\engine\undo\command-stack.ts'
$b = Backup $rel; $h = Hash $rel
Mutate $rel '    await command.undo(); // 失败会抛出，命令保持在原位' '    this.#undo.pop(); await command.undo();'
Write-Output "--- 变异 2：撤销失败时仍弹出命令 ---"
$ok2 = Report '撤销失败的回滚' (RunTests)
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 3) 模板：跳过未知参数校验
$rel = 'src\engine\templates\registry.ts'
$b = Backup $rel; $h = Hash $rel
Mutate $rel '      if (!known.has(key)) {' '      if (false && !known.has(key)) {'
Write-Output "--- 变异 3：模板跳过未知参数校验 ---"
$ok3 = Report '未知参数校验' (RunTests)
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 4) 模板：把必填判断改成"真值"判断（false/0 会被误判为缺失）
$rel = 'src\engine\templates\registry.ts'
$b = Backup $rel; $h = Hash $rel
Mutate $rel '      const missing = value === undefined || value === null;' '      const missing = !value;'
Write-Output "--- 变异 4：必填判断误用真值（false/0 被当成缺失）---"
$ok4 = Report '必填参数的合法假值' (RunTests)
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 5) HTTP 工作区：占用时不再抛错
$rel = 'src\engine\workspace\http-store.ts'
$b = Backup $rel; $h = Hash $rel
Mutate $rel "    if (res.status === 409) {" '    if (false && res.status === 409) {'
Write-Output "--- 变异 5：HTTP 工作区占用时不再报错 ---"
$ok5 = Report 'HTTP 占用检测' (RunTests)
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 6) 锁文件命名规则退回错误的 path.lock
$rel = 'src\engine\workspace\index.ts'
$b = Backup $rel; $h = Hash $rel
Mutate $rel '  return [`${stem}.lock`, `${stem}.lck`]' '  return [`${path}.lock`]'
Write-Output "--- 变异 6：锁文件命名规则写错（path.lock 而非 stem.lock）---"
$ok6 = Report '锁文件命名规则' (RunTests)
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

Write-Output "`n--- 还原后复跑 ---"
$final = RunTests
($final -split "`n" | Select-String -Pattern '^. (tests|pass|fail) ') | ForEach-Object { "  " + $_.ToString().Trim() }
$allOk = $ok1 -and $ok2 -and $ok3 -and $ok4 -and $ok5 -and $ok6
Write-Output ("  变异捕获率: " + (@($ok1,$ok2,$ok3,$ok4,$ok5,$ok6) | Where-Object { $_ }).Count + "/6`n")
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
