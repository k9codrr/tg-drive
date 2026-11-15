# TG Drive mount watchdog. Started at login by install.ps1's "TG Drive mount" task and runs forever.
#
# T: is only mounted while the TG Drive server answers. If the server is down (e.g. TG Drive isn't
# started on this PC), a mounted T: makes Explorer hang on every access, and that can freeze the
# whole desktop. So this script:
#   - waits until the server responds, then starts `rclone mount`
#   - checks the server every few seconds; after a few failed checks in a row it stops rclone, so
#     T: disappears instead of hanging
#   - mounts again as soon as the server is back
# rclone also uses short timeouts and few retries, so a slow or flaky server can't block Explorer for long.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = Get-Content (Join-Path $here "agent.json") -Raw | ConvertFrom-Json
$letter = "$($cfg.Letter):"
$rclone = $cfg.Rclone
$mountLog = Join-Path $here "mount.log"
$agentLog = Join-Path $here "agent.log"

$CheckEvery = 5     # seconds between health checks
$FailLimit = 4      # failed checks in a row before T: is removed (about 20 s)
$MountWait = 60     # seconds rclone gets to make T: appear before it's restarted

# Only one watchdog at a time (the task can be started again while one is running).
$mutex = New-Object System.Threading.Mutex($false, "Local\TGDriveMountWatchdog")
if (-not $mutex.WaitOne(0)) { exit 0 }

function Log($msg) {
  try {
    if ((Test-Path $agentLog) -and (Get-Item $agentLog).Length -gt 1MB) { Move-Item $agentLog "$agentLog.old" -Force }
    Add-Content -Path $agentLog -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
  } catch {}
}

# The WebDAV address saved by install.ps1 in rclone.conf.
function Get-DavUrl {
  $line = & $rclone config show tgdrive 2>$null | Where-Object { $_ -match '^\s*url\s*=' } | Select-Object -First 1
  if ($line) { return ($line -replace '^\s*url\s*=\s*', '').Trim() }
  return $null
}

# The server is "up" if OPTIONS on the WebDAV root returns 2xx quickly (no login needed for OPTIONS).
# A Cloudflare 502 (tunnel up, TG Drive down) counts as down.
function Test-Server($url) {
  try {
    $req = [System.Net.HttpWebRequest]::Create($url.TrimEnd("/") + "/")
    $req.Method = "OPTIONS"
    $req.Timeout = 4000
    $req.ReadWriteTimeout = 4000
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $resp.Close()
    return ($code -ge 200 -and $code -lt 300)
  } catch {
    return $false
  }
}

# Whether the drive letter exists. Uses the list of drive letters only, so a slow drive can't block it.
function Test-Letter { [System.IO.Directory]::GetLogicalDrives() -contains "$letter\" }

function Start-Mount {
  if ((Test-Path $mountLog) -and (Get-Item $mountLog).Length -gt 5MB) { Move-Item $mountLog "$mountLog.old" -Force }
  $rcArgs = @(
    "mount", "tgdrive:", $letter,
    "--volname", "`"TG Drive`"",
    "--vfs-cache-mode", "full",
    "--vfs-cache-max-size", "$($cfg.CacheGB)G",
    "--vfs-cache-max-age", "720h",
    "--vfs-write-back", "5s",
    "--dir-cache-time", "30s",
    "--vfs-read-chunk-size", "8M",
    "--vfs-read-chunk-size-limit", "64M",
    "--buffer-size", "16M",
    "--transfers", "8",
    "--checkers", "8",
    # Fail fast instead of hanging Explorer: 5 s to connect, 2 min with no data, 2 tries per request.
    "--contimeout", "5s",
    "--timeout", "2m",
    "--low-level-retries", "2",
    "--log-level", "NOTICE",
    "--log-file", "`"$mountLog`""
  )
  return Start-Process -FilePath $rclone -ArgumentList ($rcArgs -join " ") -WindowStyle Hidden -PassThru
}

function Stop-Mount($proc) {
  if ($proc -and -not $proc.HasExited) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch {}
    try { $proc.WaitForExit(10000) | Out-Null } catch {}
  }
}

# Clean up any rclone mount left over from an earlier run (e.g. the old mount script).
Get-CimInstance Win32_Process -Filter "Name='rclone.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match "mount\s+tgdrive:" } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }

$url = Get-DavUrl
if (-not $url) { Log "No 'tgdrive' rclone remote found. Run install.ps1 again."; exit 1 }
Log "Watchdog started for $url (drive $letter)"

$proc = $null
$startedAt = Get-Date
$fails = 0
$waitingLogged = $false
try {
  while ($true) {
    $up = Test-Server $url
    $mounted = $proc -and -not $proc.HasExited

    if ($up) {
      $fails = 0
      $waitingLogged = $false
      if (-not $mounted) {
        if ($proc) { Log "rclone exited (code $($proc.ExitCode)); mounting again" }
        else { Log "Server is up; mounting $letter" }
        $proc = Start-Mount
        $startedAt = Get-Date
      } elseif (-not (Test-Letter) -and ((Get-Date) - $startedAt).TotalSeconds -gt $MountWait) {
        # rclone sometimes starts but never creates the drive letter: restart it.
        Log "rclone is running but $letter never appeared; restarting it"
        Stop-Mount $proc
        $proc = Start-Mount
        $startedAt = Get-Date
      }
    } else {
      $fails++
      if ($mounted -and $fails -ge $FailLimit) {
        Log "Server not responding ($fails checks); removing $letter so Explorer doesn't hang"
        Stop-Mount $proc
        $proc = $null
      } elseif (-not $mounted -and -not $waitingLogged) {
        Log "Server is down; $letter stays unmounted until it's back"
        $waitingLogged = $true
        $proc = $null
      }
    }
    Start-Sleep -Seconds $CheckEvery
  }
} finally {
  Stop-Mount $proc
  $mutex.ReleaseMutex()
}
