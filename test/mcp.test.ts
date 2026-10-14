import { describe, expect, it } from "vitest";
import { handleMcp, TOOLS } from "../src/mcp";
import { GatewayService } from "../src/service";
import { FixtureMailbox } from "../src/fixtures";
import type { Label } from "../src/filter/classifier";
import type { Decision } from "../src/filter/engine";
import type { UserStore } from "../src/store/types";

function fakeStore() {
  const runs: { tool: string; query: string | null; decisions: Decision[] }[] = [];
  const cache = new Map<string, Label>();
  const store = {
    recordRun: async (_id: string, meta: { tool: string; query: string | null }, decisions: Decision[]) => {
      runs.push({ tool: meta.tool, query: meta.query, decisions });
    },
    labelCache: () => ({ get: async (id: string) => cache.get(id) ?? null, put: async (id: string, l: Label) => void cache.set(id, l) }),
  } as unknown as UserStore;
  return { store, runs };
}

function service() {
  const { store, runs } = fakeStore();
  const svc = new GatewayService(
    new FixtureMailbox(),
    {
      classifier: null,
      extractText: async () => null,
      cache: store.labelCache(),
      policy: { withhold: new Set(["medical", "financial"]), threshold: 0.6, releasedMessages: new Set(), releasedSenders: new Set() },
    },
    store,
    { assistant: "claude", clientId: null, userAgent: "test", headerNames: "" },
  );
  return { svc, runs };
}

const rpc = (body: unknown) =>
  new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("MCP endpoint", () => {
  it("negotiates the protocol version", async () => {
    const { svc } = service();
    const res = await handleMcp(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }), svc);
    const body = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    const newer = await handleMcp(rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } }), svc);
    expect(((await newer.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-11-25");
  });

  it("acknowledges notifications with 202 and rejects GET", async () => {
    const { svc } = service();
    expect((await handleMcp(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }), svc)).status).toBe(202);
    expect((await handleMcp(new Request("http://localhost/mcp"), svc)).status).toBe(405);
  });

  it("lists two read-only tools with explicit annotations", async () => {
    const { svc } = service();
    const res = await handleMcp(rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }), svc);
    const tools = ((await res.json()) as { result: { tools: typeof TOOLS } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(["search_email", "read_email"]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
  });

  it("filters search results and records the run", async () => {
    const { svc, runs } = service();
    const res = await handleMcp(
      rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_email", arguments: { query: "statement lab order flight" } } }),
      svc,
    );
    const out = ((await res.json()) as { result: { structuredContent: { results: { id: string; snippet: string }[]; filter_note: string } } })
      .result.structuredContent;
    const ids = out.results.map((r) => r.id);
    expect(ids).not.toContain("fx-lab");
    expect(ids).not.toContain("fx-statement");
    expect(ids).toContain("fx-card-receipt"); // shared with the card number removed
    expect(ids).toContain("fx-flight");
    expect(JSON.stringify(out)).not.toContain("4111");
    expect(out.filter_note).toMatch(/withheld/);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.query).toBe("statement lab order flight");
  });

  it("returns a notice instead of content for a withheld email", async () => {
    const { svc } = service();
    const res = await handleMcp(
      rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_email", arguments: { message_id: "fx-lab" } } }),
      svc,
    );
    const text = JSON.stringify(await res.json());
    expect(text).toContain("withheld");
    expect(text).not.toContain("Glucose");
  });

  it("reports bad arguments as tool errors, not protocol errors", async () => {
    const { svc } = service();
    const res = await handleMcp(rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "read_email", arguments: {} } }), svc);
    expect(((await res.json()) as { result: { isError: boolean } }).result.isError).toBe(true);
  });
});
