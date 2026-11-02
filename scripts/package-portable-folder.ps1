param(
  [string]$Executable = "$env:LOCALAPPDATA/Rupelian/cargo-target/release/rupelian.exe",
  [string]$Output = 'artifacts/Rupelian-0.1.0-win-x64-portable'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repo

$exe = (Resolve-Path -LiteralPath $Executable).Path
$releaseDirectory = [IO.Path]::GetDirectoryName($exe)
$playerRuntime = (Resolve-Path -LiteralPath (Join-Path $releaseDirectory 'rupelian_lib.dll')).Path
$outputPath = [IO.Path]::GetFullPath((Join-Path $repo $Output))
if (Test-Path -LiteralPath $outputPath) {
  throw "Output already exists: $outputPath"
}

function Assert-X64([string]$Path) {
  $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($Path))
  try {
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw "Invalid executable: $Path" }
    $reader.BaseStream.Position = 0x3C
    $peOffset = $reader.ReadInt32()
    $reader.BaseStream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) {
      throw "Expected Windows x64: $Path"
    }
  } finally {
    $reader.Dispose()
  }
}

Assert-X64 $exe
Assert-X64 $playerRuntime
New-Item -ItemType Directory -Path $outputPath,(Join-Path $outputPath 'binaries'),(Join-Path $outputPath 'lib') -Force | Out-Null

Copy-Item -LiteralPath $exe -Destination (Join-Path $outputPath 'Rupelian.exe')
Copy-Item -LiteralPath $playerRuntime -Destination $outputPath

foreach ($name in @('yt-dlp.exe','deno.exe','ffmpeg.exe','ffprobe.exe','ffmpeg-GPL-3.0.txt')) {
  Copy-Item -LiteralPath (Join-Path $repo "src-tauri/binaries/$name") -Destination (Join-Path $outputPath "binaries/$name")
}
foreach ($name in @('libmpv-wrapper.dll','libmpv-2.dll')) {
  $source = Join-Path $repo "src-tauri/lib/$name"
  Assert-X64 $source
  Copy-Item -LiteralPath $source -Destination (Join-Path $outputPath "lib/$name")
}
foreach ($name in @('vcruntime140.dll','vulkan-1.dll')) {
  $source = Join-Path $repo "packaging/runtime/$name"
  Assert-X64 $source
  Copy-Item -LiteralPath $source -Destination (Join-Path $outputPath $name)
}

Copy-Item -LiteralPath (Join-Path $repo 'packaging/README-PORTABLE-FOLDER.txt') -Destination (Join-Path $outputPath 'README.txt')
Copy-Item -LiteralPath (Join-Path $repo 'packaging/THIRD-PARTY-NOTICES.txt') -Destination $outputPath
Copy-Item -LiteralPath (Join-Path $repo 'packaging/licenses') -Destination $outputPath -Recurse

$files = @(Get-ChildItem -LiteralPath $outputPath -Recurse -File)
if ($files | Where-Object { $_.Name -match '(?i)webview|msedge|setup|install' }) {
  throw 'Unexpected WebView runtime or installer in folder package.'
}
$bytes = ($files | Measure-Object -Property Length -Sum).Sum
$hash = (Get-FileHash -LiteralPath (Join-Path $outputPath 'Rupelian.exe') -Algorithm SHA256).Hash

[pscustomobject]@{
  Output = $outputPath
  Files = $files.Count
  Bytes = $bytes
  ExecutableSHA256 = $hash
  WebViewBundled = $false
  StartupMode = 'Adjacent runtime files; no payload extraction'
} | ConvertTo-Json
