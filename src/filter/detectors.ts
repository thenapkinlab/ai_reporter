// Layer 1: deterministic detectors for values that should never reach an assistant.
// Checksums (Luhn, IBAN mod-97, Verhoeff) keep false positives down.

export type DetectorType =
  | "card_number"
  | "iban"
  | "account_number"
  | "us_ssn"
  | "aadhaar"
  | "passport_mrz"
  | "api_key"
  | "password"
  | "otp";

export interface Hit {
  type: DetectorType;
  start: number;
  end: number;
  /** Masked form safe to store and show, e.g. "••••1111". */
  masked: string;
}

export const DETECTOR_LABELS: Record<DetectorType, string> = {
  card_number: "card number",
  iban: "IBAN",
  account_number: "account number",
  us_ssn: "SSN",
  aadhaar: "Aadhaar number",
  passport_mrz: "passport data",
  api_key: "API key",
  password: "password",
  otp: "one-time code",
};

export function mask(value: string): string {
  const v = value.replace(/\s+/g, "");
  if (v.length <= 4) return "•".repeat(v.length);
  return "••••" + v.slice(-4);
}

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function ibanValid(iban: string): boolean {
  const s = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of s) {
    const code = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of code) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeff(digits: string): boolean {
  let c = 0;
  const rev = digits.split("").reverse();
  for (let i = 0; i < rev.length; i++) c = VD[c]![VP[i % 8]![Number(rev[i])]!]!;
  return c === 0;
}

interface Rule {
  type: DetectorType;
  re: RegExp;
  /** Which capture group holds the sensitive value (0 = whole match). */
  group?: number;
  check?: (value: string) => boolean;
}

const RULES: Rule[] = [
  {
    type: "card_number",
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    check: (v) => {
      const d = v.replace(/\D/g, "");
      return d.length >= 13 && d.length <= 19 && new Set(d).size > 1 && luhn(d);
    },
  },
  {
    type: "iban",
    re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
    check: (v) => {
      const c = v.replace(/ /g, "");
      return c.length >= 15 && c.length <= 34 && ibanValid(c);
    },
  },
  {
    type: "account_number",
    re: /\b(?:a\/c|acct|account)(?:\s*(?:no\.?|number|#))?\s*[:#]?\s*((?:[X*•x]{2,}\s?)?\d[\d -]{5,20}\d)/gi,
    group: 1,
  },
  { type: "us_ssn", re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { type: "aadhaar", re: /\b[2-9]\d{3} \d{4} \d{4}\b/g, check: (v) => verhoeff(v.replace(/\D/g, "")) },
  {
    type: "passport_mrz",
    re: /^(?:P<[A-Z<]{3}[A-Z<]{20,}|[A-Z0-9<]{9}\d[A-Z<]{3}\d{6}\d[MF<]\d{6}\d[A-Z0-9<]{10,})$/gm,
  },
  {
    type: "api_key",
    re: /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g,
  },
  { type: "password", re: /\b(?:password|passwd|pwd|passcode|pin)\b\s*[:=]\s*(\S+)/gi, group: 1 },
  {
    type: "otp",
    re: /\b(?:code|otp|verification code|passcode|one[- ]time)\b[^0-9\n]{0,30}\b(\d{4,8})\b/gi,
    group: 1,
  },
];

export function detect(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const g = rule.group ?? 0;
      const value = m[g];
      if (value === undefined || m.index === undefined) continue;
      if (rule.check && !rule.check(value)) continue;
      const offset = g === 0 ? 0 : m[0].indexOf(value);
      const start = m.index + offset;
      hits.push({ type: rule.type, start, end: start + value.length, masked: mask(value) });
    }
  }
  return dedupe(hits);
}

/** Drops hits fully contained in an earlier, longer hit (e.g. digits inside a card). */
function dedupe(hits: Hit[]): Hit[] {
  const sorted = [...hits].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Hit[] = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    if (last && h.start >= last.start && h.end <= last.end) continue;
    out.push(h);
  }
  return out;
}

/** Replaces each hit with "[REDACTED: label]". */
export function redact(text: string, hits: Hit[]): string {
  if (hits.length === 0) return text;
  let out = "";
  let pos = 0;
  for (const h of [...hits].sort((a, b) => a.start - b.start)) {
    if (h.start < pos) continue;
    out += text.slice(pos, h.start) + `[REDACTED: ${DETECTOR_LABELS[h.type]}]`;
    pos = h.end;
  }
  return out + text.slice(pos);
}
