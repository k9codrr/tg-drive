<#
  tgd: work on projects stored on TG Drive, keeping only the active ones on this PC.

    tgd push <path>     copy a local project into T:\Projects (local copy is kept; add -Delete to remove it after a verified copy)
    tgd work <name>     make a local working copy from T:\Projects\<name> and install dependencies
    tgd save <name>     send your changes back to T:\Projects\<name> (mirrors deletions too)
    tgd park <name>     save, then delete the local working copy to free disk space
    tgd list            projects on TG Drive and which ones are local

  node_modules, .next, dist, build, caches etc. are never uploaded: they are rebuilt by `tgd work`.
  Extra exclusions: list folder/file names in a .tgdignore file in the project root (one per line).
#>
param(
  [Parameter(Position = 0)][string]$Command = "help",
  [Parameter(Position = 1)][string]$Target = "",
  [switch]$Delete,
  [switch]$NoInstall,
  [switch]$Yes
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $here "agent.json"
$letter = if (Test-Path $cfgPath) { (Get-Content $cfgPath -Raw | ConvertFrom-Json).Letter } else { "T" }
$Cloud = "${letter}:\Projects"
$Work = if ($env:TGD_WORK) { $env:TGD_WORK } else { Join-Path $env:USERPROFILE "tgd-work" }

$ExcludeDirs = @("node_modules", ".next", ".turbo", ".vercel", ".cache", ".parcel-cache", "dist", "build", "out",
  "coverage", ".nuxt", ".svelte-kit", ".expo", "__pycache__", ".venv", "venv", "target", ".gradle")
$ExcludeFiles = @("*.log", "*.tsbuildinfo", "Thumbs.db", ".DS_Store")

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }
function NeedDrive { if (-not (Test-Path "${letter}:\")) { Fail "${letter}: is not mounted. Start it: Start-ScheduledTask 'TG Drive mount'" } }
function NeedName { if (-not $Target) { Fail "Usage: tgd $Command <name>" } }

function Excludes($root) {
  $dirs = [System.Collections.Generic.List[string]]::new($ExcludeDirs)
  $files = [System.Collections.Generic.List[string]]::new($ExcludeFiles)
  $ignore = Join-Path $root ".tgdignore"
  if (Test-Path $ignore) {
    foreach ($l in Get-Content $ignore) {
      $l = $l.Trim().TrimEnd("/", "\")
      if (-not $l -or $l.StartsWith("#")) { continue }
      if ($l.Contains("*") -or $l.Contains(".")) { $files.Add($l) } else { $dirs.Add($l) }
    }
  }
  return @{ Dirs = $dirs; Files = $files }
}

# robocopy: /E recurse, /MIR mirror (also deletes), /XD /XF exclusions (also protected from deletion),
# /R:3 /W:5 retries, /MT:8 parallel files, /FFT 2-second timestamp tolerance (needed for network drives).
# /XO: only copy files that are newer at the source. The drive records upload time as the file's
# time, so without it every save would re-upload everything.
function Copy-Tree($from, $to, [switch]$Mirror) {
  $ex = Excludes $from
  $mode = if ($Mirror) { "/MIR" } else { "/E" }
  $rcArgs = @($from, $to, $mode, "/XO", "/R:3", "/W:5", "/MT:8", "/FFT", "/NP", "/NFL", "/NDL", "/XJ",
    "/XD") + $ex.Dirs + @("/XF") + $ex.Files
  & robocopy @rcArgs | Select-String -Pattern "^\s*(Dirs|Files|Bytes)\s*:" | ForEach-Object { Write-Host "   $($_.Line.Trim())" }
  if ($LASTEXITCODE -ge 8) { Fail "Copy failed (robocopy code $LASTEXITCODE). Nothing was deleted." }
}

function Size($path) {
  if (-not (Test-Path $path)) { return 0 }
  $s = (Get-ChildItem $path -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  if ($s) { return $s } else { return 0 }
}
function Fmt($b) { if ($b -ge 1GB) { "{0:N1} GB" -f ($b / 1GB) } elseif ($b -ge 1MB) { "{0:N0} MB" -f ($b / 1MB) } else { "{0:N0} KB" -f ($b / 1KB) } }

function Save-Project($name) {
  $src = Join-Path $Work $name
  if (-not (Test-Path $src)) { Fail "No local working copy at $src" }
  Write-Host "Saving $src -> $(Join-Path $Cloud $name)..."
  Copy-Tree $src (Join-Path $Cloud $name) -Mirror
  Write-Host "Saved." -ForegroundColor Green
}

function Install-Deps($dir) {
  if ($NoInstall -or -not (Test-Path (Join-Path $dir "package.json"))) { return }
  Push-Location $dir
  try {
    if (Test-Path "pnpm-lock.yaml") { pnpm install }
    elseif (Test-Path "yarn.lock") { yarn install }
    elseif (Test-Path "bun.lockb") { bun install }
    else { npm install }
  } finally { Pop-Location }
}

switch ($Command) {
  "push" {
    NeedDrive; NeedName
    $src = (Resolve-Path $Target).Path
    $name = Split-Path $src -Leaf
    $dest = Join-Path $Cloud $name
    if (Test-Path $dest) { Fail "$dest already exists. Use 'tgd save $name' from a working copy instead." }
    New-Item -ItemType Directory -Force $Cloud | Out-Null
    Write-Host "Uploading $src -> $dest (skipping node_modules, builds, caches)..."
    Copy-Tree $src $dest
    $ex = Excludes $src
    $missing = robocopy $src $dest /E /L /XO /FFT /NJH /NJS /NP /NDL /XJ /XD @($ex.Dirs) /XF @($ex.Files) | Where-Object { $_.Trim() }
    if ($missing) { Fail "Verification found files that didn't upload; local copy kept. Run 'tgd push' again." }
    Write-Host "Verified: everything is on TG Drive." -ForegroundColor Green
    if ($Delete) {
      if (-not $Yes) {
        $ans = Read-Host "Delete the local folder $src now ($(Fmt (Size $src)))? Type yes"
        if ($ans -ne "yes") { Write-Host "Kept $src."; break }
      }
      Remove-Item -Recurse -Force $src
      Write-Host "Deleted $src. Get it back any time with: tgd work $name" -ForegroundColor Green
    } else {
      Write-Host "Local copy kept. When you're ready: tgd push `"$src`" -Delete  (or just delete it yourself)"
    }
  }
  "work" {
    NeedDrive; NeedName
    $src = Join-Path $Cloud $Target
    if (-not (Test-Path $src)) { Fail "No project '$Target' in $Cloud. See: tgd list" }
    $dest = Join-Path $Work $Target
    New-Item -ItemType Directory -Force $Work | Out-Null
    Write-Host "Downloading $src -> $dest..."
    Copy-Tree $src $dest
    Install-Deps $dest
    Write-Host "`nReady: $dest" -ForegroundColor Green
    Write-Host "   code `"$dest`"     # open in your IDE"
    Write-Host "   tgd save $Target   # send changes back    |   tgd park $Target   # save + free space"
  }
  "save" {
    NeedDrive; NeedName
    Save-Project $Target
  }
  "park" {
    NeedDrive; NeedName
    $src = Join-Path $Work $Target
    if (-not (Test-Path $src)) { Fail "No local working copy at $src" }
    Save-Project $Target   # exits the script on failure, so nothing is deleted
    $size = Fmt (Size $src)
    if (-not $Yes) {
      $ans = Read-Host "Delete local working copy $src ($size, incl. node_modules)? Type yes"
      if ($ans -ne "yes") { Write-Host "Kept."; break }
    }
    Remove-Item -Recurse -Force $src
    Write-Host "Parked ${Target}: freed $size. Resume with: tgd work $Target" -ForegroundColor Green
  }
  "list" {
    NeedDrive
    if (-not (Test-Path $Cloud)) { Write-Host "No projects yet. Add one: tgd push C:\path\to\project"; break }
    Get-ChildItem $Cloud -Directory | ForEach-Object {
      $local = Join-Path $Work $_.Name
      [pscustomobject]@{
        Project = $_.Name
        Local = if (Test-Path $local) { "yes ($(Fmt (Size $local)))" } else { "parked" }
        Path = if (Test-Path $local) { $local } else { $_.FullName }
      }
    } | Format-Table -AutoSize
  }
  default {
    Get-Content $PSCommandPath | Select-Object -Skip 1 -First 10 | ForEach-Object { $_ -replace "^\s{0,2}", "" }
  }
}
exit 0
