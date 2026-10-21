param(
  [string]$InstallRoot = "$env:USERPROFILE\miniconda3",
  [string]$EnvName = "gdal",
  [string]$PkgsDir = "F:\conda-pkgs"
)
$ErrorActionPreference = 'Stop'
function Say($m) { Write-Output ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }

$installer = Join-Path $env:TEMP "Miniconda3-latest-Windows-x86_64.exe"
$conda = Join-Path $InstallRoot "Scripts\conda.exe"

if (-not (Test-Path $conda)) {
  Say "Downloading Miniconda (TUNA mirror first)..."
  $urls = @(
    'https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-latest-Windows-x86_64.exe',
    'https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-py312_25.1.1-1-Windows-x86_64.exe',
    'https://repo.anaconda.com/miniconda/Miniconda3-latest-Windows-x86_64.exe'
  )
  $ok = $false
  foreach ($u in $urls) {
    try {
      Invoke-WebRequest -Uri $u -OutFile $installer -UseBasicParsing -TimeoutSec 1200
      if ((Get-Item $installer).Length -gt 20MB) { $ok = $true; Say ("Downloaded: {0} ({1} MB)" -f $u, [math]::Round((Get-Item $installer).Length/1MB,1)); break }
    } catch { Say ("Download failed: {0} -> {1}" -f $u, $_.Exception.Message) }
  }
  if (-not $ok) { throw "Miniconda download failed" }

  Say ("Installing silently to {0} ..." -f $InstallRoot)
  $p = Start-Process -FilePath $installer -ArgumentList "/InstallationType=JustMe","/RegisterPython=0","/AddToPath=0","/S","/D=$InstallRoot" -Wait -PassThru
  Say ("Installer exit code: {0}" -f $p.ExitCode)
  if (-not (Test-Path $conda)) { throw "conda.exe not found at $conda" }
}

# conda-forge only, via TUNA mirror. Avoids the defaults channel (Anaconda commercial terms).
$condarc = Join-Path $env:USERPROFILE ".condarc"
$condarcBody = @(
  "channels:",
  "  - conda-forge",
  "show_channel_urls: true",
  "default_channels:",
  "  - https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main",
  "  - https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/r",
  "custom_channels:",
  "  conda-forge: https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud"
)
# Keep the package cache off the system drive when the target volume exists.
# The cache grows without bound as more packages are installed.
if ($PkgsDir -and (Test-Path (Split-Path -Qualifier $PkgsDir))) {
  $condarcBody += ""
  $condarcBody += "pkgs_dirs:"
  $condarcBody += "  - $PkgsDir"
  Say ("Package cache will live at: {0}" -f $PkgsDir)
} else {
  Say ("Skipping pkgs_dirs (target drive not present): {0}" -f $PkgsDir)
}
$condarcBody += ""
[System.IO.File]::WriteAllText($condarc, ($condarcBody -join "`n"), (New-Object System.Text.UTF8Encoding $false))
Say ("Wrote {0} (conda-forge via TUNA only)" -f $condarc)

$envPath = Join-Path $InstallRoot "envs\$EnvName"
$bin = Join-Path $envPath "Library\bin"
if (-not (Test-Path (Join-Path $bin "gdalinfo.exe"))) {
  Say ("Creating conda env '{0}' with gdal/proj/geos ..." -f $EnvName)
  & $conda create -y -n $EnvName -c conda-forge gdal proj geos
  if ($LASTEXITCODE -ne 0) { throw "conda create failed, exit code $LASTEXITCODE" }
} else {
  Say ("Env '{0}' already present, skipping create" -f $EnvName)
}

Say ("GDAL bin dir: {0}" -f $bin)
& (Join-Path $bin "gdalinfo.exe") --version
Say "Checking required drivers..."
$rasterFmt = & (Join-Path $bin "gdalinfo.exe") --formats
$vectorFmt = & (Join-Path $bin "ogrinfo.exe") --formats
foreach ($pair in @(@('GTiff', $rasterFmt), @('PNG', $rasterFmt), @('OpenFileGDB', $vectorFmt), @('ESRI Shapefile', $vectorFmt), @('GeoJSON', $vectorFmt), @('GPKG', $vectorFmt))) {
  $d = $pair[0]; $src = $pair[1]
  $hit = $src | Select-String -Pattern $d | Select-Object -First 1
  if ($hit) { Say ("  [OK]   {0}" -f $hit.ToString().Trim()) } else { Say ("  [MISS] {0}" -f $d) }
}
Say "DONE_MARKER"
