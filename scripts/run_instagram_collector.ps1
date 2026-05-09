param(
  [switch]$Publish
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

if (-not (Test-Path "node_modules\playwright")) {
  npm install
}

if ($Publish) {
  npm run collect:instagram:publish
} else {
  npm run collect:instagram
}
