# Removes the JobApplyWorker scheduled task. The board queue is untouched; nothing is submitted until the task is installed again.
Unregister-ScheduledTask -TaskName 'JobApplyWorker' -Confirm:$false
Write-Host 'JobApplyWorker removed.'
