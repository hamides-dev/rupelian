param(
  [string]$OutputDirectory = 'artifacts'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repo

$runtimeDir = Join-Path $repo 'packaging/runtime'
$cargoTargetRelease = Join-Path $env:LOCALAPPDATA 'Rupelian/cargo-target/release'
$srcTauri = Join-Path $repo 'src-tauri'

# Ensure directory junction exists for tauri cli
$targetRelease = Join-Path $srcTauri 'target/release'
if (-not (Test-Path $targetRelease)) {
  New-Item -ItemType Junction -Path $targetRelease -Target $cargoTargetRelease -Force | Out-Null
}

# Stage DLLs for bundling
Copy-Item -LiteralPath (Join-Path $cargoTargetRelease 'rupelian_lib.dll') -Destination (Join-Path $srcTauri 'rupelian_lib.dll') -Force
Copy-Item -LiteralPath (Join-Path $runtimeDir 'vcruntime140.dll') -Destination (Join-Path $srcTauri 'vcruntime140.dll') -Force
Copy-Item -LiteralPath (Join-Path $runtimeDir 'vulkan-1.dll') -Destination (Join-Path $srcTauri 'vulkan-1.dll') -Force

try {
  & npx tauri build --bundles nsis -c (Join-Path $srcTauri 'tauri.nsis.conf.json')
  if ($LASTEXITCODE -ne 0) { throw "Tauri NSIS build failed with exit code $LASTEXITCODE" }
} finally {
  # Clean up staging DLLs from src-tauri
  Remove-Item -LiteralPath (Join-Path $srcTauri 'rupelian_lib.dll') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $srcTauri 'vcruntime140.dll') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $srcTauri 'vulkan-1.dll') -Force -ErrorAction SilentlyContinue
}

$nsisDir = Join-Path $targetRelease 'bundle/nsis'
$setupExe = Get-ChildItem -Path $nsisDir -Filter '*setup.exe' | Select-Object -First 1
if (-not $setupExe) {
  throw "NSIS installer was not found in $nsisDir"
}

$outputDirFullPath = Join-Path $repo $OutputDirectory
New-Item -ItemType Directory -Path $outputDirFullPath -Force | Out-Null

$destinationExe = Join-Path $outputDirFullPath 'Rupelian-Player-Setup-v0.1.0.exe'
Copy-Item -LiteralPath $setupExe.FullName -Destination $destinationExe -Force

$hash = (Get-FileHash -LiteralPath $destinationExe -Algorithm SHA256).Hash
Set-Content -LiteralPath "$destinationExe.sha256.txt" -Value $hash -Encoding utf8

[PSCustomObject]@{
  Installer = $destinationExe
  SizeMB = [math]::Round($setupExe.Length / 1MB, 2)
  SHA256 = $hash
}
