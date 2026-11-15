# Keeps the TG Drive server (Next.js on :3020 + WebDAV on :3021) running in the background.
# Started at login by the "TG Drive server" task (see install-server.ps1).
#   - builds first if there's no build yet, or the code changed (new git commit) since the last build
#   - restarts the server if it crashes (waits longer after repeated quick crashes)
#   - if something else already uses port 3020 (e.g. you're running `npm run dev`), it waits
# Log: drive-agent\server.log
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Split-Path -Parent $here
$log = Join-Path $here "server.log"
$port = 3020

$mutex = New-Object System.Threading.Mutex($false, "Local\TGDriveServerWatchdog")
if (-not $mutex.WaitOne(0)) { exit 0 }

function Log($msg) {
  try {
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.old" -Force }
    Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  [agent] $msg"
  } catch {}
}

function Test-PortBusy {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# Runs a command hidden, appending its output to server.log. Returns the exit code.
function Invoke-Logged($cmdLine) {
  $p = Start-Process -FilePath "cmd.exe" -ArgumentList "/d /c $cmdLine >> `"$log`" 2>&1" `
    -WorkingDirectory $app -WindowStyle Hidden -PassThru
  $p.WaitForExit()
  return $p.ExitCode
}

function Ensure-Build {
  $stamp = Join-Path $app ".next\tgd-build-head"
  $head = (& git -C $app rev-parse HEAD 2>$null)
  $built = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { "" }
  if ((Test-Path (Join-Path $app ".next\BUILD_ID")) -and $head -and $built -eq $head) { return $true }
  Log "Building (commit $head)..."
  $code = Invoke-Logged "npm run build"
  if ($code -ne 0) { Log "Build failed (exit $code)"; return $false }
  if ($head) { Set-Content -Path $stamp -Value $head -Encoding ascii }
  Log "Build done"
  return $true
}

$delay = 5
try {
  while ($true) {
    if (Test-PortBusy) {
      # Another copy (e.g. `npm run dev`) is serving TG Drive; check again later.
      Start-Sleep -Seconds 30
      continue
    }
    if (-not (Ensure-Build)) {
      # If there's an older build we can still run it; otherwise retry later.
      if (-not (Test-Path (Join-Path $app ".next\BUILD_ID"))) { Start-Sleep -Seconds 300; continue }
    }
    Log "Starting server on :$port"
    $started = Get-Date
    $code = Invoke-Logged "npm run start"
    $ran = ((Get-Date) - $started).TotalSeconds
    Log "Server exited (code $code) after $([int]$ran)s"
    # Quick crash loops back off up to 5 minutes; a server that ran a while restarts quickly.
    $delay = if ($ran -gt 120) { 5 } else { [Math]::Min($delay * 2, 300) }
    Start-Sleep -Seconds $delay
  }
} finally {
  $mutex.ReleaseMutex()
}
