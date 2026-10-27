# Registers the JobApplyWorker scheduled task: one worker tick at logon and every 15 minutes while Eyal is logged on.
# Run once (PowerShell, as the normal user):  powershell -ExecutionPolicy Bypass -File install-task.ps1
# Remove with uninstall-task.ps1. Trigger a tick by hand: schtasks /Run /TN JobApplyWorker
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}\run-hidden.vbs" "{0}\worker.cmd"' -f $dir) -WorkingDirectory $dir
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Delay = 'PT2M'
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 45) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'JobApplyWorker' -Action $action -Trigger @($logon, $repeat) -Settings $settings -Principal $principal -Description 'Job search: submits queued practice-tier applications from the Job Pipeline board (one tick at logon and every 15 min).' -Force | Out-Null
Write-Host 'JobApplyWorker registered: at logon (+2 min) and every 15 minutes while logged on.'
Get-ScheduledTask -TaskName 'JobApplyWorker' | Select-Object TaskName, State
