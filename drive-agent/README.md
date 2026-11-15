# TG Drive Desktop (drive-agent)

Makes TG Drive (https://drive.xivago.com) show up in Windows as a real drive, **`T:`**, so you can:

- drag and drop anything into `T:`. It's stored on the platform (Telegram / R2 / Google Drive), and the
  web app shows the same files.
- open files and folders from `T:` in any app or IDE without opening the website.
- work on projects (e.g. conferio) in your local IDE and run them in your terminal, while their storage
  lives on TG Drive and not on the PC.

Disk use on the PC stays capped: only a **local cache** of files you've opened recently (e.g. 10 GB) is
kept. The cache is cleared automatically, oldest files first.

---

## How it works

```
 Explorer / VS Code / terminal
            │  (normal file reads & writes)
            ▼
   T:\  ── rclone mount + WinFsp ── local cache (capped, e.g. 10 GB)
            │  WebDAV over HTTPS
            ▼
   drive.xivago.com  ──  Cloudflare Tunnel  ──  TG Drive (Next.js, this repo)
            │                                         │
            │                         Postgres (Neon): folders, files, chunks
            ▼
   bytes → small files: Cloudflare R2   ·   big files: Telegram / Google Drive
```

Three parts:

### 1. WebDAV API on the server (`app/api/dav/[[...path]]/route.ts` in the main app)
Lets any WebDAV client treat TG Drive as a file system:
`PROPFIND` (list), `GET`/`HEAD` (read, with Range), `PUT` (write), `MKCOL` (new folder),
`MOVE`/`COPY` (rename/move), `DELETE`, plus `LOCK`/`UNLOCK` stubs that Windows apps expect.
Auth: per-device **app passwords** created in the web UI (`device_tokens` table), sent as Basic auth
(email + password). It runs as its own small server (`lib/dav/server.ts`, started by `instrumentation.ts`)
because Next.js route handlers can't receive WebDAV methods like PROPFIND, MKCOL and MOVE.
This reuses the existing folder/file/chunk tables, so the website and `T:` always show the same data.

### 2. Storage tuning on the server (needed for projects)
A project is thousands of small files. Telegram allows about 20 uploads a minute, so small files must
not go there:
- files **< 4 MB → R2** (fast, no rate limit). Source code, configs and docs all land here.
- files **≥ 4 MB → Telegram / Google Drive** (as today, chunked).
- `updated_at` / `etag` columns so the client can tell what changed.

### 3. Desktop agent (this folder)
- `install.ps1`: installs **WinFsp** + **rclone**, saves the server URL + app password, and registers a
  task that mounts `T:` at login (the same approach as your cloudflared tunnel tasks).
- `mount.ps1`: `rclone mount tgdrive: T: --vfs-cache-mode full --vfs-cache-max-size 10G ...`
- `tgd.ps1`, the project command:
  - `tgd work conferio` copies the project's code from `T:` into a local workspace and runs
    `npm install` there. `node_modules`, `.next` and builds stay **local only** and never upload.
    You open that folder in your IDE and `npm run dev` like normal. File watching and hot-reload stay fast.
  - `tgd save conferio` pushes your changes back to `T:` (excluding `node_modules`, `.next`,
    `dist` and anything in `.tgdignore`).
  - `tgd park conferio` saves, then deletes the local workspace. This frees the space.
  - `tgd list` shows which projects are local and how much space each uses.

## Why projects use `tgd work` instead of running straight from `T:`

`npm install` writes 30,000–80,000 tiny files, and `next dev` constantly rewrites `.next/`. Doing that
over the network would take hours and break file watching. So `T:` holds your projects' **real
content**. Each project you're actively working on gets a local working copy, which is only the
regenerable parts plus a cache. When you're done, `tgd park` gives the space back. This is the same
model OneDrive's "Files On-Demand" and Dropbox use.

## Setup on this PC

1. Restart TG Drive (`npm run dev` or `npm run start`). It now also starts the WebDAV server on
   `127.0.0.1:3021`, and logs `[dav] WebDAV drive on ...`.
2. In the web app, click **PC drive** -> **Add this PC**, and copy the command it shows.
3. Run that command in PowerShell in the tg-drive folder. It installs WinFsp + rclone (winget), logs
   in, mounts `T:` and registers the "TG Drive mount" login task.
4. Projects: `tgd push C:\projects\conferio`, `tgd work conferio`, `tgd save conferio`,
   `tgd park conferio`, `tgd list`.

The Cloudflare tunnel sends `https://drive.xivago.com/dav/...` to the WebDAV server, so other PCs can
mount it too. Cloudflare limits a single upload to 100 MB, so on other PCs files over 100 MB fail.
This PC talks to `127.0.0.1:3021` directly and has no such limit.

## Limits to know
- TG Drive itself runs on this PC. If the PC or the server is off, `T:` only shows what's in the
  local cache.
- Keep `.git` in projects (it syncs as small R2 files), but also push to GitHub. Two copies are safer.
- R2's free tier is 10 GB. Source code is small, but the R2 limits in `.env` still apply.
