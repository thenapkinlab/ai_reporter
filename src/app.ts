// The gateway as a plain Request → Response function, independent of where it runs.
// src/platform/lambda.ts wires it to AWS; src/platform/local.ts runs it on your machine.

import { authServerMetadata, identifyAssistant, protectedResourceMetadata, resourceUrl, unauthorized, verifyBearer } from "./auth";
import { DEFAULT_LIMITS, type Config } from "./config";
import { RateLimitedClassifier } from "./limits";
import type { TokenCipher } from "./crypto";
import type { Classifier } from "./filter/classifier";
import type { EngineDeps } from "./filter/engine";
import { GMAIL_SCOPE, GmailMailbox, exchangeCode, gmailAddress, googleAuthUrl, refreshAccessToken, revokeToken } from "./gmail";
import type { Mailbox } from "./mail";
import { handleMcp, toolError, type ToolBackend } from "./mcp";
import { GatewayService } from "./service";
import { checkState, clearSessionCookie, makeState, readSession, sessionCookie, workosAuthenticate, workosAuthorizeUrl, type Session } from "./session";
import type { Accounts } from "./store/types";
import { activityPage, devLoginPage, html, landingPage, messagePage, runPage, settingsPage, setupPage, type Nav } from "./dashboard/pages";

export interface AppDeps {
  config: Config;
  accounts: Accounts;
  cipher: TokenCipher;
  classifier: Classifier | null;
  /** Dev only: the mailbox every user gets instead of Gmail. */
  devMailbox?: () => Mailbox;
}

const DEV_USER = { id: "dev_user", email: "dev@localhost" };

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

/** Blocks cross-site form posts: the browser's Origin must be our own. */
function sameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("origin") === url.origin;
}

export function createApp(deps: AppDeps) {
  const { config: cfg, accounts } = deps;
  const limits = cfg.limits ?? DEFAULT_LIMITS;
  // One shared per-minute budget for the classifier, across all users and Lambda instances.
  const classifier =
    deps.classifier && new RateLimitedClassifier(deps.classifier, (m) => accounts.countModelRequest(m), limits.modelRequestsPerMinute);

  async function mailboxFor(userId: string): Promise<Mailbox | null> {
    if (cfg.dev && deps.devMailbox) return deps.devMailbox();
    const conn = await accounts.getGmail(userId);
    if (!conn) return null;
    const refresh = await deps.cipher.decrypt(conn.encrypted_refresh_token, userId);
    return new GmailMailbox(await refreshAccessToken(refresh, cfg.googleClientId, cfg.googleClientSecret));
  }

  async function disconnectGmail(userId: string): Promise<void> {
    const conn = await accounts.getGmail(userId);
    if (conn) {
      try {
        await revokeToken(await deps.cipher.decrypt(conn.encrypted_refresh_token, userId));
      } catch {
        // Still delete our copy even if Google's revoke call fails.
      }
    }
    await accounts.deleteGmail(userId);
  }

  // ------------------------------------------------------------ MCP

  async function mcp(request: Request, url: URL): Promise<Response> {
    let userId: string;
    let clientId: string | null;

    if (cfg.dev && request.headers.get("authorization") === "Bearer dev") {
      userId = DEV_USER.id;
      clientId = request.headers.get("x-dev-assistant");
      await accounts.ensureUser(DEV_USER.id, DEV_USER.email);
    } else {
      const caller = await verifyBearer(request, { authkitDomain: cfg.authkitDomain, audience: cfg.mcpAudience });
      if (!caller) return unauthorized(url.origin);
      if ("error" in caller) return unauthorized(url.origin, caller.error);
      userId = caller.userId;
      clientId = caller.clientId;
      await accounts.ensureUser(userId, String(caller.claims.email ?? ""));
    }

    const store = accounts.forUser(userId);
    const userAgent = request.headers.get("user-agent");
    const headerNames = [...request.headers.keys()].sort().join(",");
    const meta = { assistant: identifyAssistant(clientId, userAgent), clientId, userAgent, headerNames };

    let backend: ToolBackend;
    try {
      const mailbox = await mailboxFor(userId);
      if (!mailbox) {
        const msg = `Gmail isn't connected. Ask the user to connect it at ${url.origin}/setup.`;
        backend = { searchEmail: async () => toolError(msg), readEmail: async () => toolError(msg) };
      } else {
        const engine: EngineDeps = {
          classifier,
          cache: store.labelCache(),
          policy: await store.policy(cfg.withholdThreshold),
        };
        backend = new GatewayService(mailbox, engine, store, meta, limits);
      }
    } catch (e) {
      console.error("mailbox setup failed", e);
      const msg = `Couldn't reach Gmail. Ask the user to reconnect it at ${url.origin}/setup.`;
      backend = { searchEmail: async () => toolError(msg), readEmail: async () => toolError(msg) };
    }
    return handleMcp(request, backend);
  }

  // ------------------------------------------------------------ dashboard

  async function dashboard(request: Request, url: URL, session: Session): Promise<Response> {
    const store = accounts.forUser(session.uid);
    const nav = (active: Nav["active"]): Nav => ({ email: session.email, active, dev: cfg.dev });
    const path = url.pathname;
    const isPost = request.method === "POST";
    if (isPost && !sameOrigin(request, url))
      return html(messagePage("Request blocked", "Cross-site request refused.", null), 403);

    if (path === "/setup" && !isPost) {
      const conn = cfg.dev ? { gmail_address: "Demo mailbox (synthetic emails)" } : await accounts.getGmail(session.uid);
      return html(setupPage(nav("setup"), resourceUrl(url.origin), conn ? { address: conn.gmail_address } : null));
    }

    if (path === "/activity" && !isPost) {
      const connected = cfg.dev || !!(await accounts.getGmail(session.uid));
      const usage = { today: await store.usageToday(new Date()), perDay: limits.emailsPerDay };
      return html(activityPage(nav("activity"), await store.totals(), await store.recentRuns(), connected, usage));
    }

    const runMatch = path.match(/^\/runs\/([\w-]+)$/);
    if (runMatch && !isPost) {
      const found = await store.run(runMatch[1]!);
      if (!found) return html(messagePage("Not found", "That request doesn't exist.", nav("activity")), 404);
      const conn = cfg.dev ? null : await accounts.getGmail(session.uid);
      return html(runPage(nav("activity"), found.run, found.items, conn?.gmail_address ?? null));
    }

    if (path === "/settings" && !isPost) {
      return html(settingsPage(nav("settings"), await store.settings(), cfg.withholdThreshold));
    }

    if (path === "/settings" && isPost) {
      const f = await request.formData();
      await store.saveSettings(f.get("medical") === "on", f.get("financial") === "on");
      return redirect("/settings");
    }

    if (path === "/feedback" && isPost) {
      const f = await request.formData();
      const runId = String(f.get("run") ?? "");
      const messageId = String(f.get("message") ?? "");
      const decision = f.get("decision") === "release" ? "release" : "keep";
      const found = await store.run(runId);
      // Only accept feedback on an email that really appears in this user's run.
      if (found?.items.some((i) => i.message_id === messageId)) await store.feedback(messageId, decision);
      return redirect(`/runs/${encodeURIComponent(runId)}`);
    }

    if (path === "/gmail/connect" && !isPost) {
      if (cfg.dev) return redirect("/setup");
      const state = await makeState(cfg, "gmail", session.uid);
      return redirect(googleAuthUrl(cfg.googleClientId, `${url.origin}/gmail/callback`, state));
    }

    if (path === "/gmail/callback" && !isPost) {
      const st = await checkState(cfg, url.searchParams.get("state"), "gmail");
      const code = url.searchParams.get("code");
      if (!st || st.uid !== session.uid || !code)
        return html(messagePage("Gmail not connected", "The Google sign-in didn't complete. Try again from Setup.", nav("setup")), 400);
      const tokens = await exchangeCode(code, cfg.googleClientId, cfg.googleClientSecret, `${url.origin}/gmail/callback`);
      if (!tokens.refresh_token || !(tokens.scope ?? "").includes(GMAIL_SCOPE))
        return html(messagePage("Gmail not connected", "Google didn't grant read access to Gmail. Try again and allow access.", nav("setup")), 400);
      const address = await gmailAddress(tokens.access_token);
      await accounts.saveGmail(session.uid, address, await deps.cipher.encrypt(tokens.refresh_token, session.uid), tokens.scope ?? GMAIL_SCOPE);
      return redirect("/setup");
    }

    if (path === "/gmail/disconnect" && isPost) {
      await disconnectGmail(session.uid);
      return redirect("/setup");
    }

    if (path === "/account/delete" && isPost) {
      const f = await request.formData();
      if (f.get("confirm") !== "on") return redirect("/settings");
      await disconnectGmail(session.uid);
      await store.deleteAll();
      return html(messagePage("Deleted", "Your data has been deleted and Gmail access revoked.", null), 200, {
        "set-cookie": clearSessionCookie(),
      });
    }

    return html(messagePage("Not found", "That page doesn't exist.", nav("")), 404);
  }

  // ------------------------------------------------------------ router

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")
        return json(protectedResourceMetadata(url.origin, cfg.authkitDomain));
      if (path === "/.well-known/oauth-authorization-server") return await authServerMetadata(cfg.authkitDomain);
      if (path === "/mcp") return await mcp(request, url);

      if (path === "/login") {
        if (cfg.dev) return html(devLoginPage());
        return redirect(workosAuthorizeUrl(cfg, `${url.origin}/auth/callback`, await makeState(cfg, "login")));
      }
      if (path === "/dev-login" && request.method === "POST" && cfg.dev) {
        await accounts.upsertUser(DEV_USER.id, DEV_USER.email);
        return redirect("/activity", [await sessionCookie(cfg, DEV_USER.id, DEV_USER.email, false)]);
      }
      if (path === "/auth/callback") {
        const st = await checkState(cfg, url.searchParams.get("state"), "login");
        const code = url.searchParams.get("code");
        if (!st || !code) return html(messagePage("Sign-in failed", "Please try signing in again.", null), 400);
        const user = await workosAuthenticate(cfg, code);
        await accounts.upsertUser(user.id, user.email);
        const conn = await accounts.getGmail(user.id);
        return redirect(conn ? "/activity" : "/setup", [
          await sessionCookie(cfg, user.id, user.email, url.protocol === "https:"),
        ]);
      }
      if (path === "/logout" && request.method === "POST") return redirect("/", [clearSessionCookie()]);

      const session = await readSession(request, cfg);
      if (path === "/") return session ? redirect("/activity") : html(landingPage(cfg.dev));
      if (!session) return redirect("/");
      return await dashboard(request, url, session);
    } catch (e) {
      console.error(e);
      return html(messagePage("Something went wrong", "The request failed. Please try again.", null), 500);
    }
  }

  return { handle };
}
