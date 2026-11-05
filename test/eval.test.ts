// Checks the evaluation set and scoring offline (rules only, no AWS).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { outcomeFor, prepare, redactionCheck, score, type EvalCase } from "../eval/score";
import { caseInput, caseOutput, runTotals } from "../eval/langfuse";
import type { Label } from "../src/filter/classifier";

const cases = (JSON.parse(readFileSync(new URL("../eval/dataset.json", import.meta.url), "utf8")) as { cases: EvalCase[] }).cases;

describe("evaluation set", () => {
  it("has unique ids and valid labels", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) expect(["medical", "financial", "other"]).toContain(c.expected);
    expect(cases.length).toBeGreaterThanOrEqual(80);
  });

  it("covers every case type", () => {
    const tags = new Set(cases.flatMap((c) => c.tags));
    for (const t of ["clear", "hard-positive", "hard-negative", "adversarial", "redaction", "mixed", "attachment-only"]) {
      expect(tags.has(t)).toBe(true);
    }
  });

  it("withholds every case with a pattern-detectable value, even without a model", () => {
    const outcomes = cases.filter((c) => c.redact?.length).map((c) => outcomeFor(prepare(c), null, null, null, 0.6, true));
    expect(outcomes.filter((o) => !o.withheld).map((o) => o.id)).toEqual([]);
  });

  it("finds every required redaction with the detectors alone", () => {
    const r = redactionCheck(cases.map(prepare));
    expect(r.misses).toEqual([]);
  });
});

describe("scoring", () => {
  it("computes recall and precision from pipeline labels", () => {
    const outcomes = cases.map((c) => outcomeFor(prepare(c), null, null, null, 0.6, true));
    const s = score(outcomes);
    expect(s.recall).toBeGreaterThanOrEqual(0);
    expect(s.recall).toBeLessThanOrEqual(1);
    expect(s.scored).toBe(cases.filter((c) => !c.tags.includes("ambiguous")).length);
  });
});

describe("Langfuse upload limits", () => {
  const prep = (tags: string[]) => prepare({ id: "x", tags, expected: "other", from: "a@b.example", subject: "SECRET-SUBJECT", body: "SECRET-BODY" });
  const outcome = (p: ReturnType<typeof prep>) =>
    outcomeFor(p, { category: "other", confidence: 0.9, sensitive: [], reason: "SECRET-REASON", source: "model", values: [{ item: "home_address", text: "SECRET-VALUE" }] } as Label, null, 1, 0.6);

  it("leaves email text, reasons and values out of every record, whatever the source", () => {
    for (const tags of [["clear"], ["external", "source:gretel"], ["external", "source:mtsamples"]]) {
      const p = prep(tags);
      expect(JSON.stringify([caseInput(p), caseOutput(outcome(p))])).not.toContain("SECRET");
    }
    const totals = runTotals({ name: "m", inputTokens: 1, outputTokens: 1, failures: 0, retries: 0 }, [outcome(prep(["clear"]))]);
    expect(Object.values(totals).every((v) => v === null || typeof v === "number")).toBe(true);
  });

  it("stays out of the gateway: no imports in src/, dev dependency only", () => {
    const files = readdirSync("src", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join("src", f), "utf8")).not.toMatch(/from "@?(langfuse|opentelemetry)/i);
    const { dependencies } = JSON.parse(readFileSync("package.json", "utf8"));
    expect(Object.keys(dependencies).filter((d) => /langfuse|opentelemetry/.test(d))).toEqual([]);
  });
});
