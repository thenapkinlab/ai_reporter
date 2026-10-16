// Dashboard sign-in through WorkOS AuthKit's hosted page, and a signed session cookie.

import { signPayload, verifyPayload } from "./crypto";
import type { Config } from "./config";

const COOKIE = "gw_session";
const SESSION_HOURS = 12;

export interface Session {
  uid: string;
  email: string;
  exp: number;
}

export function workosAuthorizeUrl(cfg: Config, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: cfg.workosClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    provider: "authkit",
    state,
  });
  return `https://api.workos.com/user_management/authorize?${p}`;
}

export async function workosAuthenticate(cfg: Config, code: string): Promise<{ id: string; email: string }> {
  const res = await fetch("https://api.workos.com/user_management/authenticate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: cfg.workosClientId,
      client_secret: cfg.workosApiKey,
      grant_type: "authorization_code",
      code,
    }),
  });
  const json = (await res.json()) as { user?: { id: string; email: string }; message?: string };
  if (!res.ok || !json.user) throw new Error(`Sign-in failed: ${json.message ?? res.status}`);
  return json.user;
}

/** A WorkOS user's email, for MCP tokens that don't carry it. */
export async function workosUserEmail(cfg: Config, userId: string): Promise<string | null> {
  const res = await fetch(`https://api.workos.com/user_management/users/${encodeURIComponent(userId)}`, {
    headers: { authorization: `Bearer ${cfg.workosApiKey}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { email?: string };
  return json.email ?? null;
}

export async function sessionCookie(cfg: Config, uid: string, email: string, secure: boolean): Promise<string> {
  const token = await signPayload({ uid, email, exp: Date.now() + SESSION_HOURS * 3600_000 }, cfg.sessionSecret);
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function readSession(request: Request, cfg: Config): Promise<Session | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const s = await verifyPayload<Session>(m[1]!, cfg.sessionSecret);
  return s && s.exp > Date.now() ? s : null;
}

/** Signed, expiring OAuth `state` bound to a purpose (and a user for Gmail linking). */
export async function makeState(cfg: Config, purpose: string, uid = ""): Promise<string> {
  return signPayload({ p: purpose, uid, exp: Date.now() + 10 * 60_000, n: crypto.randomUUID() }, cfg.sessionSecret);
}

export async function checkState(cfg: Config, state: string | null, purpose: string): Promise<{ uid: string } | null> {
  if (!state) return null;
  const s = await verifyPayload<{ p: string; uid: string; exp: number }>(state, cfg.sessionSecret);
  return s && s.p === purpose && s.exp > Date.now() ? { uid: s.uid } : null;
}
