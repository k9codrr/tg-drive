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
| `APP_URL` | for Google | your public URL, e.g. `https://your-app.vercel.app` |

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
- Every folder, file and Google account belongs to one user, and **every API route checks it**, so users can't see each other's data.
- **The first account created takes over any files from older single-user versions.**
- Telegram and R2 are **shared** backends you pay for or operate. Set `ENCRYPTION_KEY` so you (and anyone in the
  Telegram channel) can't read users' files. Use `R2_USER_LIMIT_GB`, `SIGNUP_CODE` or `ALLOW_SIGNUP=false` to control usage.
- Google Drive is **per user**: each user connects their own Gmail accounts under **Storage → + Connect Google account**,
  and their free space is combined in their pool. The app can only see files it uploaded (`drive.file`).

## API (for scripts)
All routes except `/api/auth/*` need the session cookie from `POST /api/auth/login {email, password}`.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/auth/signup` `{email,password,name?,code?}` | create account |
| POST | `/api/auth/login` / `/api/auth/logout` | sign in / out |
| GET | `/api/auth/me` | current user |
| GET | `/api/list?folder=<id>` | folder contents (empty = root) |
| GET | `/api/search?q=text` | search file names |
| POST | `/api/folders` `{parentId, name}` or `{parentId, path:"a/b"}` | create folder(s) |
| PATCH/DELETE | `/api/folders/:id` | rename / delete recursively |
| POST | `/api/files` `{name,size,mime,folderId,target}` | start upload → `{id, chunkSize, chunkCount, sequential}` |
| PUT | `/api/files/:id/chunks/:i` (raw bytes) | upload chunk *i* (in order if `sequential`) |
| POST | `/api/files/:id/complete` | finish upload |
| GET | `/api/files/:id` · `/api/files/:id/chunks/:i` | metadata · download chunk *i* |
| PATCH/DELETE | `/api/files/:id` `{name?, folderId?}` | rename/move · delete |
| GET | `/api/accounts?refresh=1` | storage pool (Telegram, R2, Google accounts, totals) |
| GET | `/api/google/connect` · DELETE `/api/accounts/:id` | add · remove a Google account |

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
