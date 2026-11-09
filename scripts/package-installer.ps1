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

# Stage DLLs for bundling
Copy-Item -LiteralPath (Join-Path $cargoTargetRelease 'rupelian_lib.dll') -Destination (Join-Path $srcTauri 'rupelian_lib.dll') -Force
Copy-Item -LiteralPath (Join-Path $runtimeDir 'vcruntime140.dll') -Destination (Join-Path $srcTauri 'vcruntime140.dll') -Force
Copy-Item -LiteralPath (Join-Path $runtimeDir 'vulkan-1.dll') -Destination (Join-Path $srcTauri 'vulkan-1.dll') -Force

try {
  # 1. Build Full Standalone Installer
  Write-Host "Building Full Standalone Setup Installer v$version..."
  & npx tauri build --bundles nsis -c (Join-Path $srcTauri 'tauri.nsis.conf.json')
  if ($LASTEXITCODE -ne 0) { throw "Tauri full NSIS build failed with exit code $LASTEXITCODE" }

  $setupExe = Get-ChildItem -Path $nsisDir -Filter '*setup.exe' | Select-Object -First 1
  if (-not $setupExe) { throw "Full NSIS installer was not found in $nsisDir" }

  $fullInstallerExe = Join-Path $outputDirFullPath "Rupelian-Player-Setup-v$version.exe"
  Move-Item -LiteralPath $setupExe.FullName -Destination $fullInstallerExe -Force
  $fullHash = (Get-FileHash -LiteralPath $fullInstallerExe -Algorithm SHA256).Hash
  Set-Content -LiteralPath "$fullInstallerExe.sha256.txt" -Value $fullHash -Encoding utf8
  $fullSize = (Get-Item $fullInstallerExe).Length

  # 2. Build Lightweight Fast Patch Installer
  Write-Host "Building Lightweight Fast Patch Installer v$version..."
  & npx tauri build --bundles nsis -c (Join-Path $srcTauri 'tauri.patch.conf.json')
  if ($LASTEXITCODE -ne 0) { throw "Tauri patch NSIS build failed with exit code $LASTEXITCODE" }

  $patchExe = Get-ChildItem -Path $nsisDir -Filter '*setup.exe' | Select-Object -First 1
  if (-not $patchExe) { throw "Patch NSIS installer was not found in $nsisDir" }

  $fastPatchExe = Join-Path $outputDirFullPath "Rupelian-Player-Update-v$version.exe"
  Move-Item -LiteralPath $patchExe.FullName -Destination $fastPatchExe -Force
  $patchHash = (Get-FileHash -LiteralPath $fastPatchExe -Algorithm SHA256).Hash
  Set-Content -LiteralPath "$fastPatchExe.sha256.txt" -Value $patchHash -Encoding utf8
  $patchSize = (Get-Item $fastPatchExe).Length

} finally {
  # Clean up staging DLLs from src-tauri
  Remove-Item -LiteralPath (Join-Path $srcTauri 'rupelian_lib.dll') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $srcTauri 'vcruntime140.dll') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $srcTauri 'vulkan-1.dll') -Force -ErrorAction SilentlyContinue
}

# Update version.json with actual hashes and sizes
$manifestPath = Join-Path $repo 'version.json'
if (Test-Path $manifestPath) {
  $manifest = Get-Content -LiteralPath $manifestPath | ConvertFrom-Json
  $manifest.version = $version
  $manifest.name = "Rupelian Player v$version"
  $manifest.packages.'windows-x64-patch'.sha256 = $patchHash
  $manifest.packages.'windows-x64-patch'.size = $patchSize
  $manifest.packages.'windows-x64-installer'.sha256 = $fullHash
  $manifest.packages.'windows-x64-installer'.size = $fullSize
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
}

[PSCustomObject]@{
  Version = $version
  FullInstaller = $fullInstallerExe
  FullSizeMB = [math]::Round($fullSize / 1MB, 2)
  FullSHA256 = $fullHash
  PatchInstaller = $fastPatchExe
  PatchSizeMB = [math]::Round($patchSize / 1MB, 2)
  PatchSHA256 = $patchHash
}
