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

function devApp(dev = true) {
  return createApp({
    config: {
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
