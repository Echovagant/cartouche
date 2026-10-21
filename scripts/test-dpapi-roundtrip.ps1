# Verify the DPAPI round-trip used by scripts\set-key.ps1 / scripts\run-engine.ps1.
# Pure ASCII (PS 5.1 rule: no BOM => no non-ASCII).
$ErrorActionPreference = 'Stop'
$testKey = 'sk-mock-0123456789abcdefghijklmnopqrstuvwxyz'   # secret-scan:allow

# 1) encrypt like set-key.ps1 does
$sec = ConvertTo-SecureString -String $testKey -AsPlainText -Force
$enc = ConvertFrom-SecureString -SecureString $sec

Write-Output ("ciphertext length : " + $enc.Length)
Write-Output ("contains plaintext : " + $enc.Contains($testKey))
Write-Output ("looks like DPAPI  : " + ($enc -match '^[0-9a-f]{40,}$'))

# 2) decrypt like run-engine.ps1 does
$sec2 = ConvertTo-SecureString $enc
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec2)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
Write-Output ("round-trip equal  : " + ($plain -ceq $testKey))

# 3) file round-trip (what the two scripts actually do)
$tmp = Join-Path $env:TEMP 'cartouche-dpapi-test.txt'
[IO.File]::WriteAllText($tmp, $enc, (New-Object Text.UTF8Encoding($false)))
$readBack = [IO.File]::ReadAllText($tmp).Trim()
$sec3 = ConvertTo-SecureString $readBack
$b3 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec3)
try {
  $plain3 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b3)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b3)
}
Write-Output ("file round-trip   : " + ($plain3 -ceq $testKey))
Write-Output ("file is plaintext : " + ([IO.File]::ReadAllText($tmp).Contains($testKey)))
Remove-Item $tmp -Force

# 4) wrong user cannot decrypt (simulated by corrupting the ciphertext)
$bad = $enc.Substring(0, $enc.Length - 4) + 'dead'
try {
  $s = ConvertTo-SecureString $bad
  Write-Output 'tampered decrypt  : UNEXPECTEDLY SUCCEEDED'
} catch {
  Write-Output 'tampered decrypt  : correctly rejected'
}
