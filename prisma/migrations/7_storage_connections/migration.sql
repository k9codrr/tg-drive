-- Storage people connect themselves (lib/connections.ts): Telegram bots, S3-compatible buckets
-- (Cloudflare R2, AWS, Backblaze B2, Wasabi, MinIO...), external WebDAV servers — per user or per team.
-- config is AES-GCM sealed with SESSION_SECRET and never sent to browsers.
CREATE TABLE "storage_connections" (
  "id" BIGSERIAL PRIMARY KEY,
  "kind" TEXT NOT NULL,                       -- telegram | s3 | webdav
  "name" TEXT NOT NULL,
  "user_id" BIGINT REFERENCES "users"("id") ON DELETE CASCADE,  -- owner (user level) / who added it (team level)
  "team_id" BIGINT REFERENCES "teams"("id") ON DELETE CASCADE,  -- set = belongs to the team
  "offer_to_members" BOOLEAN NOT NULL DEFAULT false,            -- team level: members may use it for private files
  "config" TEXT NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',          -- non-secret description shown in the app
  "limit_bytes" BIGINT,                        -- optional cap on what TG Drive stores there
  "last_error" TEXT,
  "checked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "storage_connections_user" ON "storage_connections" ("user_id") WHERE "team_id" IS NULL;
CREATE INDEX "storage_connections_team" ON "storage_connections" ("team_id") WHERE "team_id" IS NOT NULL;

-- Which connection holds a file's chunks (NULL = the server's own Telegram/R2 from the environment).
ALTER TABLE "files" ADD COLUMN "connection_id" BIGINT REFERENCES "storage_connections"("id") ON DELETE RESTRICT;
CREATE INDEX "files_connection" ON "files" ("connection_id") WHERE "connection_id" IS NOT NULL;

-- Google accounts can belong to a team (connected by an admin) and be offered to members.
ALTER TABLE "google_accounts" ADD COLUMN "team_id" BIGINT REFERENCES "teams"("id") ON DELETE CASCADE;
ALTER TABLE "google_accounts" ADD COLUMN "offer_to_members" BOOLEAN NOT NULL DEFAULT false;
DROP INDEX IF EXISTS "google_accounts_user_email";
CREATE UNIQUE INDEX "google_accounts_user_email" ON "google_accounts" ("user_id", "email") WHERE "team_id" IS NULL;
CREATE UNIQUE INDEX "google_accounts_team_email" ON "google_accounts" ("team_id", "email") WHERE "team_id" IS NOT NULL;
