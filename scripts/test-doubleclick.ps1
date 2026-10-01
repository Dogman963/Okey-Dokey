# Test the unpacked (directory) build the way a user actually runs it:
#   A) plain double-click (no arguments) at its built location
#   B) after moving the whole folder to another drive path
#   C) when the folder path contains non-ASCII characters
# Usage: powershell -ExecutionPolicy Bypass -File tools/test-doubleclick.ps1
# NOTE: keep this file ASCII-only; PowerShell 5.1 misreads non-ASCII .ps1 without a BOM.
param(
  [int]$Runs = 1
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Wnd {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@

$root = Split-Path -Parent $PSScriptRoot
$srcDir = Join-Path $root 'release\win-unpacked'
$exeName = 'Okey Dokey.exe'

if (-not (Test-Path (Join-Path $srcDir $exeName))) { throw "unpacked build missing: $srcDir" }

$localApp = [Environment]::GetFolderPath('LocalApplicationData')
$temp = Join-Path $localApp 'Temp'
$appData = [Environment]::GetFolderPath('ApplicationData')
$dataDir = Join-Path $appData 'Okey Dokey'

# Non-ASCII folder name (U+6D4B U+8BD5 = "test" in Chinese), built from code points
# so this script stays ASCII-only.
$cjk = ([char]0x6D4B).ToString() + ([char]0x8BD5).ToString()
$moveTarget = Join-Path $temp ("OkeyMove_" + $cjk)

function Kill-App {
  for ($i = 0; $i -lt 25; $i++) {
    $p = Get-Process -Name 'Okey Dokey' -ErrorAction SilentlyContinue
    if (-not $p) { break }
    $p | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 350
  }
  Start-Sleep -Milliseconds 400
}

function Test-Launch {
  param([string]$ExePath, [string]$Label)
  Kill-App
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  # No arguments at all == what a double-click does
  $proc = Start-Process -FilePath $ExePath -PassThru
  $hit = $null
  while ($sw.Elapsed.TotalSeconds -lt 90) {
    Start-Sleep -Milliseconds 50
    $hit = Get-Process -Name 'Okey Dokey' -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq 'Okey Dokey' } |
      Select-Object -First 1
    if ($hit) { break }
  }
  $ms = [int]$sw.Elapsed.TotalMilliseconds
  $sw.Stop()
  $visible = $false
  if ($hit) { $visible = [Wnd]::IsWindowVisible([IntPtr]$hit.MainWindowHandle) }
  $keyFile = Join-Path $dataDir 'vault\device.key'
  $result = [ordered]@{
    scenario     = $Label
    launched     = [bool]$hit
    msToWindow   = $ms
    windowTitle  = if ($hit) { $hit.MainWindowTitle } else { '' }
    windowVisible = $visible
    dataDirUsed  = (Test-Path $dataDir)
    deviceKey    = (Test-Path $keyFile)
  }
  Kill-App
  return $result
}

$results = @()

# ---- A) double-click at the built location -------------------------------
if (Test-Path $dataDir) { Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue }
$results += Test-Launch -ExePath (Join-Path $srcDir $exeName) -Label 'A: double-click in dist\win-unpacked'

# ---- B) move whole folder to a Latin path under TEMP --------------------
$moveA = Join-Path $temp 'OkeyMovePlain'
if (Test-Path $moveA) { Remove-Item $moveA -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host "copying folder to $moveA (this takes a moment)..."
Copy-Item $srcDir $moveA -Recurse -Force
$results += Test-Launch -ExePath (Join-Path $moveA $exeName) -Label 'B: moved to another folder'

# ---- C) move whole folder to a path containing non-ASCII characters -----
if (Test-Path $moveTarget) { Remove-Item $moveTarget -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host "copying folder to non-ASCII path..."
Copy-Item $srcDir $moveTarget -Recurse -Force
$results += Test-Launch -ExePath (Join-Path $moveTarget $exeName) -Label 'C: moved to non-ASCII path'

# ---- D) copying ONLY the exe must fail (documenting the real constraint) -
$loneDir = Join-Path $temp 'OkeyLoneExe'
if (Test-Path $loneDir) { Remove-Item $loneDir -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $loneDir -Force | Out-Null
Copy-Item (Join-Path $srcDir $exeName) $loneDir -Force
$loneResult = Test-Launch -ExePath (Join-Path $loneDir $exeName) -Label 'D: exe copied ALONE (expected failure)'
$results += $loneResult

# ---- cleanup -------------------------------------------------------------
foreach ($p in @($moveA, $moveTarget, $loneDir)) {
  if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}
if (Test-Path $dataDir) { Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue }
Kill-App

Write-Host ''
Write-Host ('DOUBLECLICK_RESULT ' + ($results | ConvertTo-Json -Depth 4 -Compress))
