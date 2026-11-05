import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentMessage, classifyError, logError } from "../src/logging";
import { identifyAssistant } from "../src/auth";
import { createApp } from "../src/app";
import { GatewayService } from "../src/service";
import { FixtureMailbox } from "../src/fixtures";
import { guidePage } from "../src/dashboard/pages";
import { TableAccounts } from "../src/store/single-table";
import { MemoryTable } from "../src/store/table";
import { randomKeyB64 } from "../src/crypto";
import type { Mailbox } from "../src/mail";

let errors: string[] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((x: unknown) => void errors.push(String(x)));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const named = (name: string, message = "x") => Object.assign(new Error(message), { name });

describe("classifyError", () => {
  it("recognises Gmail, model and sign-in failures", () => {
    expect(classifyError(new Error("Google token error: invalid_grant Token has been expired or revoked."))).toEqual({ type: "gmail_auth_expired", code: "invalid_grant" });
    expect(classifyError(new Error("Gmail API 404 on /messages/abc"))).toEqual({ type: "gmail_not_found", status: 404 });
    expect(classifyError(new Error("Gmail API 429 on /messages"))).toEqual({ type: "gmail_rate_limited", status: 429 });
    expect(classifyError(new Error("Gmail API 500 on /messages")).type).toBe("gmail_api");
    expect(classifyError(named("ThrottlingException")).type).toBe("model_throttled");
    expect(classifyError(new Error("unparseable model output")).type).toBe("model_unparseable");
    expect(classifyError(new Error("Sign-in failed: 400 invalid_client bad secret"))).toEqual({ type: "sign_in", status: 400, code: "invalid_client" });
    expect(classifyError(new Error("something else")).type).toBe("internal");
  });
});

describe("logError", () => {
  it("never writes the error's message, which could hold email details", () => {
    const secret = "Gmail API 404 on /messages/msg-secret-123 for jane@example.com";
    const ref = logError("tool_failed", new Error(secret), { tool: "read_email" });
    const line = errors.join();
    expect(line).toContain(ref);
    expect(line).toContain("gmail_not_found");
    expect(line).not.toContain("msg-secret-123");
    expect(line).not.toContain("jane@example.com");
  });

  it("tells the assistant what to do, without the error text", () => {
    expect(agentMessage("gmail_auth_expired", "r1")).toMatch(/reconnect/);
    expect(agentMessage("model_timeout", "r1")).toMatch(/no email was shared/);
    expect(agentMessage("internal", "r1")).toContain("r1");
  });
});

describe("failed requests", () => {
  const setup = (mailbox: Mailbox) => {
    const accounts = new TableAccounts(new MemoryTable(), randomKeyB64());
    const store = accounts.forUser("u1");
    const svc = new GatewayService(
      mailbox,
      { classifier: null, cache: store.labelCache(), policy: { withhold: new Set(["medical"]), threshold: 0.6, releasedMessages: new Set(), releasedSenders: new Set() } },
      store,
      { assistant: "gemini", clientId: null, userAgent: "t", headerNames: "" },
    );
    return { svc, store };
  };

  it("logs the type, gives a reference, and shows the failure in Activity without the error text", async () => {
    const broken: Mailbox = { search: async () => { throw new Error("Gmail API 500 on /messages/msg-secret"); }, get: async () => { throw new Error("no"); } };
    const { svc, store } = setup(broken);
    const r = await svc.searchEmail("flights", 5);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).not.toContain("msg-secret");
    const [run] = await store.recentRuns();
    expect(run).toMatchObject({ failure: "gmail_api", query: "flights", assistant: "gemini", shared_count: 0 });
    expect(run!.error_ref).toBeTruthy();
    expect(r.content[0]!.text).toContain(run!.error_ref!);
    expect(errors.join()).not.toContain("msg-secret");
  });

  it("records refusals too, and leaves working requests unmarked", async () => {
    const { svc, store } = setup(new FixtureMailbox());
    await svc.searchEmail("flight", 5);
    expect((await store.recentRuns())[0]!.failure).toBeNull();
  });
});

describe("assistants and guide", () => {
  it("labels the assistants we target", () => {
    expect(identifyAssistant(null, "Claude-User")).toBe("claude");
    expect(identifyAssistant("https://chatgpt.com/x", null)).toBe("chatgpt");
    expect(identifyAssistant(null, "Google-Gemini")).toBe("gemini");
    expect(identifyAssistant(null, "Perplexity-User")).toBe("perplexity");
    expect(identifyAssistant(null, "Muse-Code/1.0")).toBe("muse");
    expect(identifyAssistant(null, "museum-bot")).toBe("unknown");
    expect(identifyAssistant(null, "something-else")).toBe("unknown");
  });

  it("guides testers through every target assistant, and says which are untested", () => {
    const g = guidePage("https://x.example/mcp", "hi@x.example");
    for (const a of ["Claude", "ChatGPT", "Gemini", "Perplexity", "Muse"]) expect(g).toContain(a);
    expect(g).toContain("https://x.example/mcp");
    expect(g).toContain("Not tested yet");
    expect(g).toContain("hi@x.example");
  });

  it("shows a reconnect notice when the latest request couldn't reach Gmail", async () => {
    const accounts = new TableAccounts(new MemoryTable(), randomKeyB64());
    const app = createApp({
      config: { authkitDomain: "https://a.example", workosClientId: "x", workosApiKey: "x", googleClientId: "x", googleClientSecret: "x", sessionSecret: randomKeyB64(), withholdThreshold: 0.6, dev: true },
      accounts, cipher: { encrypt: async (x: string) => x, decrypt: async (x: string) => x }, classifier: null, devMailbox: () => new FixtureMailbox(),
    });
    const login = await app.handle(new Request("http://localhost:8787/dev-login", { method: "POST", headers: { origin: "http://localhost:8787" } }));
    const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
    await accounts.forUser("dev_user").recordFailure("1700000000000-a", { assistant: "claude", clientId: null, userAgent: "t", headerNames: "", tool: "search_email", query: "q" }, "gmail_unavailable", "ref123", new Date());
    const page = await (await app.handle(new Request("http://localhost:8787/activity", { headers: { cookie } }))).text();
    expect(page).toContain("can&#39;t reach Gmail".replace("&#39;", "'"));
    expect(page).toContain("reconnect");
  });
});
