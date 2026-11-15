-- Teams, roles (RBAC), invites and in-app notifications.
-- Files/folders now live in a "space": private (team_id NULL, owned by user_id) or a team (team_id set;
-- user_id is then whoever created the item).

CREATE TABLE "teams" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "created_by" BIGINT REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- role: owner | admin | manager | member | viewer
CREATE TABLE "team_members" (
  "team_id" BIGINT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "user_id" BIGINT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY ("team_id", "user_id")
);
CREATE INDEX "team_members_user" ON "team_members" ("user_id");

CREATE TABLE "team_invites" (
  "id" BIGSERIAL PRIMARY KEY,
  "team_id" BIGINT NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "invited_by" BIGINT REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "team_invites_team_email" ON "team_invites" ("team_id", "email");
CREATE INDEX "team_invites_email" ON "team_invites" ("email");

CREATE TABLE "notifications" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" BIGINT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "data" JSONB,
  "read_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "notifications_user" ON "notifications" ("user_id", "created_at" DESC);

ALTER TABLE "folders" ADD COLUMN "team_id" BIGINT REFERENCES "teams"("id") ON DELETE CASCADE;
ALTER TABLE "files" ADD COLUMN "team_id" BIGINT REFERENCES "teams"("id") ON DELETE CASCADE;
CREATE INDEX "folders_team_parent" ON "folders" ("team_id", "parent_id") WHERE "team_id" IS NOT NULL;
CREATE INDEX "files_team_folder" ON "files" ("team_id", "folder_id") WHERE "team_id" IS NOT NULL;

-- Folder names are unique per parent within a space (private: per user; team: per team).
DROP INDEX IF EXISTS "folders_user_parent_name";
CREATE UNIQUE INDEX "folders_user_parent_name" ON "folders" ("user_id", (COALESCE("parent_id", 0)), "name")
  WHERE "trashed_at" IS NULL AND "team_id" IS NULL;
CREATE UNIQUE INDEX "folders_team_parent_name" ON "folders" ("team_id", (COALESCE("parent_id", 0)), "name")
  WHERE "trashed_at" IS NULL AND "team_id" IS NOT NULL;
