param(
  [int]$IntervalMinutes = 420,
  [switch]$Publish
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Runner = Join-Path $Root "scripts\run_instagram_collector.ps1"
$TaskName = "AdAuto Instagram Collector"
$Args = "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`""
if ($Publish) { $Args += " -Publish" }

$Action   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $Args -WorkingDirectory $Root
$Trigger  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
              -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
              -RepetitionDuration (New-TimeSpan -Days 3650)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Write-Host "✅ 설치 완료: $TaskName"
Write-Host "   매 $IntervalMinutes 분(7시간)마다 자동 실행됩니다."
Write-Host "   다음 실행: $((Get-Date).AddMinutes(2).ToString('yyyy-MM-dd HH:mm'))"
