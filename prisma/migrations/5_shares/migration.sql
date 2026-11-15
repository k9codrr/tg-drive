-- Sharing one file or folder with one person.
-- permission: view | download | edit | full. A folder share covers everything inside it.
-- password_hash: scrypt hash used to unlock; password_sealed: AES-GCM copy only the sharer and the
-- recipient can read back (keyed off SESSION_SECRET). unlocked_until: the recipient entered it.
CREATE TABLE "shares" (
  "id" BIGSERIAL PRIMARY KEY,
  "file_id" BIGINT REFERENCES "files"("id") ON DELETE CASCADE,
  "folder_id" BIGINT REFERENCES "folders"("id") ON DELETE CASCADE,
  "shared_by" BIGINT REFERENCES "users"("id") ON DELETE SET NULL,
  "shared_with" BIGINT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "permission" TEXT NOT NULL,
  "password_hash" TEXT,
  "password_sealed" TEXT,
  "unlocked_until" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "shares_one_item" CHECK (("file_id" IS NULL) <> ("folder_id" IS NULL))
);
CREATE UNIQUE INDEX "shares_file_user" ON "shares" ("file_id", "shared_with") WHERE "file_id" IS NOT NULL;
CREATE UNIQUE INDEX "shares_folder_user" ON "shares" ("folder_id", "shared_with") WHERE "folder_id" IS NOT NULL;
CREATE INDEX "shares_with" ON "shares" ("shared_with");
