$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $env:TEMP 'cartouche-mut'
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $tmp | Out-Null

function Backup($rel) {
  $src = Join-Path $root $rel
  $dst = Join-Path $tmp ($rel -replace '[\\/]', '__')
  Copy-Item $src $dst
  return $dst
}
function Restore($rel, $dst) {
  Copy-Item $dst (Join-Path $root $rel) -Force
}
function Hash($rel) { (Get-FileHash (Join-Path $root $rel) -Algorithm SHA256).Hash }

# 写入变异后的文本，并确认"变异真的生效"。
# 不做这一步检查的话：正则没匹配上 → 文件没变 → 测试当然全绿 →
# 会被误报成"变异未被测试抓到"，这是假阴性的来源（2026-10-21 踩过一次）。
# 门禁要**自己说清覆盖了多少**：跑了几项、抓住几项、几项作废。
# 以前这里不报总数，"变异未生效"的项目被静默跳过 —— 看着像全绿，其实没测到。
$script:total = 0
$script:caught = 0
$script:voided = 0

function ApplyMutation($rel, $text, $origHash) {
  $script:total += 1
  [System.IO.File]::WriteAllText((Join-Path $root $rel), $text, (New-Object System.Text.UTF8Encoding $false))
  if ((Hash $rel) -eq $origHash) {
    $script:voided += 1
    Write-Output "  [ERROR] 变异未生效（正则未匹配到目标代码）—— 本项作废，不能据此判断测试有效性"
    return $false
  }
  return $true
}

function RunTests() {
  Push-Location $root
  $o = node --test 2>&1 | Out-String
  Pop-Location
  return $o
}

function Report($label, $out) {
  # 从 node --test 的汇总行里取**真实失败数**。
  # 以前是匹配 'fail 1'..'fail 4' 这种字面量 —— 测试数变多之后，
  # 一个变异可能让 5 个以上测试变红，那些字面量一个都匹配不上，
  # 就会被**误报成"测试是假绿"**（2026-10-21 真的踩到过：193 个测试时
  # 有个变异让 6 个测试红了，脚本却判它没被抓住）。
  $m = [regex]::Matches($out, '(?m)^\s*\S+\s+fail\s+(\d+)\s*$')
  $n = 0
  if ($m.Count -gt 0) { $n = [int]$m[$m.Count - 1].Groups[1].Value }
  if ($n -gt 0) {
    $script:caught += 1
    Write-Output "  [PASS] 变异被测试抓到（$n 个测试失败 = 测试有效）"
  } else {
    Write-Output "  [FAIL] 变异未被抓到 —— 测试是假绿！"
  }
  ($out -split "`n" | Select-String -Pattern '✖|fail ' | Select-Object -First 4) | ForEach-Object { "    " + $_.ToString().Trim() }
}

Write-Output "=== 变异测试：故意改坏实现，确认对应测试会失败 ===`n"

# 变异 1：把 CRS 阻断降级为 warn
$rel1 = 'src\engine\health\checks.ts'
$b1 = Backup $rel1
$h1 = Hash $rel1
$t = Get-Content (Join-Path $root $rel1) -Raw -Encoding UTF8
$t = $t -replace "(?s)(R-CRS-001',\r?\n\s*)'blocker'", "`$1'warn'"
Write-Output "--- 变异 1：R-CRS-001 从 blocker 降级为 warn ---"
if (ApplyMutation $rel1 $t $h1) { Report 'm1' (RunTests) }
Restore $rel1 $b1
Write-Output ("  已还原，hash 一致: " + ((Hash $rel1) -eq $h1))

# 变异 2：写回时不备份
$rel2 = 'src\engine\gdal\writeback.ts'
$b2 = Backup $rel2
$h2 = Hash $rel2
$t2 = Get-Content (Join-Path $root $rel2) -Raw -Encoding UTF8
$t2 = $t2 -replace "const backup = req\.backup \?\? true;", "const backup = false;"
Write-Output "--- 变异 2：写回时不再生成备份 ---"
if (ApplyMutation $rel2 $t2 $h2) { Report 'm2' (RunTests) }
Restore $rel2 $b2
Write-Output ("  已还原，hash 一致: " + ((Hash $rel2) -eq $h2))

# 变异 3：跳过占用检测
$rel3 = 'src\engine\gdal\writeback.ts'
$b3 = Backup $rel3
$h3 = Hash $rel3
$t3 = Get-Content (Join-Path $root $rel3) -Raw -Encoding UTF8
$t3 = $t3 -replace "await store\.assertWritable\(req\.target\);", "// mutated: skip occupancy check"
Write-Output "--- 变异 3：跳过占用检测 ---"
if (ApplyMutation $rel3 $t3 $h3) { Report 'm3' (RunTests) }
Restore $rel3 $b3
Write-Output ("  已还原，hash 一致: " + ((Hash $rel3) -eq $h3))

# 变异 4：备份决策退回依赖 exists()（复现 2026-10-21 定位到的真实 bug）
#   背景：Windows 上文件被短暂独占时 fs.access 报 EACCES，旧实现把它当"文件不存在"，
#   于是跳过备份直接覆盖原文件 —— 表现为随机出现的"应生成备份"断言失败。
$rel4 = 'src\engine\gdal\writeback.ts'
$b4 = Backup $rel4
$h4 = Hash $rel4
$t4 = Get-Content (Join-Path $root $rel4) -Raw -Encoding UTF8
$t4 = $t4 -replace "(?s)(const base = backupPathFor\(target, label\);\r?\n)", "`$1  if (!(await store.exists(target))) return null;`r`n"
Write-Output "--- 变异 4：备份决策退回依赖 exists() 的误报 ---"
if (ApplyMutation $rel4 $t4 $h4) { Report 'm4' (RunTests) }
Restore $rel4 $b4
Write-Output ("  已还原，hash 一致: " + ((Hash $rel4) -eq $h4))

# 变异 5：备份名撞车时不去重（同一秒内连续写回，第二份备份会覆盖第一份）
$rel5 = 'src\engine\gdal\writeback.ts'
$b5 = Backup $rel5
$h5 = Hash $rel5
$t5 = Get-Content (Join-Path $root $rel5) -Raw -Encoding UTF8
$t5 = $t5 -replace "if \(await mayExist\(store, backupPath\)\) \{", "if (false) {"
Write-Output "--- 变异 5：备份名撞车不去重（连续写回会覆盖旧备份）---"
if (ApplyMutation $rel5 $t5 $h5) { Report 'm5' (RunTests) }
Restore $rel5 $b5
Write-Output ("  已还原，hash 一致: " + ((Hash $rel5) -eq $h5))

# 变异 6：exists() 把"访问被拒"当成"不存在"（恢复旧的危险语义）
# ⚠️ 目标文件在 2026-10-21 的一次重构里从 workspace/index.ts 拆到了
#    workspace/errors.ts —— 变异点必须跟着代码走，否则正则匹配不到，
#    脚本会报"变异未生效"并**跳过这一项**（那一项就等于没测）。
$rel6 = 'src\engine\workspace\errors.ts'
$b6 = Backup $rel6
$h6 = Hash $rel6
$t6 = Get-Content (Join-Path $root $rel6) -Raw -Encoding UTF8
$t6 = $t6 -replace "if \(code === 'EACCES' \|\| code === 'EPERM' \|\| code === 'EBUSY'\) return 'exists';", "if (false) return 'exists';"
Write-Output "--- 变异 6：exists() 把访问被拒当成不存在 ---"
if (ApplyMutation $rel6 $t6 $h6) { Report 'm6' (RunTests) }
Restore $rel6 $b6
Write-Output ("  已还原，hash 一致: " + ((Hash $rel6) -eq $h6))

# 变异 7：去掉 V-ENC-002（非 UTF-8 编码的告警）
$rel7 = 'src\engine\health\checks.ts'
$b7 = Backup $rel7
$h7 = Hash $rel7
$t7 = Get-Content (Join-Path $root $rel7) -Raw -Encoding UTF8
$t7 = $t7 -replace "(?s)\r?\n  // V-ENC-002：声明了编码，但不是 UTF-8.*?\r?\n  \}\r?\n", "`r`n"
[System.IO.File]::WriteAllText((Join-Path $root $rel7), $t7, (New-Object System.Text.UTF8Encoding $false))
Write-Output "--- 变异 7：去掉 V-ENC-002 规则 ---"
if (ApplyMutation $rel7 $t7 $h7) { Report 'm7' (RunTests) }
Restore $rel7 $b7
Write-Output ("  已还原，hash 一致: " + ((Hash $rel7) -eq $h7))

# ── S5 新增：把本轮真抓到的三个 bug 固化成变异用例 ──

# 变异 8：分类断点的 step 表达式错位一档（stop 取当前档而非上一档）
$rel8 = 'src\engine\style\cim-to-style.ts'
$b8 = Backup $rel8
$h8 = Hash $rel8
$t8 = Get-Content (Join-Path $root $rel8) -Raw -Encoding UTF8
$t8 = $t8 -replace "expr\.push\(usable\[i - 1\]!\.upper, usable\[i\]!\.color\);", "expr.push(usable[i]!.upper, usable[i]!.color);"
Write-Output "--- 变异 8：分类断点 step 表达式错位一档 ---"
if (ApplyMutation $rel8 $t8 $h8) { Report 'm8' (RunTests) }
Restore $rel8 $b8
Write-Output ("  已还原，hash 一致: " + ((Hash $rel8) -eq $h8))

# 变异 9：bbox 转换时把 maxY 写成 minY（上下颠倒）
$rel9 = 'src\engine\export\raster-image.ts'
$b9 = Backup $rel9
$h9 = Hash $rel9
$t9 = Get-Content (Join-Path $root $rel9) -Raw -Encoding UTF8
$t9 = $t9 -replace "args\.push\('-projwin', String\(minX\), String\(maxY\), String\(maxX\), String\(minY\)\);", "args.push('-projwin', String(minX), String(minY), String(maxX), String(maxY));"
Write-Output "--- 变异 9：bbox 上下颠倒 ---"
if (ApplyMutation $rel9 $t9 $h9) { Report 'm9' (RunTests) }
Restore $rel9 $b9
Write-Output ("  已还原，hash 一致: " + ((Hash $rel9) -eq $h9))

# 变异 10：识别源 EPSG 时取第一个而不是最后一个（UTM 图会被误判成 4326）
$rel10 = 'src\engine\export\raster-image.ts'
$b10 = Backup $rel10
$h10 = Hash $rel10
$t10 = Get-Content (Join-Path $root $rel10) -Raw -Encoding UTF8
$t10 = $t10 -replace "return ids\.length > 0 \? ids\[ids\.length - 1\]! : null;", "return ids.length > 0 ? ids[0]! : null;"
Write-Output "--- 变异 10：源 EPSG 取第一个而非最后一个 ---"
if (ApplyMutation $rel10 $t10 $h10) { Report 'm10' (RunTests) }
Restore $rel10 $b10
Write-Output ("  已还原，hash 一致: " + ((Hash $rel10) -eq $h10))

# 变异 11：projection 源不再走 gdalwarp（投影栅格会错位）
$rel11 = 'src\engine\export\raster-image.ts'
$b11 = Backup $rel11
$h11 = Hash $rel11
$t11 = Get-Content (Join-Path $root $rel11) -Raw -Encoding UTF8
$t11 = $t11 -replace "dstEpsg !== undefined && srcEpsg !== null && srcEpsg !== dstEpsg;", "false;"
Write-Output "--- 变异 11：投影源不再重投影 ---"
if (ApplyMutation $rel11 $t11 $h11) { Report 'm11' (RunTests) }
Restore $rel11 $b11
Write-Output ("  已还原，hash 一致: " + ((Hash $rel11) -eq $h11))

Write-Output "`n--- 还原后复跑 ---"
$final = RunTests
($final -split "`n" | Select-String -Pattern '^. (tests|pass|fail) ' | Select-Object -First 4) | ForEach-Object { "  " + $_.ToString().Trim() }
Write-Output ("  变异捕获率: " + $script:caught + "/" + $script:total + "（另有 " + $script:voided + " 项作废：变异点已失效，需更新脚本）")
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
if ($script:caught -lt ($script:total - $script:voided)) { exit 1 }
