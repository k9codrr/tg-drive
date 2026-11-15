// Single sign-on with OpenID Connect (Authorization Code + PKCE). Providers come from the environment:
//
//   Google            SSO_GOOGLE=true   (uses GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)
//   Microsoft Entra   MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT (a tenant id or domain; or "organizations")
//   Any OIDC (Okta, Auth0, Keycloak, Authentik, …)
//                     OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_NAME (button label)
//
// Redirect URI to register with the provider: <APP_URL>/api/auth/sso/<google|microsoft|oidc>/callback
//
// The ID token is taken straight from the provider's token endpoint over TLS, using our client secret,
// which OpenID Connect Core §3.1.3.7 (6) accepts in place of checking its signature; issuer, audience,
// expiry and nonce are still checked.
//
// Signing in links to an account by (provider, subject); a new identity is linked to an existing account
// only by a verified email. New accounts are created unless SSO_ALLOW_SIGNUP=false. Then "team sync":
// a verified email at a team's SSO domain joins that team with the team's SSO role.
import { createHash, randomBytes } from "node:crypto";
import { openString, sealString } from "./crypto";
import { prisma } from "./db";
import { HttpError } from "./http";
import { isRole, ROLE_INFO } from "./rbac";
import { notify } from "./teams";

export type ProviderId = "google" | "microsoft" | "oidc";
type Provider = {
  id: ProviderId;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Accept the email as verified even without email_verified (an organisation's own directory). */
  trustEmail: boolean;
  /** Accept any issuer matching this (Microsoft multi-tenant issuers contain the tenant id). */
  issuerPattern?: RegExp;
};

export function providers(): Provider[] {
  const e = process.env;
  const out: Provider[] = [];
  if (e.SSO_GOOGLE === "true" && e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET) {
    out.push({ id: "google", name: "Google", issuer: "https://accounts.google.com", clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET, trustEmail: false });
  }
  if (e.MS_CLIENT_ID && e.MS_CLIENT_SECRET) {
    const tenant = e.MS_TENANT || "organizations";
    const multi = ["common", "organizations", "consumers"].includes(tenant);
    out.push({
      id: "microsoft",
      name: "Microsoft",
      issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      clientId: e.MS_CLIENT_ID,
      clientSecret: e.MS_CLIENT_SECRET,
      // A single tenant's directory controls its addresses; multi-tenant sign-ins only count when verified.
      trustEmail: !multi || e.MS_TRUST_EMAIL === "true",
      issuerPattern: multi ? /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/ : undefined,
    });
  }
  if (e.OIDC_ISSUER && e.OIDC_CLIENT_ID && e.OIDC_CLIENT_SECRET) {
    out.push({
      id: "oidc",
      name: e.OIDC_NAME || "Single sign-on",
      issuer: e.OIDC_ISSUER.replace(/\/+$/, ""),
      clientId: e.OIDC_CLIENT_ID,
      clientSecret: e.OIDC_CLIENT_SECRET,
      trustEmail: e.OIDC_TRUST_EMAIL === "true",
    });
  }
  return out;
}

export function provider(id: string) {
  const p = providers().find((x) => x.id === id);
  if (!p) throw new HttpError(404, "That sign-in method isn't set up on this server");
  return p;
}

/** Password sign-in can be turned off (PASSWORD_LOGIN=false) once SSO is set up. */
export const passwordLoginEnabled = () => process.env.PASSWORD_LOGIN !== "false" || providers().length === 0;

// ---------- discovery ----------

type Discovery = { authorization_endpoint: string; token_endpoint: string; issuer: string };
const discoveries = new Map<string, { d: Discovery; at: number }>();

async function discover(p: Provider): Promise<Discovery> {
  const hit = discoveries.get(p.issuer);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.d;
  const res = await fetch(`${p.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${p.name}: discovery failed (HTTP ${res.status})`);
  const d = (await res.json()) as Discovery;
  if (!d.authorization_endpoint || !d.token_endpoint) throw new Error(`${p.name}: discovery document is incomplete`);
  discoveries.set(p.issuer, { d, at: Date.now() });
  return d;
}

// ---------- the round trip ----------

export const SSO_COOKIE = "tgd_sso";
const b64url = (b: Buffer) => b.toString("base64url");

export const redirectUri = (origin: string, id: ProviderId) =>
  `${(process.env.APP_URL || origin).replace(/\/+$/, "")}/api/auth/sso/${id}/callback`;

/** Authorization URL plus the sealed cookie value carrying state, nonce and the PKCE verifier. */
export async function startLogin(p: Provider, origin: string, next: string) {
  const d = await discover(p);
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: redirectUri(origin, p.id),
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(p.id === "google" ? { prompt: "select_account" } : {}),
  }).toString();
  const cookie = sealString(JSON.stringify({ p: p.id, state, nonce, verifier, next, at: Date.now() }));
  return { url: url.toString(), cookie };
}

type Claims = {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  preferred_username?: string;
  upn?: string;
  name?: string;
};

/** Exchanges the code and returns the checked identity. */
export async function finishLogin(p: Provider, origin: string, params: URLSearchParams, cookie: string | undefined) {
  if (params.get("error")) throw new HttpError(400, params.get("error_description") || params.get("error")!);
  if (!cookie) throw new HttpError(400, "Sign-in expired. Please try again.");
  let saved: { p: string; state: string; nonce: string; verifier: string; next: string; at: number };
  try {
    saved = JSON.parse(openString(cookie));
  } catch {
    throw new HttpError(400, "Sign-in expired. Please try again.");
  }
  if (saved.p !== p.id || saved.state !== params.get("state") || Date.now() - saved.at > 10 * 60_000) {
    throw new HttpError(400, "Sign-in expired or was started elsewhere. Please try again.");
  }
  const code = params.get("code");
  if (!code) throw new HttpError(400, "The provider sent no code");

  const d = await discover(p);
  const res = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(origin, p.id),
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code_verifier: saved.verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tok = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !tok.id_token) throw new HttpError(400, `${p.name}: ${tok.error_description || tok.error || `token request failed (HTTP ${res.status})`}`);

  const claims = decodeJwt(tok.id_token);
  const issOk = p.issuerPattern ? p.issuerPattern.test(claims.iss) : claims.iss.replace(/\/+$/, "") === (d.issuer || p.issuer).replace(/\/+$/, "");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!issOk) throw new HttpError(400, `${p.name}: unexpected token issuer`);
  if (!aud.includes(p.clientId)) throw new HttpError(400, `${p.name}: token is for another app`);
  if (!claims.exp || claims.exp * 1000 < Date.now() - 60_000) throw new HttpError(400, `${p.name}: token expired`);
  if (claims.nonce !== saved.nonce) throw new HttpError(400, `${p.name}: sign-in check failed (nonce)`);

  const email = (claims.email || claims.preferred_username || claims.upn || "").trim().toLowerCase();
  const verified = claims.email_verified === true || claims.email_verified === "true" || (p.trustEmail && !!email);
  return { subject: claims.sub, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null, verified, name: claims.name ?? null, next: saved.next };
}

function decodeJwt(jwt: string): Claims {
  const parts = jwt.split(".");
  if (parts.length < 2) throw new HttpError(400, "Malformed ID token");
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Claims;
  } catch {
    throw new HttpError(400, "Malformed ID token");
  }
}

// ---------- accounts ----------

/** Finds or creates the user for a checked identity, links it, and runs team sync. Returns the user id. */
export async function signInWith(
  p: Provider,
  id: { subject: string; email: string | null; verified: boolean; name: string | null },
): Promise<string> {
  const key = { provider_subject: { provider: p.id, subject: id.subject } };
  const linked = await prisma.userIdentity.findUnique({ where: key, select: { userId: true } });
  let uid: bigint;
  if (linked) {
    uid = linked.userId;
  } else {
    if (!id.email || !id.verified) {
      throw new HttpError(403, `${p.name} didn't confirm your email address, so it can't be linked to an account`);
    }
    const existing = await prisma.user.findUnique({ where: { email: id.email }, select: { id: true } });
    if (existing) {
      uid = existing.id;
    } else {
      if (process.env.SSO_ALLOW_SIGNUP === "false" && !(await domainHasTeam(id.email))) {
        throw new HttpError(403, "There's no account for this email, and new sign-ups are closed");
      }
      // SSO-only account: this hash matches no password, so password sign-in stays impossible.
      const created = await prisma.user.create({
        data: { email: id.email, name: id.name?.slice(0, 100) ?? null, passwordHash: `sso$${p.id}` },
        select: { id: true },
      });
      uid = created.id;
    }
    await prisma.userIdentity.create({ data: { provider: p.id, subject: id.subject, userId: uid, email: id.email } });
  }
  await prisma.userIdentity.update({ where: key, data: { lastLoginAt: new Date(), ...(id.email ? { email: id.email } : {}) } });
  if (id.email && id.verified) await teamSync(uid, id.email);
  return String(uid);
}

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

async function domainHasTeam(email: string) {
  return (await prisma.team.count({ where: { ssoDomain: domainOf(email) } })) > 0;
}

/** Joins the teams whose SSO domain matches the (verified) email, with each team's SSO role. */
async function teamSync(uid: bigint, email: string) {
  const teams = await prisma.team.findMany({
    where: { ssoDomain: domainOf(email), members: { none: { userId: uid } } },
    select: { id: true, name: true, ssoRole: true },
  });
  for (const t of teams) {
    const role = isRole(t.ssoRole) && t.ssoRole !== "owner" ? t.ssoRole : "member";
    await prisma.teamMember.create({ data: { teamId: t.id, userId: uid, role } }).catch(() => {});
    await notify(uid, "team.joined", `You joined ${t.name} through single sign-on`, `Role: ${ROLE_INFO[role].label}`, {
      teamId: String(t.id),
    });
  }
}

// Webmail and other shared domains nobody may claim for team sync.
const PUBLIC_DOMAINS = new Set(
  "gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com yahoo.co.in ymail.com icloud.com me.com mac.com aol.com proton.me protonmail.com gmx.com gmx.de mail.com zoho.com yandex.com yandex.ru qq.com 163.com rediffmail.com".split(" "),
);

/**
 * Sets (or clears) a team's SSO domain. Only team admins, only their own email's domain, never a
 * public webmail domain, and each domain can belong to one team only.
 */
export async function setTeamSso(adminEmail: string, teamId: bigint, domainIn: unknown, roleIn: unknown) {
  const role = isRole(roleIn) && roleIn !== "owner" ? roleIn : "member";
  const domain = typeof domainIn === "string" ? domainIn.trim().toLowerCase().replace(/^@/, "") : "";
  if (!domain) {
    await prisma.team.update({ where: { id: teamId }, data: { ssoDomain: null, ssoRole: role } });
    return;
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new HttpError(400, "Enter a domain like example.com");
  if (PUBLIC_DOMAINS.has(domain)) throw new HttpError(400, `${domain} is a public email domain; use your organisation's domain`);
  if (domainOf(adminEmail) !== domain) {
    throw new HttpError(403, `You can only set your own email's domain (${domainOf(adminEmail)})`);
  }
  const other = await prisma.team.findFirst({ where: { ssoDomain: domain, id: { not: teamId } }, select: { name: true } });
  if (other) throw new HttpError(409, `${domain} is already used by another team`);
  await prisma.team.update({ where: { id: teamId }, data: { ssoDomain: domain, ssoRole: role } });
}

