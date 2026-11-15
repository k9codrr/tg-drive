# ✈️ TG Drive: multi-user cloud storage on Telegram + Cloudflare R2 + Google Drive

A Next.js app you deploy on **Vercel** (or any Node host such as Dokploy). People **sign up with email and
password**, and each person gets their own private drive. Files can be stored in three places:

| Backend | Who provides it | Space | Good for |
|---|---|---|---|
| **Telegram** | you (one bot + chat for everyone) | no fixed cap | bulk storage |
| **Cloudflare R2** | you (one bucket for everyone) | 10 GB free, capped by you | fast, reliable files |
| **Google Drive** | each user connects **their own** Gmail accounts | 15 GB per account, combined | personal extra space |

Features: drag & drop files **and whole folders**, folders/breadcrumbs, rename, move, delete, search,
a "Save to" picker, a **Storage** panel with each backend's free space plus the combined total,
4 MB chunking with automatic retries, and optional AES-256-GCM encryption (Telegram + R2).

```
Browser ─▶ Vercel API (checks login, scopes every query to that user)
              ├─▶ Telegram chat   (4 MB chunks as documents)
              ├─▶ Cloudflare R2   (4 MB chunks as objects u/<user>/<file>/<n>)
              ├─▶ Google Drive    (one normal file per upload, in the user's "TG Drive" folder)
              └─▶ Neon Postgres   (users, folders, files, chunk index, Google accounts)
```

---

## All environment variables

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon Postgres connection string |
| `SESSION_SECRET` | ✅ | long random string (`openssl rand -hex 32`). **Never change it** (it also encrypts saved Google logins) |
| `TELEGRAM_BOT_TOKEN` | ✅ | token from @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | private channel id (`-100…`, bot is admin) or your user id |
| `ALLOW_SIGNUP` | optional | `false` closes sign-ups (default open) |
| `SIGNUP_CODE` | optional | if set, sign-up requires this invite code |
| `ENCRYPTION_KEY` | recommended | encrypts Telegram + R2 chunks. **Lose it = lose those files** |
| `R2_ACCOUNT_ID` | for R2 | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | for R2 | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | for R2 | R2 API token secret |
| `R2_BUCKET` | for R2 | bucket name |
| `R2_TOTAL_LIMIT_GB` | optional | cap for all users together (default **10** = free tier) |
| `R2_USER_LIMIT_GB` | optional | cap per user |
| `GOOGLE_CLIENT_ID` | for Google | OAuth client id |
| `GOOGLE_CLIENT_SECRET` | for Google | OAuth client secret |
| `APP_URL` | for Google / SSO | your public URL, e.g. `https://your-app.vercel.app` |
| `SSO_GOOGLE` | optional | `true` = "Continue with Google" sign-in (uses the Google client above) |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_TENANT` | optional | Microsoft Entra sign-in; tenant id or domain (default `organizations`) |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_NAME` | optional | any OpenID Connect provider (Okta, Auth0, Keycloak, Authentik…) |
| `OIDC_TRUST_EMAIL` / `MS_TRUST_EMAIL` | optional | `true` = treat the provider's email as verified even without `email_verified` |
| `SSO_ALLOW_SIGNUP` | optional | `false` = SSO only signs in existing accounts (and team-sync domains) |
| `PASSWORD_LOGIN` | optional | `false` = hide email/password sign-in once SSO is set up |
| `DAV_HOST` | optional | where the WebDAV server listens: `127.0.0.1` (default, this PC only), `0.0.0.0` (network) |
| `DAV_PORT` | optional | WebDAV port (default `3021`) |
| `DAV_PUBLIC_URL` | optional | the address shown to users for other apps, e.g. `https://drive.example.com/dav/` |
| `DAV_ALLOW_IPS` | optional | only these IPs/ranges may connect, e.g. `203.0.113.7, 192.168.1.0/24` |
| `DAV_TRUST_PROXY` | optional | `cloudflare` (CF-Connecting-IP) or `true` (X-Forwarded-For) when behind a tunnel/proxy |
| `ALLOW_HTTP_STORAGE` | optional | `true` = allow `http://` S3/WebDAV connections (e.g. a NAS on your LAN) |

---

## Setup

### 1. Telegram bot
1. @BotFather → `/newbot` → copy the token.
2. Create a **private channel**, add the bot as **admin** (post + delete messages), and post anything.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `channel_post.chat.id` (`-100…`).
   (Or use your own chat with the bot. It's faster: ~1 msg/s vs ~20 msgs/min in channels.)

### 2. Database
Vercel → **Storage → Create → Neon** → connect to the project (sets `DATABASE_URL`).
The schema lives in `prisma/schema.prisma` (Prisma ORM). Create the tables with
`npm run db:migrate` (runs `prisma migrate deploy`; safe to re-run).

- **Changing the schema:** edit `prisma/schema.prisma`, then `npm run db:migrate:dev -- --name <change>`
  to create a new migration in `prisma/migrations/`. Commit it, and `db:migrate` applies it in production.
- **Existing TG Drive database (from the old `schema.sql`):** upgrade it with the last `schema.sql`
  first, then mark the baseline as applied once: `npx prisma migrate resolve --applied 0_init`.

### 3. Cloudflare R2 (optional)
1. Cloudflare dashboard → **R2** → enable it (a payment method is required even for the free tier) → **Create bucket**.
2. **R2 → Manage API tokens → Create API token** → permission *Object Read & Write*, limited to your bucket.
3. Copy the **Access Key ID**, **Secret Access Key** and your **Account ID** into the env vars.
4. Keep `R2_TOTAL_LIMIT_GB=10` to stay free. Past 10 GB, Cloudflare charges about $0.015/GB-month.
   No CORS setup is needed: uploads go through the app's server.

### 4. Google Drive (optional)
1. [console.cloud.google.com](https://console.cloud.google.com) → new project → enable **Google Drive API**.
2. **OAuth consent screen** → External → add scope `.../auth/drive.file` → **Publish app** ("In production").
   In "Testing" mode, tokens expire after 7 days. `drive.file` is non-sensitive, so no verification is needed.
3. **Credentials → OAuth client ID → Web application** → redirect URIs:
   `https://your-app.vercel.app/api/google/callback` and `http://localhost:3000/api/google/callback`.
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL`.

### 5. Deploy
Push to GitHub → Vercel → **Add New → Project** → import → add the env vars → Deploy.
Open the site → **Sign up** → start dragging files in.

Run locally:
```bash
cp .env.example .env.local   # fill in values
npm install                  # also runs prisma generate
npm run db:migrate
npm run dev                  # http://localhost:3000
```

---

## How users work
- **Sign up / sign in** with email + password (scrypt-hashed). Sessions are signed http-only cookies that last 30 days.
- Every folder and file is in a **space**: your private *My Drive*, or a **team** you belong to. Google accounts
  always belong to one user. **Every API route checks the space and your role**, so nobody sees what they shouldn't.
- **The first account created takes over any files from older single-user versions.**
- Telegram and R2 are **shared** backends you pay for or operate. Set `ENCRYPTION_KEY` so you (and anyone in the
  Telegram channel) can't read users' files. Use `R2_USER_LIMIT_GB`, `SIGNUP_CODE` or `ALLOW_SIGNUP=false` to control usage.
- Google Drive is **per user**: each user connects their own Gmail accounts under **Storage → + Connect Google account**,
  and their free space is combined in their pool. The app can only see files it uploaded (`drive.file`).

## Teams & roles
Create a team from the sidebar (**Teams → Create a team**). It gets its own shared space next to My Drive, with its
own Recent, Starred, Trash and search. Invite people by email: anyone with an account gets an in-app notification
(the bell) to join; anyone else sees the invite after signing up with that email.

| Role | Can |
|---|---|
| Owner | everything, incl. deleting the team and handing over ownership (there is always exactly one owner) |
| Admin | manage members and the team name, delete anything for good, empty the team trash |
| Manager | rename/move/trash anyone's items, move storage, invite members and viewers |
| Member | upload, create folders, rename/move/trash **what they added**; see everything |
| Viewer | open and download only |

You can only invite or change people *below* your own role. Files in a team are stored with the uploader's
storage (their default, their Google accounts). Someone who leaves loses access, but their uploads stay in the team.
The rules live in `lib/rbac.ts`; every route goes through `lib/space.ts`. The PC drive (`T:`) shows My Drive only.

## Sharing
Right-click a file or folder → **Share…**, enter the email of a TG Drive user and pick what they can do:

| Permission | Can |
|---|---|
| View | open and preview in the browser (no download buttons; the viewer still streams the file, so this is not copy protection) |
| View & download | also download |
| Edit | also rename, move and trash items inside, upload and create folders (in a shared folder) |
| Full access | also rename/move/trash the shared item itself and share it on (at most with their own permission) |

A folder share covers everything inside it; the recipient sees the path only from the shared folder down.
Options: **access ends** on a date, and a **password**. The recipient gets an in-app notification showing the
password (only they, and whoever set it, can see it) and enters it once to open the item (unlocked for 12 hours;
5 wrong tries lock it for 10 minutes). For a plain file the password is an access check on the server; for an
**encrypted file** it is real encryption (see below), so sharing one requires a password of 8+ characters.
Shares never allow deleting for good, moving storage or team settings. What a recipient uploads into a shared folder
belongs to the folder's owner but is stored on the uploader's storage. Everything shared with you is under
**Shared with me**; changes and revocations arrive as notifications.

## Encrypted files
**New → Upload encrypted files…**, or right-click a file → **Encrypt with password…**.

- Each encrypted file has its own random 256-bit key. Its bytes are encrypted with **AES-256-CTR** before they
  reach Telegram, Google Drive or R2 (CTR keeps sizes and offsets, so resumable uploads, seeking in videos and
  previews keep working). Telegram/R2 chunks are additionally sealed with `ENCRYPTION_KEY` (AES-GCM, which also
  detects tampering) when that is set; Google Drive copies get no tamper check.
- The file key is stored only **wrapped with your password** (scrypt + AES-GCM), plus one wrap per share of the file,
  with the share's password. Without one of those passwords nobody can read the file, including someone with the
  database and `SESSION_SECRET`. **A forgotten password can't be recovered.**
- Opening asks for the password once; the key is then kept in an HttpOnly cookie (sealed with the server secret,
  sent only to that file's URLs) for **1 hour** (or until **Lock now**). While it's unlocked the server decrypts on
  the fly for you, so it does see the plaintext in transit. This is encryption at rest, not end-to-end.
- **Change password** only re-wraps the key (instant). **Encrypt** and **Remove encryption** rewrite the bytes, in
  resumable steps like a storage move. Moving an encrypted file to other storage copies it still encrypted.
- Sharing an encrypted file: the Share dialog asks for the file's password and a share password; the recipient
  decrypts with the share password from their notification. A **folder** share does not unlock encrypted files
  inside it: share those files on their own, or give the recipient their passwords.
- The PC drive (`T:`) lists encrypted files but can't open them (it never has the password). Saving a file with the
  same name over one from `T:` replaces it with an unencrypted version.
- Encrypted files get no thumbnails.

## Your own storage: user and team level
**Storage → Connect storage** (yourself) or **Teams → a team → Team storage** (admins). Each option has a
step-by-step guide in the app:

| Kind | Options |
|---|---|
| Telegram | a bot (from @BotFather) + a private channel where it's an admin |
| S3 | Cloudflare R2, Amazon S3, Backblaze B2, Wasabi, MinIO or any S3-compatible bucket |
| WebDAV | a folder on Nextcloud / ownCloud, a Synology or other NAS, any WebDAV server (an IP address works) |
| Google | your Google accounts, or team Google accounts an admin connects (**Connect a Google account to the team**) |

Every connection is tested before it's saved (a small file is written, read back and deleted). Credentials are
stored encrypted with `SESSION_SECRET` and never sent back to the browser. Optional per-connection size limit.

**Which storage an upload uses** ("Telegram", "S3 / R2", "WebDAV" and "Google Drive" mean "the best available"):
- **in a team's folders:** the team's connection → your own → one a team offers to members → the server's
- **in My Drive:** your own → one your team admin **offered to members** → the server's (`TELEGRAM_*` / `R2_*`)

So members who don't connect anything automatically use what the admin set up, and anyone can connect their own
storage instead. You can also pick a specific connection as your default or for the PC drive. "Change storage…"
moves files between any of them. A connection can't be removed while files are stored in it.
Telegram uses bots (the Bot API); signing in with a personal Telegram account isn't supported.

## External access (other computers, phones, apps)
TG Drive's WebDAV server (`/dav`) works with any WebDAV client: Windows (the PC drive / Map network drive),
macOS Finder, Linux file managers, Documents by Readdle on iOS, Solid Explorer on Android, Cyberduck, rclone.
The PC drive screen shows the address, user name and how to connect each one.

**Website on Vercel?** Vercel can't run the WebDAV server, so host it on a small VPS: see [VPS.md](VPS.md)
(step-by-step, including how other users add T: to their PCs).

By default it only listens on the PC running TG Drive. To open it up:
1. **Recommended:** a Cloudflare tunnel (or another HTTPS reverse proxy) to `http://127.0.0.1:3021`, with
   `DAV_TRUST_PROXY=cloudflare` and `DAV_PUBLIC_URL=https://your-address/dav/`. Nothing else is exposed.
2. **Or directly:** `DAV_HOST=0.0.0.0` plus `DAV_ALLOW_IPS=...`. Passwords travel with every request, so use this
   only on a LAN/VPN or behind HTTPS.

Protection: `DAV_ALLOW_IPS` for the whole server, **Limit addresses** per device password, each device shows the
address it last connected from, and 20 failed logins from one address lock it out for 10 minutes.

## Single sign-on and team sync
Set any of the SSO variables above and the login page shows **Continue with Google / Microsoft / your provider**.
Register the redirect URI `<APP_URL>/api/auth/sso/<google|microsoft|oidc>/callback` with the provider.
- Sign-in links by the provider's user id; a new identity joins an existing account only by a **verified** email.
- New people get an account automatically unless `SSO_ALLOW_SIGNUP=false`.
- **Team sync:** in a team, admins set an email domain (their own, not a public one like gmail.com) and a role.
  Everyone who signs in with SSO and a verified email at that domain joins the team automatically with that role.
- `PASSWORD_LOGIN=false` makes SSO the only way in.
- The ID token comes straight from the provider's token endpoint over TLS (allowed by OpenID Connect Core
  §3.1.3.7 instead of a signature check); issuer, audience, expiry and nonce are checked, and PKCE is used.

## API (for scripts)
All routes except `/api/auth/*` need the session cookie from `POST /api/auth/login {email, password}`.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/auth/signup` `{email,password,name?,code?}` | create account |
| POST | `/api/auth/login` / `/api/auth/logout` | sign in / out |
| GET | `/api/auth/me` | current user |
| GET | `/api/list?folder=<id>` · `/api/list?team=<teamId>` | folder contents (no folder = top of My Drive / the team) |
| GET | `/api/search?q=text[&team=<id>]` | search file names (also `/api/starred`, `/api/trash` take `team`) |
| POST | `/api/folders` `{parentId, name}` or `{parentId, path:"a/b"}` (+ `team` at the top) | create folder(s) |
| PATCH/DELETE | `/api/folders/:id` | rename / delete recursively |
| POST | `/api/files` `{name,size,mime,folderId,team?,target}` | start upload → `{id, chunkSize, chunkCount, sequential}` |
| PUT | `/api/files/:id/chunks/:i` (raw bytes) | upload chunk *i* (in order if `sequential`) |
| POST | `/api/files/:id/complete` | finish upload |
| GET | `/api/files/:id` · `/api/files/:id/chunks/:i` | metadata · download chunk *i* |
| PATCH/DELETE | `/api/files/:id` `{name?, folderId?}` | rename/move · delete |
| GET | `/api/accounts?refresh=1` | storage pool (Telegram, R2, Google accounts, totals) |
| GET | `/api/google/connect[?team=<id>]` · DELETE `/api/accounts/:id` | add (to you or a team) · remove a Google account |
| PATCH | `/api/accounts/:id` `{offerToMembers}` | let team members use a team Google account privately |
| GET · POST | `/api/connections` · `{kind, name?, config, teamId?, offerToMembers?, limitGB?}` | your/offered storage · add (tested first) |
| PATCH/DELETE · POST | `/api/connections/:id` · `/api/connections/:id/test` | change / remove · test again |
| GET | `/api/teams/:id/storage` | a team's connections and Google accounts |
| PATCH | `/api/devices/:id` `{storage?, allowedIps?}` | a device's storage and allowed addresses |
| GET | `/api/auth/sso/<provider>` | start single sign-on |
| GET/POST | `/api/teams` `{name}` | your teams + invites waiting for you · create a team |
| GET/PATCH/DELETE | `/api/teams/:id` `{name}` | members & invites · rename · delete team (owner) |
| POST · DELETE | `/api/teams/:id/invites` `{email, role}` · `/api/teams/:id/invites/:inviteId` | invite · cancel |
| PATCH/DELETE | `/api/teams/:id/members/:userId` `{role}` | change role (`owner` = hand over) · remove / leave |
| POST | `/api/invites/:id` `{accept}` | join or decline |
| GET/PATCH | `/api/notifications` `{ids}` or `{all:true}` | list · mark read |
| GET · POST | `/api/shares?file=<id>` / `?folder=<id>` · `/api/shares` `{file\|folder, email, permission, password?, expiresAt?}` | who has access · share |
| PATCH/DELETE | `/api/shares/:id` `{permission?, expiresAt?, password?}` | change · revoke (recipient: remove from list) |
| GET | `/api/shares/received` | Shared with me |
| POST | `/api/shares/:id/unlock` `{password}` | open a password-protected share (also unlocks an encrypted file) |
| POST | `/api/files` `{…, encryption: {password}}` | upload encrypted (the response unlocks the new file for the chunks) |
| POST/DELETE | `/api/files/:id/unlock` `{password}` | unlock an encrypted file for 1 h · lock it now |
| PATCH | `/api/files/:id/encryption` `{password}` | new password (file must be unlocked) |
| POST | `/api/files/:id/transfer` `{encryption: {mode: "encrypt", password} \| {mode: "decrypt"}}` | encrypt / decrypt in steps (repeat until `done`) |

`target` is `"telegram"` (default), `"r2"`, `"gdrive"` (the account with the most free space) or `"gdrive:<accountId>"`.

## Limits & honest caveats
- **Telegram:** speed is limited by Telegram's rate limits, which **all users share**. There's no SLA, and its ToS doesn't promise this use.
- **Google:** free space is shared with Gmail and Photos. One file must fit in **one** account.
- **R2:** usage past `R2_TOTAL_LIMIT_GB` is blocked by the app. Unfinished uploads count until deleted.
- Vercel limits requests to ~4.5 MB, which is why chunks are 4 MB. Downloads are reassembled in the browser's memory.
- Deleting removes the database rows. Deleting the stored bytes is best-effort.
- **Back up the database.** It's the index for everything.

## Designs

On first sign-in the app asks which design to use (changeable later under **Appearance**):

- **Nimbus**: palette and layout adapted from [Nimbus](https://github.com/nimbusdotstorage/Nimbus), licensed under Apache-2.0.
- **Classic**: the familiar layout of the big cloud drives (big New button, search bar, folder cards).
- **Conferio**: the drive pages of [Conferio](https://github.com/k9codrr/conferio).

Each design has light, dark and system modes. Files open in an in-app viewer: images, video, audio, PDF,
text/code, spreadsheets (xlsx, xls, ods, csv), Word (.docx), PowerPoint (.pptx, text), zip archives and fonts.
