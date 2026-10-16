// Scoring for the classifier evaluation. Pure functions, no AWS, so they can be unit-tested.

import { detect, type DetectorType, type Hit } from "../src/filter/detectors";
import { computeSignals, isCandidate, type Signals } from "../src/filter/signals";
import { fallbackLabel, ruleLabel, type Category, type Label } from "../src/filter/classifier";
import { decide, type Policy, type Verdict } from "../src/filter/engine";
import { senderDomain } from "../src/mail";

export interface EvalCase {
  id: string;
  tags: string[];
  expected: Category;
  from: string;
  subject: string;
  body: string;
  attachments?: { filename: string; text: string }[];
  redact?: DetectorType[];
}

/** What the engine computes before any model call, mirrored from src/filter/engine.ts. */
export interface Prepared {
  c: EvalCase;
  text: string;
  hits: Hit[];
  hitTypes: Set<DetectorType>;
  signals: Signals;
  rule: Label | null;
  candidate: boolean;
}

export function prepare(c: EvalCase): Prepared {
  // Mirrors the engine: attachment contents are never read, only their names.
  const atts = c.attachments ?? [];
  const names = atts.map((a) => a.filename);
  const text = `${c.subject}\n${c.body}${names.length ? `\n[Attachment names: ${names.join(", ")}]` : ""}`.slice(0, 20000);
  const hits = [...detect(c.subject), ...detect(c.body), ...names.flatMap((n) => detect(n))];
  const signals = computeSignals(senderDomain(c.from), text, hits);
  return {
    c,
    text,
    hits,
    hitTypes: new Set(hits.map((h) => h.type)),
    signals,
    rule: ruleLabel(signals),
    candidate: isCandidate(signals, atts.length > 0),
  };
}

export interface Outcome {
  id: string;
  tags: string[];
  expected: Category;
  /** Ground truth: should the gateway act on this email (withhold it, or redact its sensitive values)? */
  expectWithhold: boolean;
  /** The label the pipeline used (model, or fallback if the model failed / rules-only). */
  label: Label;
  /** Not shared unchanged: withheld whole, or (for sensitive items) redacted. Positive class of the benchmark. */
  withheld: boolean;
  verdict: Verdict;
  because: string[];
  model: Label | null;
  modelError: string | null;
  latencyMs: number | null;
}

/** Withhold if medical/financial, or if it contains any sensitive item we listed in the test case. */
export function expectWithhold(c: EvalCase): boolean {
  return c.expected !== "other" || (c.redact?.length ?? 0) > 0 || c.tags.includes("withhold");
}

export const DEFAULT_POLICY: Policy = {
  withhold: new Set(["medical", "financial"]),
  threshold: 0.6,
  releasedMessages: new Set(),
  releasedSenders: new Set(),
};

/** The gateway's decision for a prepared case, given the model's answer (or null). */
export function outcomeFor(p: Prepared, model: Label | null, modelError: string | null, latencyMs: number | null, threshold: number, rulesOnly = false): Outcome {
  const modelFailed = !rulesOnly && !model;
  const label = model ?? p.rule ?? fallbackLabel(p.signals);
  const { verdict, because } = decide({
    label,
    rule: p.rule,
    hits: p.hits,
    modelFailed,
    candidate: p.candidate,
    released: false,
    policy: { ...DEFAULT_POLICY, threshold },
  });
  return {
    id: p.c.id,
    tags: p.c.tags,
    expected: p.c.expected,
    expectWithhold: expectWithhold(p.c),
    label,
    withheld: verdict !== "share",
    verdict,
    because,
    model,
    modelError,
    latencyMs,
  };
}

export interface Scores {
  scored: number;
  /** Share of emails that should be withheld that were withheld. */
  recall: number;
  /** Share of withheld emails that should have been withheld. */
  precision: number;
  /** False positive rate: share of emails that should be shared that were withheld. */
  fpr: number;
  categoryAccuracy: number | null;
  tp: number;
  fn: number;
  fp: number;
  tn: number;
  falseNegatives: string[];
  falsePositives: string[];
}

/** Cases tagged "ambiguous" are excluded from scoring. */
export function score(outcomes: Outcome[]): Scores {
  const s = outcomes.filter((o) => !o.tags.includes("ambiguous"));
  const positives = s.filter((o) => o.expectWithhold);
  const negatives = s.filter((o) => !o.expectWithhold);
  const flagged = s.filter((o) => o.withheld);
  const categorised = s.filter((o) => o.model && !o.tags.includes("no-category"));
  return {
    scored: s.length,
    recall: positives.length ? positives.filter((o) => o.withheld).length / positives.length : 1,
    precision: flagged.length ? flagged.filter((o) => o.expectWithhold).length / flagged.length : 1,
    fpr: negatives.length ? negatives.filter((o) => o.withheld).length / negatives.length : 0,
    categoryAccuracy: categorised.length ? categorised.filter((o) => o.model!.category === o.expected).length / categorised.length : null,
    tp: positives.filter((o) => o.withheld).length,
    fn: positives.filter((o) => !o.withheld).length,
    fp: negatives.filter((o) => o.withheld).length,
    tn: negatives.filter((o) => !o.withheld).length,
    falseNegatives: positives.filter((o) => !o.withheld).map((o) => o.id),
    falsePositives: negatives.filter((o) => o.withheld).map((o) => o.id),
  };
}

export function accuracyByTag(outcomes: Outcome[]): Record<string, { n: number; correct: number }> {
  const out: Record<string, { n: number; correct: number }> = {};
  for (const o of outcomes) {
    if (o.tags.includes("ambiguous")) continue;
    for (const t of o.tags) {
      out[t] ??= { n: 0, correct: 0 };
      out[t].n++;
      if (o.withheld === o.expectWithhold) out[t].correct++;
    }
  }
  return out;
}

export function confusion(outcomes: Outcome[]): Record<Category, Record<Category, number>> {
  const cats: Category[] = ["medical", "financial", "other"];
  const m = Object.fromEntries(cats.map((a) => [a, Object.fromEntries(cats.map((b) => [b, 0]))])) as Record<
    Category,
    Record<Category, number>
  >;
  for (const o of outcomes) if (!o.tags.includes("ambiguous") && !o.tags.includes("no-category")) m[o.expected][o.label.category]++;
  return m;
}

/** Deterministic: did every required detector fire? Independent of the model. */
export function redactionCheck(prepared: Prepared[]): { required: number; found: number; misses: string[] } {
  let required = 0;
  let found = 0;
  const misses: string[] = [];
  for (const p of prepared) {
    for (const t of p.c.redact ?? []) {
      required++;
      if (p.hitTypes.has(t)) found++;
      else misses.push(`${p.c.id}:${t}`);
    }
  }
  return { required, found, misses };
}

/** 95% Wilson score interval for k successes out of n. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export function percentile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}
