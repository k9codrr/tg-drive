# Mounts TG Drive (rclone remote "tgdrive") as a drive letter. Started at login by install.ps1's task.
# Keeps running while mounted; Task Scheduler restarts it if it exits.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = Get-Content (Join-Path $here "agent.json") -Raw | ConvertFrom-Json
$letter = "$($cfg.Letter):"
# Don't let rclone's stderr output kill the mount under Windows PowerShell 5.1.
$ErrorActionPreference = "Continue"

& $cfg.Rclone mount tgdrive: $letter `
  --volname "TG Drive" `
  --vfs-cache-mode full `
  --vfs-cache-max-size "$($cfg.CacheGB)G" `
  --vfs-cache-max-age 720h `
  --vfs-write-back 5s `
  --dir-cache-time 30s `
  --vfs-read-chunk-size 8M `
  --vfs-read-chunk-size-limit 64M `
  --buffer-size 16M `
  --transfers 16 `
  --checkers 16 `
  --timeout 30m `
  --log-level INFO `
  --log-file (Join-Path $here "mount.log")
exit $LASTEXITCODE
