<#
  Starts the TG Drive server automatically at login, hidden, and keeps it running (see server.ps1).
  Only needed on the PC that hosts TG Drive.

    powershell -ExecutionPolicy Bypass -File drive-agent\install-server.ps1            # set up + start now
    powershell -ExecutionPolicy Bypass -File drive-agent\install-server.ps1 -Remove    # undo
#>
param([switch]$Remove)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = "TG Drive server"

if ($Remove) {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed '$name'. Stop a running server by ending its node.exe in Task Manager or restarting."
  exit 0
}

$vbs = Join-Path $here "run-server.vbs"
$script = Join-Path $here "server.ps1"
@"
' Runs the TG Drive server with no console window (started at login by Task Scheduler).
Set sh = CreateObject("WScript.Shell")
rc = sh.Run("powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$script""", 0, True)
WScript.Quit rc
"@ | Set-Content -Path $vbs -Encoding ascii

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B //Nologo `"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Host "'$name' registered and started. It runs at every login. Log: $(Join-Path $here 'server.log')" -ForegroundColor Green
