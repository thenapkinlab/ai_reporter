// End-to-end through the app with local deps, plus the Lambda Function URL adapters.

import { describe, expect, it } from "vitest";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { createApp } from "../src/app";
import { LocalCipher, randomKeyB64 } from "../src/crypto";
import { FixtureMailbox } from "../src/fixtures";
import { TableAccounts } from "../src/store/single-table";
import { MemoryTable } from "../src/store/table";
import { toRequest, toResult } from "../src/platform/lambda";

const ORIGIN = "http://localhost:8787";

function devApp(dev = true, addresses: { appOrigin?: string; siteOrigin?: string } = {}) {
  return createApp({
    config: {
      ...addresses,
      authkitDomain: "https://example.authkit.app",
      workosClientId: "x",
      workosApiKey: "x",
      googleClientId: "x",
      googleClientSecret: "x",
      sessionSecret: randomKeyB64(),
      withholdThreshold: 0.6,
      dev,
    },
    accounts: new TableAccounts(new MemoryTable(), randomKeyB64()),
    cipher: new LocalCipher(randomKeyB64()),
    classifier: null,
    devMailbox: () => new FixtureMailbox(),
  });
}

const mcpCall = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function signIn(app: ReturnType<typeof devApp>): Promise<string> {
  const res = await app.handle(new Request(`${ORIGIN}/dev-login`, { method: "POST", headers: { origin: ORIGIN } }));
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
}

describe("app", () => {
  it("asks assistants to sign in, pointing at our metadata", async () => {
    const res = await devApp().handle(mcpCall({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`${ORIGIN}/.well-known/oauth-protected-resource`);
    const meta = await (await devApp().handle(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`))).json();
    expect(meta).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: ["https://example.authkit.app"] });
  });

  it("ignores the dev token when dev mode is off", async () => {
    const res = await devApp(false).handle(mcpCall({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer dev" }));
    expect(res.status).toBe(401);
  });

  it("filters a search and shows it on the signed-in user's dashboard", async () => {
    const app = devApp();
    const res = await app.handle(
      mcpCall(
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_email", arguments: { query: "statement lab order" } } },
        { authorization: "Bearer dev", "x-dev-assistant": "openai" },
      ),
    );
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("4111");
    expect(body).not.toContain("Glucose");

    const cookie = await signIn(app);
    const page = await (await app.handle(new Request(`${ORIGIN}/activity`, { headers: { cookie } }))).text();
    expect(page).toContain("ChatGPT");
    expect(page).toContain("statement lab order");
    expect(page).toMatch(/withheld/);
  });

  it("refuses cross-site form posts and pages without a session", async () => {
    const app = devApp();
    const cookie = await signIn(app);
    const blocked = await app.handle(
      new Request(`${ORIGIN}/settings`, { method: "POST", headers: { cookie, origin: "https://evil.example" } }),
    );
    expect(blocked.status).toBe(403);
    const anon = await app.handle(new Request(`${ORIGIN}/activity`));
    expect(anon.status).toBe(302);
  });
});

describe("Lambda Function URL adapter", () => {
  const event = {
    rawPath: "/mcp",
    rawQueryString: "a=1",
    headers: { "content-type": "application/json", host: "abc.lambda-url.us-east-1.on.aws" },
    cookies: ["gw_session=xyz", "other=1"],
    body: Buffer.from('{"jsonrpc":"2.0"}').toString("base64"),
    isBase64Encoded: true,
    requestContext: { domainName: "abc.lambda-url.us-east-1.on.aws", http: { method: "POST" } },
  } as unknown as LambdaFunctionURLEvent;

  it("rebuilds the request: URL, cookies and body", async () => {
    const req = toRequest(event);
    expect(req.url).toBe("https://abc.lambda-url.us-east-1.on.aws/mcp?a=1");
    expect(req.headers.get("cookie")).toBe("gw_session=xyz; other=1");
    expect(await req.text()).toBe('{"jsonrpc":"2.0"}');
  });

  it("returns Set-Cookie headers in the cookies field", async () => {
    const headers = new Headers({ location: "/x" });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    const out = await toResult(new Response(null, { status: 302, headers }));
    expect(out.statusCode).toBe(302);
    expect(out.cookies).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(out.headers).toEqual({ location: "/x" });
  });
});

describe("invite-only beta", () => {
  it("serves the guide and notice without signing in", async () => {
    const app = devApp(false);
    const guide = await app.handle(new Request(`${ORIGIN}/guide`));
    expect(guide.status).toBe(200);
    expect(await guide.text()).toContain(`${ORIGIN}/mcp`);
    expect((await app.handle(new Request(`${ORIGIN}/notice`))).status).toBe(200);
  });

  it("keeps an allow list of lower-cased emails", async () => {
    const accounts = new TableAccounts(new MemoryTable(), randomKeyB64());
    await accounts.allow("Tester@Example.com ");
    expect(await accounts.isAllowed("tester@example.com")).toBe(true);
    expect(await accounts.isAllowed("TESTER@example.com")).toBe(true);
    expect(await accounts.isAllowed("someone@else.com")).toBe(false);
    expect(await accounts.isAllowed("")).toBe(false);
    await accounts.disallow("tester@example.com");
    expect(await accounts.allowed()).toEqual([]);
  });

  it("requires the beta notice before connecting Gmail", async () => {
    const app = devApp();
    const cookie = await signIn(app);
    const noAck = await app.handle(new Request(`${ORIGIN}/gmail/connect`, { headers: { cookie } }));
    expect(noAck.headers.get("location")).toBe("/setup");
  });
});

describe("public pages", () => {
  const get = async (path: string) => {
    const res = await devApp(false).handle(new Request(`${ORIGIN}${path}`));
    return { status: res.status, body: await res.text() };
  };

  it("serves a home page that explains the app and links to the privacy policy, without signing in", async () => {
    const { status, body } = await get("/");
    expect(status).toBe(200);
    expect(body).toContain("Warded");
    expect(body).toContain('href="/privacy"');
    expect(body).not.toContain("Private Gmail");
  });

  it("serves a privacy policy with Google's Limited Use statement, without signing in", async () => {
    const { status, body } = await get("/privacy");
    expect(status).toBe(200);
    expect(body).toContain("Limited Use requirements");
    expect(body).toContain("gmail.readonly");
    expect(body).not.toContain("__");
  });
});

describe("separate app address", () => {
  const APP = "https://app.warded.test";
  const SITE = "https://warded.test";
  const OLD = "https://old.lambda-url.on.aws";
  const app = () => devApp(false, { appOrigin: APP, siteOrigin: SITE });
  const open = (url: string) => app().handle(new Request(url));

  it("keeps public pages on the site, and sends everything else to the app", async () => {
    for (const p of ["/", "/privacy", "/guide", "/notice"]) expect((await open(`${SITE}${p}`)).status).toBe(200);
    for (const p of ["/login", "/setup", "/activity"]) {
      const res = await open(`${SITE}${p}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${APP}${p}`);
    }
  });

  it("sends old links to the app, keeping their query", async () => {
    expect((await open(`${OLD}/`)).headers.get("location")).toBe(`${APP}/`);
    expect((await open(`${OLD}/guide`)).headers.get("location")).toBe(`${APP}/guide`);
    expect((await open(`${OLD}/gmail/callback?state=a&code=b`)).headers.get("location")).toBe(`${APP}/gmail/callback?state=a&code=b`);
  });

  it("doesn't move connectors: /mcp and its metadata answer on every address", async () => {
    for (const origin of [OLD, SITE, APP]) {
      const res = await app().handle(new Request(`${origin}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
      expect(res.status).toBe(401);
      const meta = (await (await open(`${origin}/.well-known/oauth-protected-resource`)).json()) as { resource: string };
      expect(meta.resource).toBe(`${origin}/mcp`);
    }
  });

  it("serves pages on the app itself, and shows the app's connector address in the guide everywhere", async () => {
    expect((await open(`${APP}/`)).status).toBe(200);
    expect(await (await open(`${SITE}/guide`)).text()).toContain(`${APP}/mcp`);
  });

  it("changes nothing when no app address is set", async () => {
    const res = await devApp(false).handle(new Request(`${OLD}/guide`));
    expect(res.status).toBe(200);
  });
});

