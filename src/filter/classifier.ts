// Layer 3: decides whether an email as a whole is medical, financial or other.
// Obvious cases are settled by rules; the rest go to a small model (Bedrock, src/aws/bedrock.ts).

import type { Signals } from "./signals";

export type Category = "medical" | "financial" | "other";

export interface Label {
  category: Category;
  confidence: number;
  reason: string;
  source: "rules" | "model" | "fallback";
}

export interface ClassifyInput {
  from: string;
  subject: string;
  /** Body plus converted attachment text, already truncated. */
  text: string;
}

export interface Classifier {
  classify(input: ClassifyInput): Promise<Label>;
}

/** Settles clear-cut cases without the model; returns null when the model should decide. */
export function ruleLabel(s: Signals, candidate: boolean): Label | null {
  if (!candidate) return { category: "other", confidence: 0.9, reason: "no medical or financial signals", source: "rules" };
  if (s.medicalDomain && s.medical >= 1 && s.financial === 0)
    return { category: "medical", confidence: 0.9, reason: s.reasons.slice(0, 2).join("; "), source: "rules" };
  if (s.financialDomain && s.financial >= 1 && s.medical === 0)
    return { category: "financial", confidence: 0.9, reason: s.reasons.slice(0, 2).join("; "), source: "rules" };
  return null;
}

/** Used when the model is unavailable or returns something unusable. */
export function fallbackLabel(s: Signals): Label {
  const fin = s.financial + (s.financialDomain ? 2 : 0);
  const med = s.medical + (s.medicalDomain ? 2 : 0);
  if (fin === 0 && med === 0) return { category: "other", confidence: 0.6, reason: "no strong signals", source: "fallback" };
  const category: Category = fin >= med ? "financial" : "medical";
  const score = Math.max(fin, med);
  const confidence = Math.min(0.85, 0.45 + 0.1 * score);
  return { category, confidence, reason: s.reasons.slice(0, 2).join("; "), source: "fallback" };
}

export const CLASSIFIER_PROMPT = `You label emails for a privacy filter. Reply with JSON only:
{"category":"medical"|"financial"|"other","confidence":0.0-1.0,"reason":"<= 12 words, no personal details"}
medical: lab or test results, prescriptions, diagnoses, doctor or clinic letters, health insurance claims.
financial: bank or card statements, account alerts, tax documents, payslips, loans, investments.
other: everything else, including shopping receipts, order confirmations, newsletters, marketing, travel.
Marketing or newsletters about health or money are "other".`;

export function parseModelLabel(raw: unknown): Label | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const category = String(o.category ?? "").toLowerCase();
  if (category !== "medical" && category !== "financial" && category !== "other") return null;
  const confidence = Number(o.confidence);
  if (!Number.isFinite(confidence)) return null;
  const reason = String(o.reason ?? "").slice(0, 120);
  return { category, confidence: Math.max(0, Math.min(1, confidence)), reason, source: "model" };
}
