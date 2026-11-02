param(
  [string]$Executable = "$env:LOCALAPPDATA/Rupelian/cargo-target/release/rupelian.exe",
  [string]$Output = 'artifacts/Rupelian-0.1.0-win-x64-fast-start.exe'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repo
$exe = (Resolve-Path -LiteralPath $Executable).Path
$outputPath = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $outputPath) { throw 'Output already exists; choose a new output filename.' }
$archiver = Join-Path $repo 'packaging/sfx/7zr.exe'

function Assert-X64([string]$Path) {
  $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($Path))
  try {
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw "Invalid executable: $Path" }
    $reader.BaseStream.Position = 0x3C
    $peOffset = $reader.ReadInt32()
    $reader.BaseStream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) { throw "Expected Windows x64: $Path" }
  } finally { $reader.Dispose() }
}
Assert-X64 $exe
Assert-X64 $archiver

$buildRoot = Join-Path $repo ('src-tauri/target/portable-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $buildRoot 'payload'
New-Item -ItemType Directory -Path $stage,(Join-Path $stage 'binaries'),(Join-Path $stage 'lib') -Force | Out-Null
$playerRuntime = Join-Path ([IO.Path]::GetDirectoryName($exe)) 'rupelian_lib.dll'
Assert-X64 $playerRuntime
Copy-Item -LiteralPath $playerRuntime -Destination $stage
foreach ($name in @('yt-dlp.exe','deno.exe','ffmpeg.exe','ffprobe.exe','ffmpeg-GPL-3.0.txt')) {
  Copy-Item -LiteralPath (Join-Path $repo "src-tauri/binaries/$name") -Destination (Join-Path $stage "binaries/$name")
}
foreach ($name in @('libmpv-wrapper.dll','libmpv-2.dll')) {
  $source = Join-Path $repo "src-tauri/lib/$name"
  Assert-X64 $source
  Copy-Item -LiteralPath $source -Destination (Join-Path $stage "lib/$name")
}
foreach ($name in @('vcruntime140.dll','vulkan-1.dll')) {
  $source = Join-Path $repo "packaging/runtime/$name"
  Assert-X64 $source
  Copy-Item -LiteralPath $source -Destination (Join-Path $stage $name)
}
Copy-Item -LiteralPath (Join-Path $repo 'packaging/README-SINGLE-EXE.txt') -Destination (Join-Path $stage 'README.txt')
Copy-Item -LiteralPath (Join-Path $repo 'packaging/THIRD-PARTY-NOTICES.txt') -Destination $stage
Copy-Item -LiteralPath (Join-Path $repo 'packaging/licenses') -Destination $stage -Recurse
$files = @(Get-ChildItem -LiteralPath $stage -Recurse -File)
if ($files | Where-Object { $_.Name -match '(?i)webview|msedge|setup|install' }) { throw 'Unexpected runtime or installer in payload.' }
$archive = Join-Path $buildRoot 'payload.7z'
Push-Location -LiteralPath $stage
try {
  # Extraction happens once, after the native loading window is visible.
  & $archiver a -t7z -m0=lzma2 -mx=5 -md=16m -ms=64m -mmt=2 $archive '.\*'
  if ($LASTEXITCODE -ne 0) { throw 'Payload compression failed.' }
} finally { Pop-Location }
& $archiver t $archive
if ($LASTEXITCODE -ne 0) { throw 'Payload archive integrity check failed.' }

# Footer: 16-byte magic, three little-endian u64 lengths, 64-byte SHA256 hex.
# Hash both the helper and payload before executing the embedded helper.
$payloadHasher = [Security.Cryptography.SHA256]::Create()
try {
  $buffer = New-Object byte[] 65536
  foreach ($part in @($archiver, $archive)) {
    $inputStream = [IO.File]::OpenRead($part)
    try {
      while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        [void]$payloadHasher.TransformBlock($buffer, 0, $count, $buffer, 0)
      }
    } finally { $inputStream.Dispose() }
  }
  [void]$payloadHasher.TransformFinalBlock([byte[]]@(), 0, 0)
  $payloadHash = ([BitConverter]::ToString($payloadHasher.Hash)).Replace('-','').ToLowerInvariant()
} finally { $payloadHasher.Dispose() }

New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($outputPath)) -Force | Out-Null
$outputStream = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
try {
  foreach ($part in @($exe, $archiver, $archive)) {
    $inputStream = [IO.File]::OpenRead($part)
    try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose() }
  }
  $footer = [IO.BinaryWriter]::new($outputStream, [Text.Encoding]::UTF8, $true)
  try {
    $footer.Write([Text.Encoding]::ASCII.GetBytes('LINGOCINEMAPKG01'))
    $footer.Write([uint64](Get-Item -LiteralPath $exe).Length)
    $footer.Write([uint64](Get-Item -LiteralPath $archiver).Length)
    $footer.Write([uint64](Get-Item -LiteralPath $archive).Length)
    $footer.Write([Text.Encoding]::ASCII.GetBytes($payloadHash))
  } finally { $footer.Dispose() }
} finally { $outputStream.Dispose() }
Assert-X64 $outputPath
$hash = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash
[IO.File]::WriteAllText($outputPath + '.sha256.txt', $hash + '  ' + [IO.Path]::GetFileName($outputPath) + "`r`n")
[pscustomobject]@{Output=$outputPath; Bytes=(Get-Item -LiteralPath $outputPath).Length; SHA256=$hash; PayloadHash=$payloadHash; PayloadFiles=$files.Count; WebViewBundled=$false; CacheMode='Extract once per payload hash'} | ConvertTo-Json
