-- Single sign-on (lib/sso.ts): which provider identity belongs to which user, and team auto-join by
-- email domain ("team sync").
CREATE TABLE "user_identities" (
  "provider" TEXT NOT NULL,          -- google | microsoft | oidc
  "subject" TEXT NOT NULL,           -- the provider's stable user id ("sub")
  "user_id" BIGINT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "email" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_login_at" TIMESTAMPTZ(6),
  PRIMARY KEY ("provider", "subject")
);
CREATE INDEX "user_identities_user" ON "user_identities" ("user_id");

-- People signing in with SSO and a verified email at sso_domain join the team with sso_role.
ALTER TABLE "teams" ADD COLUMN "sso_domain" TEXT;
ALTER TABLE "teams" ADD COLUMN "sso_role" TEXT NOT NULL DEFAULT 'member';
CREATE INDEX "teams_sso_domain" ON "teams" ("sso_domain") WHERE "sso_domain" IS NOT NULL;
