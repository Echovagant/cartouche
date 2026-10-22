$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $env:TEMP 'cartouche-mut-s4'
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
  # 变异点失效（代码重构后老写法没了）时**不要抛异常中断整个脚本**：
  # 那样后面的变异一条都跑不到，看起来像"跑完了"，其实只跑了一半。
  # 标记为作废并跳过，最后在汇总里报出来。
  if ($t -notmatch [regex]::Escape($from)) {
    Write-Output "  [ERROR] 变异未生效（模式已失效）：${rel}"
    $script:voided += 1
    return $false
  }
  $t = $t -replace [regex]::Escape($from), $to
  [System.IO.File]::WriteAllText((Join-Path $root $rel), $t, (New-Object System.Text.UTF8Encoding $false))
  return $true
}
function RunTests {
  Push-Location $root
  $o = node --test 2>&1 | Out-String
  Pop-Location
  return $o
}
function Report($name, $out) {
  # 从 node --test 的汇总行里取**真实失败数**。
  # 以前是匹配 'fail 1'..'fail 3' 字面量 —— 测试数变多后，
  # 一个变异可能让 4 个以上测试变红，字面量一个都匹配不上，
  # 就会被**误报成"测试是假绿"**。
  $m = [regex]::Matches($out, '(?m)^\s*\S+\s+fail\s+(\d+)\s*$')
  $n = 0
  if ($m.Count -gt 0) { $n = [int]$m[$m.Count - 1].Groups[1].Value }
  $failed = $n -gt 0
  if ($failed) { Write-Host "  [PASS] $name -- 变异被测试抓到（$n 个测试失败 = 测试有效）" }
  else { Write-Host "  [FAIL] $name -- 变异未被抓到，测试是假绿！" }
  ($out -split "`n" | Select-String -Pattern '✖' | Select-Object -First 2) | ForEach-Object { Write-Host ("      " + $_.ToString().Trim()) }
  return $failed
}

Write-Output "=== 变异测试：S4 栅格编辑内核 ===`n"
$script:voided = 0

# 1) 掩膜：羽化公式取反（带外不再为 0）
$rel = 'src\engine\raster\mask.ts'
$b = Backup $rel; $h = Hash $rel
if (Mutate $rel 'const alpha = 1 - dist / feather;' 'const alpha = dist / feather;') {
  Write-Output "--- 变异 1：羽化公式取反 ---"
  $ok1 = Report '掩膜羽化' (RunTests)
} else { $ok1 = $null }
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 2) 混合：alpha 取反
$rel = 'src\engine\raster\blend.ts'
$b = Backup $rel; $h = Hash $rel
if (Mutate $rel 'const v = baseBand[i]! * (1 - a) + overlayBand[i]! * a;' 'const v = baseBand[i]! * a + overlayBand[i]! * (1 - a);') {
  Write-Output "--- 变异 2：混合时 alpha 取反 ---"
  $ok2 = Report '区域混合' (RunTests)
} else { $ok2 = $null }
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 3) 修补：内层不推进
$rel = 'src\engine\raster\inpaint.ts'
$b = Backup $rel; $h = Hash $rel
if (Mutate $rel '    if (changed === 0) break;' '    break;') {
  Write-Output "--- 变异 3：修补不向内推进 ---"
  $ok3 = Report '边界内插修补' (RunTests)
} else { $ok3 = $null }
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 4) 提亮：线性拉伸退化为恒等
$rel = 'src\engine\raster\levels.ts'
$b = Backup $rel; $h = Hash $rel
if (Mutate $rel 'out[i] = clamp255(Math.round((band[i]! - min) * scale));' 'out[i] = band[i]!;') {
  Write-Output "--- 变异 4：线性拉伸退化为恒等 ---"
  $ok4 = Report '亮度调整' (RunTests)
} else { $ok4 = $null }
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 5) 写回：不生成备份
# ⚠️ 变异点必须跟着代码走。2026-10-21 之前的写法是
#    `if ((req.backup ?? true) && (await store.exists(req.target))) {`，
#    后来因为"exists() 误报"会跳过备份（无备份覆盖原文件）而改成了
#    `createBackup()` —— 老写法已经不存在，脚本会直接抛
#    "pattern not found" 中断，**后面的变异一条都跑不到**（2026-10-21 踩过）。
#    这里改为直接把 createBackup 调用置空，writeBack 与 replaceFileAtomically
#    两条路径都会被覆盖到（-replace 是全量替换）。
$rel = 'src\engine\gdal\writeback.ts'
$b = Backup $rel; $h = Hash $rel
if (Mutate $rel 'backupPath = await createBackup(store, req.target, req.label);' 'backupPath = null;') {
  Write-Output "--- 变异 5：写回不生成备份 ---"
  $ok5 = Report '写回备份' (RunTests)
} else { $ok5 = $null }
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 6) 区域替换：作用范围扩大到全图（破坏"区域外零差异"）
$rel = 'src\engine\raster\ops.ts'
$b = Backup $rel; $h = Hash $rel
if (Mutate $rel 'const alpha = buildAlphaMask(before.width, before.height, region, req.featherPx ?? 0);' 'const alpha = buildAlphaMask(before.width, before.height, { minX: 0, minY: 0, maxX: before.width, maxY: before.height }, 0);') {
  Write-Output "--- 变异 6：区域替换作用到全图 ---"
  $ok6 = Report '区域外零差异' (RunTests)
} else { $ok6 = $null }
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 7) 提亮：linear-stretch 不再吃 brightness（亮度滑块退化成死控件）
#    2026-10-22 修的真 bug：调色面板默认方法就是 linear-stretch，
#    而它把 brightness 丢掉了 —— 滑块动了像元一个都没变，预演还报"影响 0 个像元"。
#    这条变异就是把修复回退掉，测试必须把它抓住。
$rel = 'src\engine\raster\levels.ts'
$b = Backup $rel; $h = Hash $rel
if (Mutate $rel 'return applyManual(out, brightness, contrast);' 'return applyManual(out, 0, contrast);') {
  Write-Output "--- 变异 7：linear-stretch 不吃 brightness ---"
  $ok7 = Report '亮度滑块' (RunTests)
} else { $ok7 = $null }
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

Write-Output "`n--- 还原后复跑 ---"
$final = RunTests
($final -split "`n" | Select-String -Pattern '^. (tests|pass|fail) ') | ForEach-Object { Write-Host ("  " + $_.ToString().Trim()) }
$caught = @($ok1,$ok2,$ok3,$ok4,$ok5,$ok6,$ok7) | Where-Object { $_ }
$voided = @($ok1,$ok2,$ok3,$ok4,$ok5,$ok6,$ok7) | Where-Object { $_ -eq $null }
Write-Host ("  变异捕获率: " + $caught.Count + "/7（另有 " + $voided.Count + " 项作废：变异点已失效，需更新脚本）`n")
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
if ($caught.Count -lt (7 - $voided.Count)) { exit 1 }
