import { describe, expect, it, vi } from "vitest";
import { GatewayService } from "../src/service";
import { FixtureMailbox } from "../src/fixtures";
import { TableAccounts } from "../src/store/single-table";
import { MemoryTable } from "../src/store/table";
import { randomKeyB64 } from "../src/crypto";
import { createTracer, traceBody, traceFields, type ToolTrace } from "../src/trace";
import type { Decision } from "../src/filter/engine";

const keys = { publicKey: "pk", secretKey: "sk", baseUrl: "https://langfuse.test" };

function service(send: typeof fetch, mailbox = new FixtureMailbox()) {
  const store = new TableAccounts(new MemoryTable(), randomKeyB64()).forUser("user_secret_42");
  return new GatewayService(
    mailbox,
    { classifier: null, cache: store.labelCache(), policy: { withhold: new Set(["medical", "financial"]), threshold: 0.6, releasedMessages: new Set(), releasedSenders: new Set() } },
    store,
    { assistant: "gemini", clientId: "client_secret_7", userAgent: "agent-secret", headerNames: "" },
    undefined,
    undefined,
    createTracer(keys, send),
  );
}

describe("Langfuse technical log", () => {
  it("sends one record of counts and fixed labels for a real tool call, with no content or identity", async () => {
    const send = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const mailbox = new FixtureMailbox();
    const page = await mailbox.search("statement lab order flight", 10);
    const emails = await Promise.all(page.ids.map((id) => mailbox.get(id)));
    await service(send).searchEmail("statement lab order flight", 10);

    expect(send).toHaveBeenCalledTimes(1);
    const body = String(vi.mocked(send).mock.calls[0]![1]!.body);
    expect(body).toContain("search_email");
    expect(body).toContain("gemini");
    expect(body).toContain("medical");
    expect(emails.length).toBeGreaterThan(0);
    const secrets = ["user_secret_42", "client_secret_7", "agent-secret", "statement lab order", "@"];
    for (const e of emails) secrets.push(e.id, e.from, e.subject, e.snippet.slice(0, 30));
    for (const s of secrets.filter(Boolean)) expect(body).not.toContain(s);
  });

  it("drops or relabels anything outside the fixed lists", () => {
    const leak = "patient jane@example.com";
    const t = {
      tool: leak,
      outcome: leak,
      assistant: leak,
      errorType: leak,
      errorRef: leak,
      decisions: [{ action: "withheld", because: [leak, "medical"] } as unknown as Decision],
    } as unknown as ToolTrace;
    expect(traceBody(t)).not.toContain("jane");
    expect(traceFields(t)).toMatchObject({ tool: "unknown", outcome: "unknown", assistant: "unknown", reasons: { other: 1, medical: 1 } });
  });

  it("sends nothing without keys", async () => {
    const send = vi.fn() as unknown as typeof fetch;
    await createTracer(undefined, send)({ tool: "search_email", outcome: "ok", assistant: "claude" });
    expect(send).not.toHaveBeenCalled();
  });

  it("never affects the user's request when Langfuse is down", async () => {
    const send = vi.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch;
    const out = await service(send).searchEmail("flight", 10);
    expect(out.isError).toBeFalsy();
  });
});
