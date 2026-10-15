import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayService } from "../src/service";
import { FixtureMailbox } from "../src/fixtures";
import { TableAccounts } from "../src/store/single-table";
import { MemoryTable } from "../src/store/table";
import { randomKeyB64 } from "../src/crypto";
import { dailyStats, runDailyStats } from "../src/stats";
import { newRunId } from "../src/store/types";

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((x: unknown) => void lines.push(String(x)));
});
afterEach(() => vi.restoreAllMocks());

const metricLines = () => lines.filter((l) => l.includes('"_aws"')).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("metrics", () => {
  it("records outcome, timings and decision mix, with no user, query or message details", async () => {
    const accounts = new TableAccounts(new MemoryTable(), randomKeyB64());
    const store = accounts.forUser("user_secret_42");
    const svc = new GatewayService(
      new FixtureMailbox(),
      { classifier: null, cache: store.labelCache(), policy: { withhold: new Set(["medical", "financial"]), threshold: 0.6, releasedMessages: new Set(), releasedSenders: new Set() } },
      store,
      { assistant: "claude", clientId: null, userAgent: "test", headerNames: "" },
    );
    await svc.searchEmail("statement lab order flight", 10);
    const ms = metricLines();
    expect(ms.find((m) => m.ToolCalls === 1)).toMatchObject({ Tool: "search_email", Outcome: "ok" });
    expect(ms.find((m) => "TotalMs" in m)).toMatchObject({ Tool: "search_email" });
    expect(ms.some((m) => m.Action === "withheld" && Number(m.Emails) >= 1)).toBe(true);
    expect(ms.some((m) => m.Reason === "medical")).toBe(true);
    const all = JSON.stringify(ms);
    for (const secret of ["user_secret_42", "statement lab order", "fx-lab", "fx-flight", "hospital", "@"]) expect(all).not.toContain(secret);
  });
});

describe("nightly totals", () => {
  it("counts the funnel, activity, retention and feedback, and saves only totals", async () => {
    const table = new MemoryTable();
    const accounts = new TableAccounts(table, randomKeyB64());
    const now = new Date("2026-10-15T02:00:00Z");
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000);
    await table.put({ pk: "USER#a", sk: "PROFILE", email: "a@x", createdAt: daysAgo(10).toISOString() });
    await table.put({ pk: "USER#b", sk: "PROFILE", email: "b@x", createdAt: daysAgo(0.5).toISOString() });
    await table.put({ pk: "USER#c", sk: "PROFILE", email: "c@x", createdAt: daysAgo(9).toISOString() });
    await table.put({ pk: "USER#a", sk: "GMAIL", gmail_address: "a@x" });
    await table.put({ pk: "USER#b", sk: "GMAIL", gmail_address: "b@x" });
    const meta = { assistant: "claude" as const, clientId: null, userAgent: "t", headerNames: "", tool: "search_email", query: "q" };
    const d = (id: string, action: "shared" | "withheld") => ({ messageId: id, senderDomain: "x", action, label: { category: "other" as const, confidence: 1, sensitive: [], reason: "", source: "rules" as const }, hits: [], because: action === "withheld" ? ["medical"] : [] });
    await accounts.forUser("a").recordRun(newRunId(daysAgo(0.2), "1"), meta, [d("m1", "shared"), d("m2", "withheld")], daysAgo(0.2));
    await accounts.forUser("a").feedback("m2", "release");
    const s = dailyStats(await table.scan(), now);
    expect(s).toMatchObject({ users_total: 3, users_new_1d: 1, gmail_connected: 2, used_from_assistant: 1, active_1d: 1, week2_cohort: 2, week2_retained: 1, searches_1d: 1, emails_1d: 2, withheld_1d: 1, claude_runs_1d: 1 });

    await runDailyStats(table, now);
    const saved = await table.get({ pk: "STATS", sk: "DAY#2026-10-15" });
    expect(saved?.users_total).toBe(3);
    expect(JSON.stringify(saved)).not.toMatch(/USER#|@x|m1|m2/);
    expect(metricLines().some((m) => m.Stat === "active_1d")).toBe(true);
  });
});

describe("leak reports", () => {
  it("keeps only the type, for 7 days, and doesn't change releases", async () => {
    const table = new MemoryTable();
    const store = new TableAccounts(table, randomKeyB64()).forUser("u1");
    await store.feedback("m9", "leak", "home_address");
    const row = await table.get({ pk: "USER#u1", sk: "FEEDBACK#m9" });
    expect(row).toMatchObject({ decision: "leak", item: "home_address" });
    expect(typeof row?.expiresAt).toBe("number");
    expect(await table.get({ pk: "USER#u1", sk: "RELEASE#message#m9" })).toBeNull();
  });
});
