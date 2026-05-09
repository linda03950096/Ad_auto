param(
  [int]$IntervalMinutes = 60,
  [switch]$Publish
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Runner = Join-Path $Root "scripts\run_instagram_collector.ps1"
$TaskName = "AdAuto Instagram Collector"
$Args = "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`""
if ($Publish) { $Args += " -Publish" }

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $Args -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration ([TimeSpan]::MaxValue)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Write-Host "Installed task: $TaskName"
Write-Host "Runs every $IntervalMinutes minute(s). Publish=$Publish"
