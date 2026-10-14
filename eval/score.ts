// Scoring for the classifier evaluation. Pure functions, no AWS, so they can be unit-tested.

import { detect, type DetectorType } from "../src/filter/detectors";
import { computeSignals, isCandidate, type Signals } from "../src/filter/signals";
import { fallbackLabel, ruleLabel, type Category, type Label } from "../src/filter/classifier";
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
  hitTypes: Set<DetectorType>;
  signals: Signals;
  rule: Label | null;
}

export function prepare(c: EvalCase): Prepared {
  const atts = c.attachments ?? [];
  const attachmentText = atts.map((a) => `\n[Attachment: ${a.filename}]\n${a.text}`).join("");
  const text = `${c.subject}\n${c.body}${attachmentText}`.slice(0, 20000);
  const hits = [...detect(c.subject), ...detect(c.body), ...atts.flatMap((a) => detect(a.text))];
  const signals = computeSignals(senderDomain(c.from), text, hits);
  return {
    c,
    text,
    hitTypes: new Set(hits.map((h) => h.type)),
    signals,
    rule: ruleLabel(signals, isCandidate(signals, atts.length > 0)),
  };
}

export interface Outcome {
  id: string;
  tags: string[];
  expected: Category;
  /** What the deployed pipeline would decide: rules first, model for unclear cases, fallback on failure. */
  pipeline: Label;
  /** The model's own answer on every email (null for rules-only or on failure). */
  model: Label | null;
  modelError: string | null;
  latencyMs: number | null;
}

export function pipelineLabel(p: Prepared, model: Label | null): Label {
  return p.rule ?? model ?? fallbackLabel(p.signals);
}

/**
 * Candidate design: rules may only settle clear *positives*; every other email goes to the model.
 * The current engine also lets rules declare "other" without a model call, which misses
 * sensitive emails that have no keywords, use other languages, or hide content in attachments.
 */
export function pipelineLabelModelOnAll(p: Prepared, model: Label | null): Label {
  if (p.rule && p.rule.category !== "other") return p.rule;
  return model ?? fallbackLabel(p.signals);
}

const withheld = (l: Label, t: number) => l.category !== "other" && l.confidence >= t;

export interface Scores {
  scored: number;
  recall: number;
  precision: number;
  pipelineAccuracy: number;
  modelAccuracy: number | null;
  missed: string[];
  falseAlarms: string[];
}

/** Protection scores at a withhold threshold. Cases tagged "ambiguous" are excluded. */
export function score(outcomes: Outcome[], threshold: number): Scores {
  const s = outcomes.filter((o) => !o.tags.includes("ambiguous"));
  const positives = s.filter((o) => o.expected !== "other");
  const caught = positives.filter((o) => withheld(o.pipeline, threshold));
  const flagged = s.filter((o) => withheld(o.pipeline, threshold));
  const modelled = s.filter((o) => o.model);
  return {
    scored: s.length,
    recall: positives.length ? caught.length / positives.length : 1,
    precision: flagged.length ? flagged.filter((o) => o.expected !== "other").length / flagged.length : 1,
    pipelineAccuracy: s.filter((o) => o.pipeline.category === o.expected).length / (s.length || 1),
    modelAccuracy: modelled.length ? modelled.filter((o) => o.model!.category === o.expected).length / modelled.length : null,
    missed: positives.filter((o) => !withheld(o.pipeline, threshold)).map((o) => o.id),
    falseAlarms: flagged.filter((o) => o.expected === "other").map((o) => o.id),
  };
}

export function accuracyByTag(outcomes: Outcome[]): Record<string, { n: number; correct: number }> {
  const out: Record<string, { n: number; correct: number }> = {};
  for (const o of outcomes) {
    if (o.tags.includes("ambiguous")) continue;
    for (const t of o.tags) {
      out[t] ??= { n: 0, correct: 0 };
      out[t].n++;
      if (o.pipeline.category === o.expected) out[t].correct++;
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
  for (const o of outcomes) if (!o.tags.includes("ambiguous")) m[o.expected][o.pipeline.category]++;
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

export function percentile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}
