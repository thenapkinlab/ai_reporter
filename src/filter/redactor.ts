// Removes sensitive values from an email before an assistant sees it. Values come from two
// places: the pattern detectors (exact positions) and the model (text it copied from the email).
// The model never rewrites the email: we find its values in the original text ourselves and
// replace them, so everything else stays byte-for-byte the same. A model value we can't find
// is reported as missing, and the engine then withholds the whole email (fail closed).

import { detect } from "./detectors";
import { DETECTOR_ITEM, ITEM_LABELS, type RemoveValue, type SensitiveItem } from "./classifier";

export const placeholder = (item: SensitiveItem) => `[removed: ${ITEM_LABELS[item]}]`;

interface Span {
  start: number;
  end: number;
  item: SensitiveItem;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches a copied value even if the model changed line breaks, spacing, commas or case. */
export function valuePattern(value: string): RegExp | null {
  const tokens = value.split(/[\s,]+/).filter(Boolean).map(escapeRe);
  if (!tokens.length) return null;
  return new RegExp(tokens.join("[\\s,]+"), "giu");
}

export function findValue(text: string, value: string): { start: number; end: number }[] {
  const re = valuePattern(value);
  if (!re) return [];
  return [...text.matchAll(re)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
}

function spansIn(text: string, values: RemoveValue[]): Span[] {
  const spans: Span[] = detect(text).map((h) => ({ start: h.start, end: h.end, item: DETECTOR_ITEM[h.type] }));
  for (const v of values) for (const m of findValue(text, v.text)) spans.push({ ...m, item: v.item });
  return spans;
}

/** Replaces each span (merged where they overlap) with its placeholder. */
function apply(text: string, spans: Span[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let pos = 0;
  let open: Span | null = null;
  for (const s of sorted) {
    if (open && s.start < open.end) {
      open.end = Math.max(open.end, s.end);
      continue;
    }
    if (open) {
      out += placeholder(open.item);
      pos = open.end;
    }
    out += text.slice(pos, s.start);
    open = { ...s };
  }
  if (open) {
    out += placeholder(open.item);
    pos = open.end;
  }
  return out + text.slice(pos);
}

export function redactText(text: string, values: RemoveValue[]): string {
  return apply(text, spansIn(text, values));
}

export interface RedactInput {
  subject: string;
  body: string;
  /** Converted attachment text. Attachment contents are never returned, but model values may come from there. */
  attachmentText: string;
  values: RemoveValue[];
}

export interface Redacted {
  subject: string;
  body: string;
  /** A fresh snippet from the redacted body (Gmail's own snippet could cut a value in half). */
  snippet: string;
  /** Model values found nowhere in the email: the engine withholds the email when this isn't empty. */
  missing: RemoveValue[];
  /** How many values were replaced in the subject and body. */
  removed: number;
}

export function redactEmail(i: RedactInput): Redacted {
  const missing = i.values.filter(
    (v) => !findValue(i.subject, v.text).length && !findValue(i.body, v.text).length && !findValue(i.attachmentText, v.text).length,
  );
  const subjectSpans = spansIn(i.subject, i.values);
  const bodySpans = spansIn(i.body, i.values);
  const body = apply(i.body, bodySpans);
  return {
    subject: apply(i.subject, subjectSpans),
    body,
    snippet: body.replace(/\s+/g, " ").trim().slice(0, 200),
    missing,
    removed: subjectSpans.length + bodySpans.length,
  };
}
