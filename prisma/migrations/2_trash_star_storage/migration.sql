-- Trash, starred, per-user default storage and storage transfers.

ALTER TABLE "users" ADD COLUMN "default_storage" TEXT NOT NULL DEFAULT 'gdrive';

ALTER TABLE "folders"
  ADD COLUMN "trashed_at" TIMESTAMPTZ(6),
  ADD COLUMN "trash_root" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "starred" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "files"
  ADD COLUMN "trashed_at" TIMESTAMPTZ(6),
  ADD COLUMN "trash_root" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "starred" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "transfer_of" BIGINT,
  ADD COLUMN "transfer_lock" TIMESTAMPTZ(6);

ALTER TABLE "files" ADD CONSTRAINT "files_transfer_of_fkey"
  FOREIGN KEY ("transfer_of") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Folder names only need to be unique among folders that aren't in the trash.
DROP INDEX IF EXISTS "folders_user_parent_name";
CREATE UNIQUE INDEX "folders_user_parent_name" ON "folders" ("user_id", (COALESCE("parent_id", 0)), "name")
  WHERE "trashed_at" IS NULL;

CREATE INDEX "files_trashed" ON "files" ("user_id", "trashed_at") WHERE "trashed_at" IS NOT NULL;
CREATE INDEX "folders_trashed" ON "folders" ("user_id", "trashed_at") WHERE "trashed_at" IS NOT NULL;
CREATE INDEX "files_starred" ON "files" ("user_id") WHERE "starred";
CREATE INDEX "folders_starred" ON "folders" ("user_id") WHERE "starred";
CREATE INDEX "files_transfer_of" ON "files" ("transfer_of") WHERE "transfer_of" IS NOT NULL;
