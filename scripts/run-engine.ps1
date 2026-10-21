# Start the local engine service with the MiniMax key loaded from DPAPI ciphertext.
#
# The key is decrypted into this process's environment and handed to the child
# process. It is never written to disk in plaintext and never echoed.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-engine.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-engine.ps1 -Port 8787
#
# Pure ASCII on purpose (Windows PowerShell 5.1 .ps1 encoding rule).

param(
  [int]$Port = 8787,
  [switch]$NoKey
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$keyFile = Join-Path $env:LOCALAPPDATA 'cartouche\llm-key.txt'

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
      # report only presence, never the value
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

Write-Output "[engine] starting on http://127.0.0.1:$Port (workspace root: $repoRoot\workspace)"
Set-Location $repoRoot
& npm -w server run dev
