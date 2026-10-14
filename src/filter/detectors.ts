// Layer 1: deterministic detectors for values that should never reach an assistant.
// Checksums (Luhn, IBAN mod-97, Verhoeff) keep false positives down. Values without a checksum
// are only matched right after a label ("Passwort:", "date of birth", "routing number"), in the
// seven languages we test. Values with no label (CSV columns, EDI fields) are left to the model.

export type DetectorType =
  | "card_number"
  | "iban"
  | "account_number"
  | "routing_number"
  | "card_security_code"
  | "us_ssn"
  | "aadhaar"
  | "se_personnummer"
  | "in_pan"
  | "it_codice_fiscale"
  | "id_number"
  | "passport_mrz"
  | "date_of_birth"
  | "api_key"
  | "secret"
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
  routing_number: "routing or sort code",
  card_security_code: "card security code",
  us_ssn: "SSN",
  aadhaar: "Aadhaar number",
  se_personnummer: "personnummer",
  in_pan: "PAN",
  it_codice_fiscale: "codice fiscale",
  id_number: "ID number",
  passport_mrz: "passport data",
  date_of_birth: "date of birth",
  api_key: "API key",
  secret: "secret key or token",
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

/** Cards are written unbroken, in fours, or 4-6-5 / 4-6-4 (Amex, Diners), not like "112-3344556-7788990" order numbers. */
function cardGrouping(v: string): boolean {
  const g = v.split(/[ -]/).map((x) => x.length);
  if (g.length === 1) return true;
  return g.slice(0, -1).every((n) => n === 4) || /^4,6,[45]$/.test(g.join(","));
}

/** Swedish personnummer: YYMMDD-NNNN (or YYYYMMDD-NNNN), a real date, Luhn over the last 10 digits. */
function personnummerValid(v: string): boolean {
  const d = v.replace(/\D/g, "").slice(-10);
  const month = Number(d.slice(2, 4)), day = Number(d.slice(4, 6)) % 60; // +60 = coordination number
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 && luhn(d);
}

/** A token-like secret: long, and mixes at least two of upper case, lower case and digits. */
function looksSecret(v: string): boolean {
  if (v.length < 20 || /^https?:/i.test(v)) return false;
  return [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(v)).length >= 2;
}

/** Passwords: not a placeholder ("********", "[password]") or an ordinary word after "is". */
function looksPassword(v: string): boolean {
  return v.length >= 4 && !/^[*•x.\[(<]/i.test(v) && /[\d\W_]/.test(v);
}

/**
 * A label followed by its value. Between them: punctuation and spaces, optionally a short
 * linking word ("is", "ist", "est", "är", "è", ...), so "Passwort: x", "PIN (x)" and
 * "your password is x" all match. Labels are matched as whole words.
 */
function labelled(labels: string[], value: string): RegExp {
  const punct = String.raw`[\s:=#*(\-–"'>]*`;
  const word = String.raw`(?:(?:is|was|of|ist|lautet|est|es|är|è|e|on|am|le|el|il|op|e\.g\.|z\.b\.|bijv\.|p\.ex\.)(?=[\s:])[\s:]+)?`;
  // Spaces inside a label may also be written as "_" or "-" (Passport_Number, date-of-birth).
  const flex = labels.map((l) => l.replace(/(?:\\s[+*]| )(?![^[]*\])/g, String.raw`[\s_-]*`));
  return new RegExp(String.raw`(?<![\p{L}\d])(?:${flex.join("|")})(?![\p{L}])${punct}${word}${punct}(${value})`, "giu");
}

const ACCOUNT_LABELS = [
  String.raw`a/c`, "acct\\.?", String.raw`account(?:\s*(?:no\.?|number|nr\.?|#))?`, "bban",
  String.raw`konto(?:nummer|nr\.?|-?nr\.?)?`, String.raw`num[ée]ro de compte`, "compte",
  String.raw`n[úu]mero de cuenta`, "cuenta", "numerocuenta", String.raw`numero di conto`, String.raw`conto(?: corrente)?`,
  String.raw`(?:bank)?rekening(?:nummer)?`, "accountnummer", "kontonummer", "bankverbindung",
];
const ROUTING_LABELS = [
  String.raw`(?:bank\s+)?routing(?:\s+(?:no\.?|number|#))?`, "aba(?:\\s+number)?", "rtn", String.raw`sort\s*code`, String.raw`numero di routing(?: bancario)?`,
  "bankleitzahl", "blz", String.raw`code banque`, String.raw`clearing(?:nummer|nr\.?)?`, String.raw`codice abi`,
];
const CVV_LABELS = [
  "cvv2?", "cvc2?", String.raw`(?:card\s+)?security code`, "kartenprüfnummer", "cryptogramme",
  String.raw`c[óo]digo de seguridad`, String.raw`(?:creditcard\s+)?veiligheidscode`, String.raw`codice cvv`, String.raw`codice di sicurezza della carta(?: di credito)?`, "säkerhetskod",
  String.raw`security code for the card`, String.raw`(?:3|three)-digit security code`,
];
const ID_LABELS = [
  String.raw`social security(?:\s+(?:no\.?|number))?`, "ssn", String.raw`national insurance(?:\s+(?:no\.?|number))?`, "nino",
  String.raw`national id(?:\s+(?:no\.?|number))?`, String.raw`id(?:entity)?\s+(?:card\s+)?(?:no\.?|number)`,
  String.raw`passport(?:-|\s+)?(?:no\.?|number|nummer|#)?`, String.raw`n[úu]mero de pasaporte`, "pasaporte", "passeport",
  String.raw`(?:reise)?pass(?:nummer|nr\.?)`, "reisepass", "passaporto", String.raw`paspoort(?:nummer)?`, String.raw`pass(?:port)?numre?t`,
  String.raw`driver'?s?\s+licen[cs]e(?:\s+(?:no\.?|number|#))?`, String.raw`driving licen[cs]e(?:\s+(?:no\.?|number))?`,
  String.raw`permis de conduire`, String.raw`f[üu]hrerschein(?:nummer)?`, String.raw`(?:n[úu]mero de )?licencia de conducir`,
  String.raw`patente(?: di guida)?`, String.raw`rijbewijs(?:nummer)?`, String.raw`k[öo]rkort(?:snummer)?`,
  "personnummer", "bsn", "burgerservicenummer", String.raw`codice fiscale`, "dni", "nie", String.raw`steuer-?id`,
  "steueridentifikationsnummer", String.raw`num[ée]ro de s[ée]curit[ée] sociale`, String.raw`tax\s+id(?:\s+(?:no\.?|number))?`,
  String.raw`personalausweis(?:nummer)?`, String.raw`carte d'identit[ée]`, String.raw`nif(?:/cif)?(?: n[úu]mero)?`,
  String.raw`n[úu]mero de identificaci[óo]n fiscal`, String.raw`persoonlijke? identificatienummer`,
];
const DOB_LABELS = [
  "dob", String.raw`d\.o\.b\.?`, String.raw`date\s+of\s+birth`, String.raw`birth\s*date`, "dateofbirth", String.raw`born(?:\s+on)?`,
  String.raw`geboren(?:\s+(?:am|op))?`, "geburtsdatum", String.raw`n[ée]e?(?:\(e\))?\s+le`, String.raw`date de naissance`,
  String.raw`fecha de nacimiento`, String.raw`nacid[oa] el`, "född", "födelsedatum", "geboortedatum",
  String.raw`data di nascita`, String.raw`nat[oa](?:/a)?\s+il`,
];
const PASSWORD_LABELS = [
  "password", "passwd", "pwd", "passcode", "pin", String.raw`pin-?code`, String.raw`(?:account|card)\s+pin`,
  String.raw`acct\s*pin`, "passwort", "kennwort", String.raw`mot de passe`, "contraseña", "lösenord(?:et)?", "wachtwoord", "pinkod", "pinkode",
];
const SECRET_LABELS = [
  String.raw`api[_ -]?key`, String.raw`api-schlüssel`, String.raw`cl[ée] (?:d')?api`, String.raw`secret(?:[_ -]?key)?`, String.raw`client[_ -]secret`, String.raw`(?:access|auth|bearer|refresh)[_ -]?token`,
  "bearer", "token", String.raw`private[_ -]key`,
];
// 01/01/1980, 1980-01-01, 15 March 1985, 1er janvier 1985, 8 de octubre de 1915, October 15, 1960
const DATE = String.raw`\d{1,4}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}(?:er|º|\.)?\s+(?:de\s+)?\p{L}{3,}\.?\s+(?:de\s+)?\d{4}|\p{L}{3,}\.?\s+\d{1,2},?\s+\d{4}`;

const RULES: Rule[] = [
  {
    type: "card_number",
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    check: (v) => {
      const d = v.replace(/\D/g, "");
      return d.length >= 13 && d.length <= 19 && new Set(d).size > 1 && cardGrouping(v) && luhn(d);
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
    // "Account: 50100234567890", "Kontonummer 1234 5678 90", "BBAN: ABCD12345678" (masked "XXXX1234" too).
    type: "account_number",
    re: labelled(ACCOUNT_LABELS, String.raw`(?:[A-Z]{1,4}|[X*•x]{2,}\s?)?\d[\d -]{4,24}\d`),
    group: 1,
    check: (v) => v.replace(/\D/g, "").length >= 6,
  },
  { type: "routing_number", re: labelled(ROUTING_LABELS, String.raw`\d{2}[- ]?\d{2}[- ]?\d{2}(?:\d{3})?(?!\d)`), group: 1 },
  { type: "card_security_code", re: labelled(CVV_LABELS, String.raw`\d{3,4}(?!\d)`), group: 1 },
  { type: "us_ssn", re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { type: "aadhaar", re: /\b[2-9]\d{3} \d{4} \d{4}\b/g, check: (v) => verhoeff(v.replace(/\D/g, "")) },
  { type: "se_personnummer", re: /\b(?:19|20)?\d{6}[-+]\d{4}\b/g, check: personnummerValid },
  { type: "in_pan", re: /\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b/g },
  { type: "it_codice_fiscale", re: /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/g },
  {
    // Passport, national ID, driving licence, tax ID and similar numbers after their label.
    type: "id_number",
    re: labelled(ID_LABELS, String.raw`[A-Z0-9](?:[A-Z0-9]|[ -](?=\d)){4,19}`),
    group: 1,
    check: (v) => (v.match(/\d/g) ?? []).length >= 4,
  },
  {
    type: "passport_mrz",
    re: /^(?:P<[A-Z<]{3}[A-Z<]{20,}|[A-Z0-9<]{9}\d[A-Z<]{3}\d{6}\d[MF<]\d{6}\d[A-Z0-9<]{10,})$/gm,
  },
  { type: "date_of_birth", re: labelled(DOB_LABELS, DATE), group: 1 },
  {
    type: "api_key",
    re: /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|sk-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|SG\.[\w-]{16,}\.[\w-]{16,}|sq0(?:atp|csp)-[\w-]{20,}|sl\.[\w-]{24,})(?![\w-])/g,
  },
  { type: "secret", re: labelled(SECRET_LABELS, String.raw`[A-Za-z0-9_\-./+=]{20,}`), group: 1, check: looksSecret },
  { type: "password", re: labelled(PASSWORD_LABELS, String.raw`[^\s,;"'<]*[^\s,;.!?)"'<]`), group: 1, check: looksPassword },
  {
    type: "otp",
    re: /\b(?:code|otp|verification code|passcode|one[- ]time|bestätigungscode|sicherheitscode|code de (?:vérification|confirmation)|código de verificación|codice di verifica|verificatiecode|engångskod|verifieringskod)\b[^0-9\n]{0,30}\b(\d{4,8})\b/giu,
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
