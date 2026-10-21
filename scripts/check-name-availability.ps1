# Name availability screen: GitHub org / GitHub user / npm top-level / npm scope
# Pure ASCII on purpose (Windows PowerShell 5.1 .ps1 encoding rule).
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$names = @(
  'mapsmith','geoforge','mapwright','atlasforge','maploom','terralark',
  'atlasmith','mapmason','cartogsmith','mapsensei','mapcraft','cartosmyth',
  'mapforge','geosmyth','cartomith','mapweave','mapfoundry','atlaswright'
)

$headers = @{ 'User-Agent' = 'cartouche-name-screen' }

function Test-Gh($kind, $name) {
  $u = "https://api.github.com/$kind/$name"
  try {
    $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 20 -Headers $headers
    $j = $r.Content | ConvertFrom-Json
    $extra = ''
    if ($kind -eq 'users') {
      $extra = " type=$($j.type) repos=$($j.public_repos) created=$($j.created_at)"
    } else {
      $extra = " created=$($j.created_at) repos=$($j.public_repos)"
    }
    return "TAKEN  $extra"
  } catch {
    return 'free'
  }
}

function Test-Npm($name) {
  $u = "https://registry.npmjs.org/$name"
  try {
    $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 20 -Method Head
    $j = ($r.Content)
    return 'TAKEN'
  } catch {
    return 'free'
  }
}

function Test-NpmScope($name) {
  $u = "https://registry.npmjs.org/@$name%2fengine"
  try {
    $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 20 -Method Head
    return 'TAKEN'
  } catch {
    return 'free'
  }
}

$rows = @()
foreach ($n in $names) {
  $org = Test-Gh 'orgs' $n
  $usr = Test-Gh 'users' $n
  $npm = Test-Npm $n
  $scp = Test-NpmScope $n
  $rows += [pscustomobject]@{
    name = $n
    gh_org = $org
    gh_user = $usr
    npm_top = $npm
    npm_scope = $scp
  }
  Write-Output ("{0,-12} org={1,-10} user={2,-10} npm={3,-6} scope={4}" -f $n, ($org -split ' ')[0], ($usr -split ' ')[0], $npm, $scp)
  Start-Sleep -Milliseconds 150
}

Write-Output ''
Write-Output '=== detail for names with any TAKEN ==='
foreach ($r in $rows) {
  if ($r.gh_org -like 'TAKEN*' -or $r.gh_user -like 'TAKEN*' -or $r.npm_top -eq 'TAKEN') {
    Write-Output ("{0}: org={1} | user={2} | npm={3}" -f $r.name, $r.gh_org, $r.gh_user, $r.npm_top)
  }
}
