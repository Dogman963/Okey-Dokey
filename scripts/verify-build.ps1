# Verify a packaged build: launch -> screenshot -> check files on disk -> close.
# Usage: powershell -ExecutionPolicy Bypass -File tools/verify-packaged.ps1 [-Windowed] [-DelaySeconds N] [-Target portable|unpacked]
# NOTE: keep this file ASCII-only; PowerShell 5.1 misreads non-ASCII .ps1 without a BOM.
# NOTE: variable names must not collide with param names (PowerShell vars are case-insensitive).
param(
  [switch]$Windowed,
  [int]$DelaySeconds = 12,
  [string]$Target = 'portable'
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$root = Split-Path -Parent $PSScriptRoot
if ($Target -eq 'installed') {
  $exe = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Okey Dokey\Okey Dokey.exe'
} else {
  $exe = Join-Path $root 'release\win-unpacked\Okey Dokey.exe'
}
if (-not (Test-Path $exe)) { throw "exe not found: $exe" }

# Fixed, pre-existing userData dir: keeps the check away from the real vault.
$userData = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp\okey-verify-userdata'
New-Item -ItemType Directory -Path (Join-Path $userData 'vault') -Force | Out-Null

function Kill-App {
  for ($i = 0; $i -lt 20; $i++) {
    $p = Get-Process -Name 'Okey Dokey' -ErrorAction SilentlyContinue
    if (-not $p) { break }
    $p | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400
  }
}

Kill-App
Write-Host "launching $exe"
[void](Start-Process -FilePath $exe -ArgumentList "--user-data-dir=$userData" -PassThru)

# Wait for a window that actually has a handle (avoids the startup race).
$winProc = $null
for ($i = 0; $i -lt 40; $i++) {
  $cand = Get-Process -Name 'Okey Dokey' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq 'Okey Dokey' } |
    Select-Object -First 1
  if ($cand) { $winProc = $cand; break }
  Start-Sleep -Milliseconds 750
}
if (-not $winProc) { throw 'main window not found' }
$h = [IntPtr]$winProc.MainWindowHandle
Write-Host "window found: pid=$($winProc.Id) handle=$h"

Start-Sleep -Seconds $DelaySeconds
[void][Win]::SetForegroundWindow($h)
if (-not $Windowed) { [void][Win]::ShowWindow($h, 3) }   # 3 = maximize
Start-Sleep -Seconds 3

$rect = New-Object Win+RECT
[void][Win]::GetWindowRect($h, [ref]$rect)
$w = $rect.Right - $rect.Left
$hh = $rect.Bottom - $rect.Top
Write-Host "window size: ${w}x${hh}"

$outDir = Join-Path $root 'docs\images'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$outName = if ($Windowed) { "preview-$Target-windowed.png" } else { "preview-$Target.png" }
$shot = Join-Path $outDir $outName

$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

$keyFile = Join-Path $userData 'vault\device.key'
$vaultFile = Join-Path $userData 'vault\vault.enc'
$report = [ordered]@{
  target        = $Target
  windowTitle   = $winProc.MainWindowTitle
  windowSize    = "${w}x${hh}"
  screenshot    = (Get-Item $shot).Length
  keyFileExists = (Test-Path $keyFile)
  keyFileLen    = if (Test-Path $keyFile) { (Get-Content $keyFile -Raw).Trim().Length } else { 0 }
  vaultExists   = (Test-Path $vaultFile)
}
Write-Host ('VERIFY_RESULT ' + ($report | ConvertTo-Json -Compress))

Kill-App
Remove-Item $userData -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'cleaned up'
