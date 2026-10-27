# Registers the JobApplyReviewer scheduled task (run once, by Eyal: the permission check blocks Claude from creating a task that starts Claude).
#   powershell -ExecutionPolicy Bypass -File worker\reviewer\register-task.ps1
# Every 6 hours (05:30, 11:30, 17:30, 23:30 local), hidden, one hour limit, one instance at a time, catches up a missed start, runs on battery too.
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # repo root
$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $root + '\worker\run-hidden.vbs" "' + $root + '\worker\reviewer.cmd"') -WorkingDirectory $root
$t = @(
  (New-ScheduledTaskTrigger -Daily -At 05:30),
  (New-ScheduledTaskTrigger -Daily -At 11:30),
  (New-ScheduledTaskTrigger -Daily -At 17:30),
  (New-ScheduledTaskTrigger -Daily -At 23:30)
)
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'JobApplyReviewer' -Action $a -Trigger $t -Settings $s -Description 'Headless Claude Code reviews the practice apply loop every 6 hours: fixes failed cards, builds the next recipe, writes worker/reviewer/digest.md. Standing prompt: worker/reviewer/REVIEWER-PROMPT.md. Approved by Eyal 21 Oct 2026.' -Force | Select-Object TaskName, State | Format-List
'Next run: ' + (Get-ScheduledTaskInfo -TaskName 'JobApplyReviewer').NextRunTime
'To run one review right now: Start-ScheduledTask -TaskName JobApplyReviewer   (log: worker\logs\reviewer-<timestamp>.log, digest: worker\reviewer\digest.md)'
