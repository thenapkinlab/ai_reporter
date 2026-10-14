// Checks the evaluation set and scoring offline (rules only, no AWS).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { outcomeFor, prepare, redactionCheck, score, type EvalCase } from "../eval/score";

const cases = (JSON.parse(readFileSync(new URL("../eval/dataset.json", import.meta.url), "utf8")) as { cases: EvalCase[] }).cases;

describe("evaluation set", () => {
  it("has unique ids and valid labels", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) expect(["medical", "financial", "other"]).toContain(c.expected);
    expect(cases.length).toBeGreaterThanOrEqual(80);
  });

  it("covers every case type", () => {
    const tags = new Set(cases.flatMap((c) => c.tags));
    for (const t of ["clear", "hard-positive", "hard-negative", "adversarial", "redaction", "mixed", "attachment"]) {
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
