# Startup benchmark (robust): time from launch to a NEWLY created visible window.
# Usage: powershell -ExecutionPolicy Bypass -File tools/bench-startup.ps1 -Runs 3 -TargetList portable,unpacked,dev
# NOTE: keep this file ASCII-only; PowerShell 5.1 misreads non-ASCII .ps1 without a BOM.
param(
  [int]$Runs = 3,
  [string]$TargetList = 'portable,unpacked,dev',
  [switch]$SkipWarmup
)

$root = Split-Path -Parent $PSScriptRoot
$Targets = $TargetList -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }

$candidates = @{
  unpacked        = Join-Path $root 'release\win-unpacked\Okey Dokey.exe'
  installed       = Join-Path $root 'release\win-unpacked\Okey Dokey.exe'
  dev             = Join-Path $root 'node_modules\electron\dist\electron.exe'
}

# Fixed pre-existing userData so "first-run creates vault" is excluded from timing.
$userData = Join-Path $env:TEMP 'okey-bench-userdata'
New-Item -ItemType Directory -Path (Join-Path $userData 'vault') -Force | Out-Null

$APP_NAMES = @('Okey Dokey', 'electron', 'Okey-Dokey-1.0.0-portable')

function Get-AppProcs {
  Get-Process -Name $APP_NAMES -ErrorAction SilentlyContinue
}

# Kill everything, then WAIT until truly gone (portable runs from a temp dir, so
# path-based filtering is unreliable -- match by name only).
function Kill-All {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $procs = Get-AppProcs
    if (-not $procs) { break }
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  Start-Sleep -Milliseconds 700
  return ((Get-AppProcs | Measure-Object).Count)
}

function Measure-One {
  param([string]$Exe, [string[]]$ArgList, [int]$TimeoutSec = 120)
  $launch = Get-Date
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  [void](Start-Process -FilePath $Exe -ArgumentList $ArgList -PassThru)
  $hit = $null
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    Start-Sleep -Milliseconds 25
    $hit = Get-AppProcs | Where-Object {
      $_.MainWindowHandle -ne 0 -and
      $_.MainWindowTitle -eq 'Okey Dokey' -and
      $_.StartTime -ge $launch.AddSeconds(-2)
    } | Select-Object -First 1
    if ($hit) { break }
  }
  $ms = [int]$sw.Elapsed.TotalMilliseconds
  $sw.Stop()
  if (-not $hit) { return -1 }
  return $ms
}

function Measure-Mem {
  param([string]$Exe, [string[]]$ArgList)
  [void](Start-Process -FilePath $Exe -ArgumentList $ArgList -PassThru)
  Start-Sleep -Seconds 10
  $procs = Get-AppProcs
  if (-not $procs) { return -1 }
  return [int]((($procs | Measure-Object WorkingSet64 -Sum).Sum) / 1MB)
}

$results = @{}
foreach ($t in $Targets) {
  $exe = $candidates[$t]
  if (-not $exe -or -not (Test-Path $exe)) { Write-Host "SKIP $t (not found: $exe)"; continue }
  $argList = if ($t -eq 'dev') { @('.', "--user-data-dir=$userData") } else { @("--user-data-dir=$userData") }

  $left = Kill-All
  if ($left -gt 0) { Write-Host "[$t] WARNING: $left stale process(es) could not be killed"; }

  if (-not $SkipWarmup) {
    Write-Host "[$t] warmup (excluded)..."
    [void](Measure-One -Exe $exe -ArgList $argList)
    [void](Kill-All)
  }

  $times = @()
  for ($i = 1; $i -le $Runs; $i++) {
    $ms = Measure-One -Exe $exe -ArgList $argList
    [void](Kill-All)
    if ($ms -gt 0) { $times += $ms; Write-Host ("[{0}] run {1}: {2} ms" -f $t, $i, $ms) }
    else { Write-Host ("[{0}] run {1}: window not found" -f $t, $i) }
  }

  $mem = Measure-Mem -Exe $exe -ArgList $argList
  [void](Kill-All)

  if ($times.Count -gt 0) {
    $sorted = $times | Sort-Object
    $results[$t] = [ordered]@{
      runs     = ($times -join ', ')
      minMs    = $sorted[0]
      medianMs = $sorted[[math]::Floor($sorted.Count / 2)]
      maxMs    = $sorted[-1]
      memMB    = $mem
    }
  }
}

Write-Host ''
Write-Host ('BENCH_RESULT ' + ($results | ConvertTo-Json -Depth 4 -Compress))
[void](Kill-All)
