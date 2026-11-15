-- Per-file password encryption (see lib/filecrypt.ts).
-- files.encryption: { v, alg, nonce, slots: { owner: <password-wrapped file key> }, pending? } or NULL.
-- shares.key_wrap: the file key wrapped with the share's password (shares of encrypted files).
ALTER TABLE "files" ADD COLUMN "encryption" JSONB;
ALTER TABLE "shares" ADD COLUMN "key_wrap" JSONB;
