-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folders" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT,
    "name" TEXT NOT NULL,
    "parent_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_accounts" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "refresh_token" TEXT NOT NULL,
    "access_token" TEXT,
    "access_expires" TIMESTAMPTZ(6),
    "root_folder_id" TEXT,
    "quota_limit" BIGINT,
    "quota_usage" BIGINT NOT NULL DEFAULT 0,
    "quota_updated_at" TIMESTAMPTZ(6),
    "needs_reauth" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "google_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT,
    "name" TEXT NOT NULL,
    "folder_id" BIGINT,
    "size" BIGINT NOT NULL,
    "mime" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "chunk_size" INTEGER NOT NULL,
    "chunk_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "backend" TEXT NOT NULL DEFAULT 'telegram',
    "gd_account_id" BIGINT,
    "gd_file_id" TEXT,
    "gd_upload_url" TEXT,
    "uploaded_bytes" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "file_id" BIGINT NOT NULL,
    "idx" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "tg_file_id" TEXT,
    "tg_message_id" BIGINT,
    "r2_key" TEXT,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("file_id","idx")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "google_accounts_user_email" ON "google_accounts"("user_id", "email");

-- CreateIndex
CREATE INDEX "files_user_folder" ON "files"("user_id", "folder_id");

-- CreateIndex
CREATE INDEX "files_gd_account" ON "files"("gd_account_id");

-- CreateIndex
CREATE INDEX "files_backend" ON "files"("backend");

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_accounts" ADD CONSTRAINT "google_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_gd_account_id_fkey" FOREIGN KEY ("gd_account_id") REFERENCES "google_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written: folder names are unique per (user, parent), treating the root (NULL parent) as one parent.
CREATE UNIQUE INDEX "folders_user_parent_name" ON "folders" ("user_id", (COALESCE("parent_id", 0)), "name");
