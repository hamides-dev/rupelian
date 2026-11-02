param(
  [switch]$Check,
  [switch]$Force,
  [string[]]$Component = @(),
  [string]$Root = (Join-Path $PSScriptRoot '..')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$rootPath = [IO.Path]::GetFullPath($Root)
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'media-dependencies.json') -Raw | ConvertFrom-Json
$selected = @($manifest.dependencies | Where-Object { $Component.Count -eq 0 -or $_.name -in $Component })
if ($selected.Count -eq 0 -or @($Component | Where-Object { $_ -notin $manifest.dependencies.name }).Count -gt 0) {
  throw 'Unknown component. Use yt-dlp, deno, ffmpeg, libmpv, or libmpv-wrapper.'
}
$cache = Join-Path $rootPath '.cache/media-downloads'

function Assert-Hash([string]$Path, [string]$Expected) {
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing dependency: $Path" }
  if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Expected) {
    throw "SHA256 mismatch: $Path. Existing files were not replaced. Use -Force only to restore the pinned dependency."
  }
}

function Download-File([string]$Url, [string]$Destination) {
  if (![Uri]::IsWellFormedUriString($Url, [UriKind]::Absolute) -or !($Url.StartsWith('https://'))) {
    throw 'Dependencies must use HTTPS.'
  }
  $partial = "$Destination.download"
  $client = New-Object Net.WebClient
  try {
    $client.Headers['User-Agent'] = 'Rupelian-Development-Setup'
    $client.DownloadFile($Url, $partial)
    Move-Item -LiteralPath $partial -Destination $Destination -Force
  } finally { $client.Dispose() }
}

foreach ($dependency in $selected) {
  $complete = $true
  foreach ($file in $dependency.files) {
    $target = Join-Path $rootPath $file.path
    if (!(Test-Path -LiteralPath $target -PathType Leaf)) { $complete = $false; continue }
    if (!$Force -or $Check) { Assert-Hash $target $file.sha256 }
    elseif ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $file.sha256) { $complete = $false }
  }
  if ($complete) { Write-Host "$($dependency.name): verified"; continue }
  if ($Check) { throw "Missing $($dependency.name). Run npm run setup:media." }
  New-Item -ItemType Directory -Path $cache -Force | Out-Null
  $archive = Join-Path $cache "$($dependency.name).$($dependency.format)"
  Write-Host "Downloading pinned $($dependency.name) $($dependency.version)..."
  Download-File $dependency.url $archive
  if ($dependency.sha256) { Assert-Hash $archive $dependency.sha256 }
  $staging = Join-Path $cache ("$($dependency.name)-expanded-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $staging | Out-Null
  if ($dependency.format -eq 'zip') {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $staging)
  } elseif ($dependency.format -eq '7z') {
    $extractor = Join-Path $cache '7zr.exe'
    if (!(Test-Path -LiteralPath $extractor)) { Download-File $manifest.extractor.url $extractor }
    Assert-Hash $extractor $manifest.extractor.sha256
    & $extractor x $archive "-o$staging" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not extract $($dependency.name)." }
  }
  foreach ($file in $dependency.files) {
    if ($dependency.format -eq 'exe') { $source = $archive }
    else {
      $matches = @(Get-ChildItem -LiteralPath $staging -Recurse -File | Where-Object { $_.Name -eq $file.member })
      if ($matches.Count -ne 1) { throw "Expected one $($file.member) in $($dependency.name)." }
      $source = $matches[0].FullName
    }
    Assert-Hash $source $file.sha256
    $target = [IO.Path]::GetFullPath((Join-Path $rootPath $file.path))
    if (!$target.StartsWith($rootPath.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'A dependency target escaped the selected project root.'
    }
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
  }
  # Delete only this verified, task-owned extraction directory within our cache.
  $stagingPath = [IO.Path]::GetFullPath($staging)
  $cachePrefix = [IO.Path]::GetFullPath($cache).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (!$stagingPath.StartsWith($cachePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid extraction cleanup path.' }
  Remove-Item -LiteralPath $stagingPath -Recurse -Force
  Write-Host "$($dependency.name): installed and verified"
}
