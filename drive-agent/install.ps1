<#
  TG Drive Desktop: one-time setup on a Windows PC.
  Installs WinFsp + rclone, saves your device password, mounts TG Drive as T: now and at every login.

  Get the command (with your password filled in) from the web app: "PC drive" -> "Add this PC".

    powershell -ExecutionPolicy Bypass -File drive-agent\install.ps1 -Email you@example.com -Password tgd_xxx

  Options:
    -Letter T          drive letter to use
    -CacheGB 10        max disk space the local cache may use
    -Url <url>         WebDAV address (default: local server if it's running on this PC, else drive.xivago.com)
#>
param(
  [Parameter(Mandatory = $true)][string]$Email,
  [Parameter(Mandatory = $true)][string]$Password,
  [string]$Letter = "T",
  [int]$CacheGB = 10,
  [string]$Url = ""
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Letter = $Letter.TrimEnd(":").ToUpper()

function Step($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }

# ---- 1. WinFsp + rclone ----
Step "Installing WinFsp and rclone (skipped if already installed)"
$winfsp = Test-Path "${env:ProgramFiles(x86)}\WinFsp\bin\winfsp-x64.dll"
if (-not $winfsp) { winget install -e --id WinFsp.WinFsp --accept-package-agreements --accept-source-agreements }
if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
  winget install -e --id Rclone.Rclone --accept-package-agreements --accept-source-agreements
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
$rclone = (Get-Command rclone -ErrorAction SilentlyContinue).Source
if (-not $rclone) { throw "rclone was installed but isn't on PATH yet. Open a new terminal and run this script again." }
Write-Host "rclone: $rclone"

# ---- 2. Which address to use ----
if (-not $Url) {
  $local = $false
  try { $local = (Test-NetConnection 127.0.0.1 -Port 3021 -WarningAction SilentlyContinue).TcpTestSucceeded } catch {}
  # On the PC that runs TG Drive, talk to it directly: faster, and no 100 MB Cloudflare upload limit.
  $Url = if ($local) { "http://127.0.0.1:3021/dav" } else { "https://drive.xivago.com/dav" }
}
Step "Connecting to $Url"

# ---- 3. rclone remote "tgdrive" (password stored obscured in rclone.conf) ----
# rclone writes NOTICE lines to stderr; under "Stop", Windows PowerShell 5.1 treats that as a fatal error.
$ErrorActionPreference = "Continue"
& $rclone config delete tgdrive 2>&1 | Out-Null
& $rclone config create tgdrive webdav url=$Url vendor=other user=$Email pass=$Password --obscure --non-interactive 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "rclone config create failed (exit $LASTEXITCODE)." }
$out = & $rclone lsd tgdrive: --max-depth 1 2>&1
$code = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($code -ne 0) {
  $out | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
  throw "Could not log in. Check the email/password, and that TG Drive is running."
}
Write-Host "Login OK"

# ---- 4. Mount script + start at login ----
$cfg = @{ Letter = $Letter; CacheGB = $CacheGB; Rclone = $rclone } | ConvertTo-Json
Set-Content -Path (Join-Path $here "agent.json") -Value $cfg -Encoding utf8

$vbs = Join-Path $here "run-mount.vbs"
$mount = Join-Path $here "mount.ps1"
@"
' Mounts TG Drive as ${Letter}: with no console window (started at login by Task Scheduler).
Set sh = CreateObject("WScript.Shell")
rc = sh.Run("powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$mount""", 0, True)
WScript.Quit rc
"@ | Set-Content -Path $vbs -Encoding ascii

Step "Registering 'TG Drive mount' to start at login"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B //Nologo `"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "TG Drive mount" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "TG Drive mount"

# ---- 5. tgd command on PATH ----
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $here) {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$here", "User")
  Write-Host "Added $here to your PATH (open a new terminal to use 'tgd')."
}

Step "Waiting for ${Letter}: to appear"
for ($i = 0; $i -lt 20 -and -not (Test-Path "${Letter}:\"); $i++) { Start-Sleep 1 }
if (Test-Path "${Letter}:\") {
  Write-Host "`nDone! TG Drive is drive ${Letter}: - try: explorer ${Letter}:\" -ForegroundColor Green
} else {
  Write-Host "`n${Letter}: isn't up yet. See the log: $(Join-Path $here 'mount.log')" -ForegroundColor Yellow
}
