# pack.ps1 - package dsh-bridge into an installable plugin zip
# usage: powershell -NoProfile -File pack.ps1 [outDir]
# output: <outDir>/dsh-bridge-<version>.zip (+ .sha256)

param(
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
if ($PSScriptRoot) {
    $Root = $PSScriptRoot
} elseif ($MyInvocation.MyCommand.Path) {
    $Root = Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
    $Root = (Get-Location).Path
}
if (-not $OutDir) { $OutDir = (Join-Path $Root 'dist') }
$Manifest = Get-Content (Join-Path $Root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Version = $Manifest.version
$ZipName = "dsh-bridge-$Version.zip"
$ZipPath = Join-Path $OutDir $ZipName

$Include = @('index.js', 'manifest.json', 'README.md', 'lib', 'tools', 'skills')

if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$Staging = Join-Path $OutDir '_staging'
New-Item -ItemType Directory -Path $Staging -Force | Out-Null
foreach ($item in $Include) {
    $src = Join-Path $Root $item
    if (Test-Path $src) { Copy-Item $src $Staging -Recurse -Force }
}
Get-ChildItem $Staging -Recurse -Include '*.tmp', '.write-test*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

Compress-Archive -Path (Join-Path $Staging '*') -DestinationPath $ZipPath -CompressionLevel Optimal

$Hash = (Get-FileHash $ZipPath -Algorithm SHA256).Hash
Set-Content -Path "$ZipPath.sha256" -Value $Hash -Encoding UTF8

Remove-Item $Staging -Recurse -Force

Write-Output "packed: $ZipPath"
Write-Output "SHA256: $Hash"
Write-Output "size: $([int]((Get-Item $ZipPath).Length / 1KB)) KB"
