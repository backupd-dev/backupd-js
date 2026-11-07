# Installs the backupd CLI on Windows: https://backupd.dev/cli
#
#   irm https://backupd.dev/install.ps1 | iex
#
# Options, as environment variables:
#   BACKUPD_VERSION       a version like 0.1.0 (default: the latest release)
#   BACKUPD_INSTALL_DIR   where to put backupd.exe (default: %LOCALAPPDATA%\backupd\bin)
#
# Downloads backupd.exe from the GitHub release, checks it against the
# release's SHA256SUMS, and adds the folder to your user PATH.
$ErrorActionPreference = "Stop"

$Repo = "backupd-dev/backupd-js"
$BaseUrl = if ($env:BACKUPD_DOWNLOAD_URL) { $env:BACKUPD_DOWNLOAD_URL } else { "https://github.com/$Repo/releases" }
$InstallDir = if ($env:BACKUPD_INSTALL_DIR) { $env:BACKUPD_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "backupd\bin" }

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "backupd needs 64-bit Windows. Use npm instead: npm i -g @backupd/cli"
}

$Asset = "backupd-windows-x64.exe"
$Url = if ($env:BACKUPD_VERSION) { "$BaseUrl/download/v$($env:BACKUPD_VERSION.TrimStart('v'))" } else { "$BaseUrl/latest/download" }

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  Write-Host "Downloading $Asset..."
  Invoke-WebRequest -UseBasicParsing -Uri "$Url/$Asset" -OutFile (Join-Path $Tmp "backupd.exe")
  Invoke-WebRequest -UseBasicParsing -Uri "$Url/SHA256SUMS" -OutFile (Join-Path $Tmp "SHA256SUMS")

  $Line = Get-Content (Join-Path $Tmp "SHA256SUMS") | Where-Object { $_ -match " $([Regex]::Escape($Asset))$" }
  if (-not $Line) { throw "No checksum for $Asset in the release." }
  $Expected = ($Line -split " ")[0].ToLower()
  $Actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Tmp "backupd.exe")).Hash.ToLower()
  if ($Expected -ne $Actual) { throw "Checksum mismatch for $Asset (expected $Expected, got $Actual)." }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Move-Item -Force (Join-Path $Tmp "backupd.exe") (Join-Path $InstallDir "backupd.exe")
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($UserPath -split ";" | Where-Object { $_ -eq $InstallDir })) {
  [Environment]::SetEnvironmentVariable("Path", "$InstallDir;$UserPath", "User")
  Write-Host "Added $InstallDir to your PATH. Open a new terminal to use it."
}

Write-Host ""
Write-Host "Installed $(& (Join-Path $InstallDir 'backupd.exe') --version) to $InstallDir"
Write-Host "Get started: backupd login"
