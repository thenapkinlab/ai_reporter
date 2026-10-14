import { describe, expect, it } from "vitest";
import { RateLimitedClassifier } from "../src/limits";
import { ModelBusyError, type Classifier } from "../src/filter/classifier";
import { TableAccounts } from "../src/store/single-table";
import { MemoryTable } from "../src/store/table";
import { randomKeyB64 } from "../src/crypto";
import { DEFAULT_LIMITS } from "../src/config";

const ok: Classifier = {
  classify: async () => ({ category: "other", confidence: 0.9, sensitive: [], reason: "", source: "model" }),
  classifyBatch: async (xs) => xs.map(() => ({ category: "other", confidence: 0.9, sensitive: [], reason: "", source: "model" })),
};

describe("per-user email budget", () => {
  it("allows up to the limit, per 10 minutes and per day, counting only numbers", async () => {
    const table = new MemoryTable();
    const store = new TableAccounts(table, randomKeyB64()).forUser("u1");
    const limits = { ...DEFAULT_LIMITS, emailsPer10Min: 10, emailsPerDay: 15 };
    const t = new Date("2026-10-15T09:01:00Z");
    expect((await store.reserveEmails(8, limits, t)).allowed).toBe(8);
    const r = await store.reserveEmails(5, limits, t);
    expect(r).toMatchObject({ allowed: 2, limitedBy: "10 minutes", usedToday: 10 });
    expect(r.resetsAt?.toISOString()).toBe("2026-10-15T09:10:00.000Z");
    // Next window: the daily limit (15) applies.
    const later = new Date("2026-10-15T09:12:00Z");
    expect(await store.reserveEmails(10, limits, later)).toMatchObject({ allowed: 5, limitedBy: "day" });
    expect((await store.reserveEmails(1, limits, later)).resetsAt?.toISOString()).toBe("2026-10-16T00:00:00.000Z");
    expect(await store.usageToday(later)).toBe(15);
    const rows = await table.query("USER#u1", { prefix: "USAGE#" });
    expect(rows.every((x) => typeof x.expiresAt === "number")).toBe(true);
  });
});

describe("shared model budget", () => {
  it("waits for the next minute when full, and reports busy if it would wait too long", async () => {
    const counts = new Map<number, number>();
    const count = async (m: number) => {
      counts.set(m, (counts.get(m) ?? 0) + 1);
      return counts.get(m)!;
    };
    let now = 10 * 60000 + 50000; // 50 s into a minute
    const waits: number[] = [];
    const rl = new RateLimitedClassifier(ok, count, 2, 20000, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    await rl.classifyBatch([]);
    await rl.classifyBatch([]);
    await rl.classifyBatch([]); // third in the same minute: waits ~10 s for the next one
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeLessThanOrEqual(10050);

    now = 20 * 60000 + 5000; // 5 s into a minute, already full below
    counts.set(20, 2);
    await expect(rl.classify({ from: "", subject: "", text: "" })).rejects.toBeInstanceOf(ModelBusyError);
  });
});
