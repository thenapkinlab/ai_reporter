// MCP authorization: our gateway is the protected resource, WorkOS AuthKit is the
// authorization server. Assistants discover AuthKit from our metadata, sign the user in,
// and send AuthKit-issued JWTs, which we verify on every call.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Assistant } from "./store/types";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(domain: string) {
  let set = jwksCache.get(domain);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${domain}/oauth2/jwks`));
    jwksCache.set(domain, set);
  }
  return set;
}

export interface Caller {
  userId: string;
  clientId: string | null;
  claims: JWTPayload;
}

export function resourceUrl(origin: string): string {
  return `${origin}/mcp`;
}

export function protectedResourceMetadata(origin: string, authkitDomain: string) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [authkitDomain],
    bearer_methods_supported: ["header"],
    resource_name: "Private Gmail gateway",
  };
}

export function unauthorized(origin: string, error?: string): Response {
  const meta = `${origin}/.well-known/oauth-protected-resource`;
  const params = [`resource_metadata="${meta}"`];
  if (error) params.push(`error="invalid_token"`, `error_description="${error.replace(/"/g, "'")}"`);
  return new Response(JSON.stringify({ error: error ?? "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": `Bearer ${params.join(", ")}` },
  });
}

/** Verifies signature, issuer, expiry and (if configured) audience. Returns null when missing or invalid. */
export async function verifyBearer(
  request: Request,
  opts: { authkitDomain: string; audience?: string },
): Promise<Caller | { error: string } | null> {
  const h = request.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1]!, jwks(opts.authkitDomain), {
      issuer: opts.authkitDomain,
      ...(opts.audience ? { audience: opts.audience } : {}),
    });
    if (!payload.sub) return { error: "token has no subject" };
    const clientId = (payload.client_id ?? payload.azp ?? null) as string | null;
    return { userId: payload.sub, clientId, claims: payload };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "invalid token" };
  }
}

/** Best-effort label for which assistant is calling. ChatGPT's client ID is an OpenAI URL (CIMD). */
export function identifyAssistant(clientId: string | null, userAgent: string | null): Assistant {
  const hay = `${clientId ?? ""} ${userAgent ?? ""}`.toLowerCase();
  if (/openai|chatgpt/.test(hay)) return "chatgpt";
  if (/claude|anthropic/.test(hay)) return "claude";
  return "unknown";
}

/** Fetches AuthKit's metadata for older clients that look for it on the resource's own origin. */
export async function authServerMetadata(authkitDomain: string): Promise<Response> {
  const res = await fetch(`${authkitDomain}/.well-known/oauth-authorization-server`);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
}
