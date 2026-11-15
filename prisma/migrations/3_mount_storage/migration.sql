-- Where files written through the PC drive (T:) are stored, and names skipped on upload.

-- "same" = follow users.default_storage; otherwise a storage target ("gdrive", "gdrive:<id>", "telegram", "r2").
ALTER TABLE "users" ADD COLUMN "mount_storage" TEXT NOT NULL DEFAULT 'same';
-- Comma-separated file/folder names never uploaded (from the browser or the PC drive).
ALTER TABLE "users" ADD COLUMN "upload_exclude" TEXT NOT NULL DEFAULT 'node_modules,.next';
-- Per-PC override of mount_storage (NULL = use the account's setting).
ALTER TABLE "device_tokens" ADD COLUMN "storage" TEXT;
