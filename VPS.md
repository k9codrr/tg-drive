# Hosting the PC drive (T:) on a VPS

Vercel runs the website, but it can't run the WebDAV server that the T: drive talks to. That server is a
long-running Node process on port 3021 (`lib/dav/server.ts`), and it needs WebDAV methods (PROPFIND, MKCOL,
MOVE) that Vercel doesn't pass through. So the setup is:

```
 Users' browsers ──► drive.weberrio.com  (Vercel: website, sign-up, "Add this PC")
                          │
                          │  same database (Neon) + same secrets
                          ▼
 Users' T: drives ──► dav.weberrio.com   (VPS: the same app, WebDAV on 3021 behind HTTPS)
```

Every user signs up on the website, connects their storage, clicks **PC drive → Add this PC**, and runs the
command it shows. Their T: then talks to the VPS, which is always on. Your own PC doesn't need to be running.

---

## 1. Get a VPS

- Ubuntu 24.04, **2 GB RAM** or more (1 GB works if you add swap; see step 4), 20 GB+ disk.
- Any provider works: Hetzner, DigitalOcean, Vultr, Contabo, Oracle free tier.
- **Bandwidth matters:** every file opened or copied on anyone's T: passes through the VPS (storage ↔ VPS ↔ PC).
  Pick a plan with plenty of included traffic.
- **Disk matters:** an upload to T: is written to the VPS's temp folder before it's sent to storage, so the
  disk needs free space for the biggest file people copy.

## 2. DNS

Add an **A record** `dav.weberrio.com` → the VPS's IP address.

If the domain is on Cloudflare, set that record to **DNS only (grey cloud)**. With the orange cloud,
Cloudflare's free plan rejects uploads over 100 MB, so big copies to T: would fail.

## 3. Install Node, git and Caddy

SSH in as root (or use `sudo`), then:

```bash
apt update && apt upgrade -y
apt install -y git curl ufw debian-keyring debian-archive-keyring apt-transport-https

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Caddy (HTTPS reverse proxy with automatic certificates)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

# Firewall: only SSH and HTTPS are reachable. Ports 3020/3021 stay private.
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# A user to run the app
adduser --system --group --home /opt/tgdrive tgdrive
```

## 4. Get the app and configure it

```bash
cd /opt/tgdrive
sudo -u tgdrive git clone <your repo URL> app
cd app
```

(Private repo: use a GitHub deploy key or a personal access token. Or copy the folder with `scp`/`rsync`.)

Create `/opt/tgdrive/app/.env`. **Copy every value from Vercel** (Project → Settings → Environment Variables),
then add the DAV lines:

```bash
# --- same as Vercel (must be IDENTICAL, or logins/encrypted files won't work) ---
DATABASE_URL=...
SESSION_SECRET=...
ENCRYPTION_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
APP_URL=https://drive.weberrio.com
# R2_*, ALLOW_SIGNUP, SSO_*, ... whatever else you set on Vercel

# --- WebDAV server for the T: drive ---
DAV_HOST=127.0.0.1
DAV_PORT=3021
DAV_TRUST_PROXY=true
DAV_PUBLIC_URL=https://dav.weberrio.com/dav/
```

`SESSION_SECRET` and `ENCRYPTION_KEY` must be exactly the same as on Vercel. `SESSION_SECRET` also decrypts the
saved Google logins, and `ENCRYPTION_KEY` decrypts Telegram/R2 chunks.

```bash
chmod 600 .env && chown tgdrive:tgdrive .env
```

Build it. On 1 GB RAM, add swap first:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

```bash
sudo -u tgdrive npm ci
sudo -u tgdrive npm run build
```

(The database tables already exist from your Vercel setup. `npm run db:migrate` is safe to run anyway.)

## 5. Run it as a service

Create `/etc/systemd/system/tgdrive.service`:

```ini
[Unit]
Description=TG Drive (WebDAV for the PC drive)
After=network-online.target
Wants=network-online.target

[Service]
User=tgdrive
WorkingDirectory=/opt/tgdrive/app
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now tgdrive
journalctl -u tgdrive -f      # should show: [dav] WebDAV drive on http://127.0.0.1:3021/dav
```

(Next.js also starts on 3020 because the WebDAV server starts with it. The firewall keeps 3020 private.)

## 6. HTTPS with Caddy

Replace `/etc/caddy/Caddyfile` with:

```
dav.weberrio.com {
	reverse_proxy 127.0.0.1:3021
}
```

```bash
systemctl reload caddy
```

Caddy gets the certificate by itself. Check it from any computer:

```bash
curl -i -X OPTIONS https://dav.weberrio.com/dav/
```

You should get `200` with a `DAV:` header.

## 7. Tell the website about it (Vercel)

In Vercel → Project → Settings → Environment Variables, add:

| Name | Value |
|---|---|
| `DAV_PUBLIC_URL` | `https://dav.weberrio.com/dav/` |
| `DAV_DISABLED` | `1` (the WebDAV server can't run on Vercel, so don't try) |

Then **redeploy**, so the build includes the new `/agent/...` setup-script route.

Check that `https://drive.weberrio.com/agent/install.ps1` shows the script.

## 8. What users do

1. Open **drive.weberrio.com**, sign up / log in.
2. Connect storage (Google account, Telegram, R2, …) and pick where T: files go (**PC drive** screen).
3. **PC drive → Add this PC** → give it a name → copy the command it shows.
4. On their Windows PC, open **PowerShell** and paste it. It:
   - downloads the drive agent to `%LOCALAPPDATA%\TGDrive`
   - installs WinFsp + rclone (through winget, which may ask for admin once)
   - logs in to `dav.weberrio.com` with their email + that PC's password
   - mounts **T:** now and at every login (Task Scheduler task "TG Drive mount")
5. Open Explorer → **T:**.

Each PC has its own password, so a user can revoke one PC on the website without affecting the others.

**Your own PC:** it currently points at `http://127.0.0.1:3021/dav` (your local app). To make T: work with the
local app closed, add your PC again on the website and run the new command. It switches you to the VPS.

## 9. Updating

Deploy the same commit to both places:

```bash
cd /opt/tgdrive/app
sudo -u tgdrive git pull
sudo -u tgdrive npm ci
sudo -u tgdrive npm run build
systemctl restart tgdrive
```

…and push to Vercel as usual. A schema change: run `npm run db:migrate` once (from either place).

## Troubleshooting

| Problem | Where to look |
|---|---|
| Setup says "Could not log in" | Wrong/revoked device password, or the VPS isn't reachable: `curl -X OPTIONS https://dav.weberrio.com/dav/` |
| T: doesn't appear / disappears | On the user's PC: `%LOCALAPPDATA%\TGDrive\agent.log` and `mount.log`. T: is removed on purpose while the server is unreachable, so Explorer doesn't hang |
| Big uploads fail | Cloudflare orange cloud on `dav.weberrio.com` (100 MB limit), or the VPS disk is full |
| Server errors | `journalctl -u tgdrive -n 200` on the VPS |
| Someone is locked out | 20 failed logins from one address block it for 10 minutes |
| Logins work on the website but not on T: | `.env` on the VPS differs from Vercel (`DATABASE_URL`, `SESSION_SECRET`) |
