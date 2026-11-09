param(
  [string]$OutputDirectory = 'artifacts'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repo

$runtimeDir = Join-Path $repo 'packaging/runtime'
$cargoTargetRelease = Join-Path $env:LOCALAPPDATA 'Rupelian/cargo-target/release'
$srcTauri = Join-Path $repo 'src-tauri'

$tauriConfig = Get-Content -LiteralPath (Join-Path $srcTauri 'tauri.conf.json') | ConvertFrom-Json
$version = $tauriConfig.version

# Ensure directory junction exists for tauri cli
$targetRelease = Join-Path $srcTauri 'target/release'
if (-not (Test-Path $targetRelease)) {
  New-Item -ItemType Junction -Path $targetRelease -Target $cargoTargetRelease -Force | Out-Null
}

$outputDirFullPath = Join-Path $repo $OutputDirectory
New-Item -ItemType Directory -Path $outputDirFullPath -Force | Out-Null

$nsisDir = Join-Path $targetRelease 'bundle/nsis'

# 1. Build frontend distribution assets
Write-Host "Building frontend assets..."
& npm run build
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE" }

# 2. Build release binaries (EXE + DLL) with custom-protocol enabled by default
Write-Host "Building release binaries (EXE + DLL)..."
& node (Join-Path $repo 'scripts/cargo-with-runtime.mjs') build --release --manifest-path (Join-Path $srcTauri 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw "Rust release build failed with exit code $LASTEXITCODE" }

# Stage DLLs for bundling
Copy-Item -LiteralPath (Join-Path $cargoTargetRelease 'rupelian_lib.dll') -Destination (Join-Path $srcTauri 'rupelian_lib.dll') -Force
Copy-Item -LiteralPath (Join-Path $runtimeDir 'vcruntime140.dll') -Destination (Join-Path $srcTauri 'vcruntime140.dll') -Force
Copy-Item -LiteralPath (Join-Path $runtimeDir 'vulkan-1.dll') -Destination (Join-Path $srcTauri 'vulkan-1.dll') -Force

try {
  # Build Standalone Windows Installer named strictly Rupelian.exe
  Write-Host "Building Rupelian Windows Installer v$version..."
  Remove-Item -Path "$nsisDir/*" -Recurse -Force -ErrorAction SilentlyContinue
  & npx tauri build --bundles nsis -c (Join-Path $srcTauri 'tauri.nsis.conf.json')
  if ($LASTEXITCODE -ne 0) { throw "Tauri NSIS build failed with exit code $LASTEXITCODE" }

  $setupExe = Get-ChildItem -Path $nsisDir -Filter "*$version*setup.exe" | Select-Object -First 1
  if (-not $setupExe) {
    $setupExe = Get-ChildItem -Path $nsisDir -Filter '*setup.exe' | Select-Object -First 1
  }
  if (-not $setupExe) { throw "NSIS installer was not found in $nsisDir" }

  # Permanent naming rule: strictly Rupelian-Player.exe (no 'setup', 'installer', 'update', or suffixes)
  $destinationExe = Join-Path $outputDirFullPath "Rupelian-Player.exe"
  Move-Item -LiteralPath $setupExe.FullName -Destination $destinationExe -Force
  $hash = (Get-FileHash -LiteralPath $destinationExe -Algorithm SHA256).Hash
  Set-Content -LiteralPath "$destinationExe.sha256.txt" -Value $hash -Encoding utf8
  $size = (Get-Item $destinationExe).Length

} finally {
  # Clean up staging DLLs from src-tauri
  Remove-Item -LiteralPath (Join-Path $srcTauri 'rupelian_lib.dll') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $srcTauri 'vcruntime140.dll') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $srcTauri 'vulkan-1.dll') -Force -ErrorAction SilentlyContinue
}

# Update version.json with actual hash and size
$manifestPath = Join-Path $repo 'version.json'
if (Test-Path $manifestPath) {
  $manifest = Get-Content -LiteralPath $manifestPath | ConvertFrom-Json
  $manifest.version = $version
  $manifest.name = "Rupelian Player v$version"
  $manifest.packages.'windows-x64'.url = "https://github.com/hamides-dev/rupelian/releases/download/v$version/Rupelian-Player.exe"
  $manifest.packages.'windows-x64'.sha256 = $hash
  $manifest.packages.'windows-x64'.size = $size
  $manifest.packages.'windows-x64'.description = "Rupelian Player Windows Installer"
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
}

[PSCustomObject]@{
  Version = $version
  Installer = $destinationExe
  SizeMB = [math]::Round($size / 1MB, 2)
  SHA256 = $hash
}
