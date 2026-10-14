import { describe, expect, it } from "vitest";
import { TableAccounts } from "../src/store/single-table";
import { MemoryTable } from "../src/store/table";
import { randomKeyB64 } from "../src/crypto";
import { inferRunType, newRunId, type RunMeta } from "../src/store/types";
import type { Decision } from "../src/filter/engine";

const meta = (query: string): RunMeta => ({
  assistant: "claude",
  clientId: null,
  userAgent: "test",
  headerNames: "",
  tool: "search_email",
  query,
});

function decision(id: string, action: Decision["action"], category: "medical" | "financial" | "other" = "other"): Decision {
  const card = category === "other" && action === "withheld";
  return {
    messageId: id,
    senderDomain: "example.com",
    action,
    label: { category, confidence: 0.9, sensitive: [], reason: "test", source: "rules" },
    hits: card ? [{ type: "card_number", start: 0, end: 4, masked: "••••1111" }] : [],
    because: action === "withheld" ? [card ? "card number" : category] : [],
    unscannedAttachments: [],
  };
}

const KEY = randomKeyB64();

describe("single-table store", () => {
  it("keys the classifier cache by a hash, never the raw message ID", async () => {
    const table = new MemoryTable();
    const cache = new TableAccounts(table, KEY).forUser("u1").labelCache();
    await cache.put("msg-123", { category: "medical", confidence: 0.9, sensitive: [], reason: "secret reason", source: "model" });
    const rows = await table.query("USER#u1", { prefix: "LABEL#" });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("msg-123");
    expect(JSON.stringify(rows)).not.toContain("secret reason");
    expect((await cache.get("msg-123"))?.category).toBe("medical");
    expect(await new TableAccounts(table, randomKeyB64()).forUser("u1").labelCache().get("msg-123")).toBeNull();
  });

  it("records runs, lists them newest first, and totals them", async () => {
    const accounts = new TableAccounts(new MemoryTable(), KEY);
    const store = accounts.forUser("u1");
    const t1 = new Date("2026-10-07T07:00:00Z");
    const t2 = new Date("2026-10-07T09:30:00Z");
    await store.recordRun(newRunId(t1, "a"), meta("bank"), [decision("m1", "withheld", "financial"), decision("m2", "shared")], t1);
    await store.recordRun(newRunId(t2, "b"), meta("flights"), [decision("m3", "withheld")], t2);

    const runs = await store.recentRuns();
    expect(runs.map((r) => r.query)).toEqual(["flights", "bank"]);
    expect(await store.totals(7, new Date("2026-10-07T10:00:00Z"))).toMatchObject({ read: 3, withheld: 2, background: 0, byReason: { financial: 1, "card number": 1 }, byAssistant: { claude: 3 } });

    const detail = await store.run(runs[1]!.id);
    expect(detail?.items.map((i) => i.action)).toEqual(["withheld", "shared"]);
  });

  it("keeps users apart", async () => {
    const accounts = new TableAccounts(new MemoryTable(), KEY);
    const now = new Date();
    const runId = newRunId(now, "x");
    await accounts.forUser("alice").recordRun(runId, meta("q"), [decision("m1", "shared")], now);
    expect(await accounts.forUser("bob").recentRuns()).toEqual([]);
    expect(await accounts.forUser("bob").run(runId)).toBeNull();
  });

  it("marks a repeat at an hourly rhythm as background", async () => {
    const accounts = new TableAccounts(new MemoryTable(), KEY);
    const store = accounts.forUser("u1");
    const t1 = new Date("2026-10-06T07:00:00Z");
    const t2 = new Date("2026-10-07T07:02:00Z");
    await store.recordRun(newRunId(t1, "a"), meta("daily digest"), [], t1);
    await store.recordRun(newRunId(t2, "b"), meta("daily digest"), [], t2);
    const [latest] = await store.recentRuns();
    expect(latest?.run_type).toBe("background_likely");
  });

  it("turns a release into a policy exception, and keep undoes it", async () => {
    const store = new TableAccounts(new MemoryTable(), KEY).forUser("u1");
    await store.feedback("m1", "release");
    expect((await store.policy(0.6)).releasedMessages.has("m1")).toBe(true);
    await store.feedback("m1", "keep");
    expect((await store.policy(0.6)).releasedMessages.has("m1")).toBe(false);
  });

  it("saves settings and deletes everything for a user", async () => {
    const table = new MemoryTable();
    const accounts = new TableAccounts(table, KEY);
    await accounts.upsertUser("u1", "a@example.com");
    await accounts.saveGmail("u1", "a@gmail.com", "cipher", "scope");
    const store = accounts.forUser("u1");
    await store.saveSettings(false, true);
    expect([...(await store.policy(0.6)).withhold]).toEqual(["financial"]);
    await store.deleteAll();
    expect(await table.query("USER#u1")).toEqual([]);
    expect(await accounts.getGmail("u1")).toBeNull();
  });
});

describe("inferRunType", () => {
  const now = new Date("2026-10-07T07:01:00Z");
  it("needs the same query", () => expect(inferRunType(null, [new Date("2026-10-06T07:00:00Z")], now)).toBe("unknown"));
  it("ignores irregular gaps", () => expect(inferRunType("q", [new Date("2026-10-07T06:31:00Z")], now)).toBe("unknown"));
  it("accepts whole hours", () => expect(inferRunType("q", [new Date("2026-10-07T04:00:00Z")], now)).toBe("background_likely"));
});
