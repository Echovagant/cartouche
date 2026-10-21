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
  if ($t -notmatch [regex]::Escape($from)) { throw "pattern not found in ${rel}" }
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
  if ($failed) { Write-Host "  [PASS] $name -- 变异被测试抓到" }
  else { Write-Host "  [FAIL] $name -- 变异未被抓到，测试是假绿！" }
  ($out -split "`n" | Select-String -Pattern '✖' | Select-Object -First 2) | ForEach-Object { Write-Host ("      " + $_.ToString().Trim()) }
  return $failed
}

Write-Output "=== 变异测试：S4 栅格编辑内核 ===`n"

# 1) 掩膜：羽化公式取反（带外不再为 0）
$rel = 'src\engine\raster\mask.ts'
$b = Backup $rel; $h = Hash $rel
Mutate $rel 'const alpha = 1 - dist / feather;' 'const alpha = dist / feather;'
Write-Output "--- 变异 1：羽化公式取反 ---"
$ok1 = Report '掩膜羽化' (RunTests)
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 2) 混合：alpha 取反
$rel = 'src\engine\raster\blend.ts'
$b = Backup $rel; $h = Hash $rel
Mutate $rel 'const v = baseBand[i]! * (1 - a) + overlayBand[i]! * a;' 'const v = baseBand[i]! * a + overlayBand[i]! * (1 - a);'
Write-Output "--- 变异 2：混合时 alpha 取反 ---"
$ok2 = Report '区域混合' (RunTests)
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 3) 修补：内层不推进
$rel = 'src\engine\raster\inpaint.ts'
$b = Backup $rel; $h = Hash $rel
Mutate $rel '    if (changed === 0) break;' '    break;'
Write-Output "--- 变异 3：修补不向内推进 ---"
$ok3 = Report '边界内插修补' (RunTests)
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 4) 提亮：线性拉伸退化为恒等
$rel = 'src\engine\raster\levels.ts'
$b = Backup $rel; $h = Hash $rel
Mutate $rel 'out[i] = clamp255(Math.round((band[i]! - min) * scale));' 'out[i] = band[i]!;'
Write-Output "--- 变异 4：线性拉伸退化为恒等 ---"
$ok4 = Report '亮度调整' (RunTests)
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 5) 写回：不生成备份
$rel = 'src\engine\gdal\writeback.ts'
$b = Backup $rel; $h = Hash $rel
Mutate $rel '  if ((req.backup ?? true) && (await store.exists(req.target))) {' '  if (false && (req.backup ?? true) && (await store.exists(req.target))) {'
Write-Output "--- 变异 5：写回不生成备份 ---"
$ok5 = Report '写回备份' (RunTests)
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

# 6) 区域替换：作用范围扩大到全图（破坏"区域外零差异"）
$rel = 'src\engine\raster\ops.ts'
$b = Backup $rel; $h = Hash $rel
Mutate $rel 'const alpha = buildAlphaMask(before.width, before.height, region, req.featherPx ?? 0);' 'const alpha = buildAlphaMask(before.width, before.height, { minX: 0, minY: 0, maxX: before.width, maxY: before.height }, 0);'
Write-Output "--- 变异 6：区域替换作用到全图 ---"
$ok6 = Report '区域外零差异' (RunTests)
Restore $rel $b
Write-Output ("      已还原 hash 一致: " + ((Hash $rel) -eq $h))

Write-Output "`n--- 还原后复跑 ---"
$final = RunTests
($final -split "`n" | Select-String -Pattern '^. (tests|pass|fail) ') | ForEach-Object { Write-Host ("  " + $_.ToString().Trim()) }
$caught = @($ok1,$ok2,$ok3,$ok4,$ok5,$ok6) | Where-Object { $_ }
Write-Host ("  变异捕获率: " + $caught.Count + "/6`n")
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
