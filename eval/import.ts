// Builds the external evaluation sets from public datasets. Raw downloads and generated
// sets live in eval/external/ (git-ignored): the sources' licences allow use, but we don't
// redistribute them.
//
//   npm run eval:import            # download (cached) and build
//
// Sources:
//   - MTSamples medical transcriptions (harishnair04/mtsamples; original site terms unclear, internal use only)
//   - Gretel synthetic PII finance, 7 languages (gretelai/synthetic_pii_finance_multilingual, Apache-2.0)
//   - Multiclass email classification (Harshal3467/multiclass-email-classification, MIT)
//   - Email spam/not-spam (diegovelilla/email-classification-dataset, Apache-2.0)
//
// Outputs:
//   eval/external/cases.json       classifier cases, same shape as eval/dataset.json
//   eval/external/redaction.json   texts with the sensitive values the detectors must find
//   eval/external/spotcheck.md     60 random cases to review by hand before trusting scores

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { ibanValid, luhn } from "../src/filter/detectors";
import type { Category, SensitiveItem } from "../src/filter/classifier";
import type { EvalCase } from "./score";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "external");
const RAW = join(OUT, "raw");
const HF = "https://huggingface.co";
const MAX_CHARS = 4000;

const SOURCES = {
  mtsamples: `${HF}/api/datasets/harishnair04/mtsamples/parquet/default/train/0.parquet`,
  multiclass: `${HF}/datasets/Harshal3467/multiclass-email-classification/resolve/main/email_dataset.json`,
  spam: `${HF}/api/datasets/diegovelilla/email-classification-dataset/parquet/default/test/0.parquet`,
  gretel: (lang: string) => `${HF}/datasets/gretelai/synthetic_pii_finance_multilingual/resolve/main/data/${lang}_test-00000-of-00001.parquet`,
};
const GRETEL_LANGS = ["English", "German", "France", "Spanish", "Swedish", "Italian", "Dutch"];
const LANG_TAG: Record<string, string> = {
  English: "lang:en", German: "lang:de", France: "lang:fr", Spanish: "lang:es", Swedish: "lang:sv", Italian: "lang:it", Dutch: "lang:nl",
};

// Personal finance documents; company contracts, filings and data formats are left out.
// Payment and transaction confirmations are receipts ("other" by our policy) and are left out too;
// they are still withheld when they contain sensitive items (covered by the document set).
const GRETEL_FINANCIAL = new Set([
  "Bank Statement", "Credit Card Statement", "Loan Application", "Loan Agreement", "Mortgage Contract",
  "Mortgage Amortization Schedule", "Real Estate Loan Agreement", "Tax Return", "Tax Assessment Notice",
  "Trade Confirmation", "Credit Application",
  "Credit Card Application", "Cryptocurrency Transaction Report", "Pension Plan Agreement", "Financial Aid Application",
]);
const GRETEL_MEDICAL = new Set(["Health Insurance Claim Form"]);

// Gretel's personal-data labels mapped to the policy's sensitive items (what decides withholding).
const PII_ITEM: Record<string, SensitiveItem> = {
  credit_card_number: "card_number",
  credit_card_security_code: "card_number",
  iban: "bank_account",
  bban: "bank_account",
  bank_routing_number: "bank_account",
  ssn: "government_id",
  passport_number: "government_id",
  driver_license_number: "government_id",
  account_pin: "credentials",
  password: "credentials",
  api_key: "credentials",
  date_of_birth: "date_of_birth",
};
// Labelled by Gretel but not checked here: not sensitive by our policy (phone, SWIFT/BIC, customer IDs),
// or left to the model (a street address may be a business, not a home).
const NOT_CHECKED = ["street_address", "phone_number", "swift_bic_code"];

// ---------------------------------------------------------------- helpers

async function cached(name: string, url: string): Promise<string> {
  mkdirSync(RAW, { recursive: true });
  const path = join(RAW, name);
  if (!existsSync(path)) {
    process.stdout.write(`downloading ${name} … `);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    console.log("done");
  }
  return path;
}

async function parquet<T>(name: string, url: string, columns: string[]): Promise<T[]> {
  const file = await asyncBufferFromFile(await cached(name, url));
  return (await parquetReadObjects({ file, columns })) as T[];
}

/** Seeded RNG so the same sets are rebuilt every time. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const MAIN_SEED = 20261014;
const HOLDOUT_SEED = 20261016;
const TEST_SEED = 20261017;
let rand = rng(MAIN_SEED);
/** Items picked so far (by content); the held-out set excludes everything the main set used. */
const picked = new Set<string>();
let exclude = new Set<string>();
const keyOf = (x: unknown) => JSON.stringify(x);
function sample<T>(xs: T[], n: number): T[] {
  const a = xs.filter((x) => !exclude.has(keyOf(x)));
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  const out = a.slice(0, n);
  for (const x of out) picked.add(keyOf(x));
  return out;
}
const clip = (s: string) => (s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) : s).trim();
const clean = (s: unknown) => String(s ?? "").replace(/,\s*(?=[A-Z ]{3,}:)/g, "\n").trim();

function asEmail(
  id: string,
  expected: Category,
  tags: string[],
  subject: string,
  text: string,
  _attach: boolean,
  from = "noreply@service.example",
): EvalCase {
  // Always in the body: the gateway never opens attachments, so a document attached to a bland
  // email is simply not seen (or sent), and can't be tested that way.
  return { id, expected, tags, from, subject, body: clip(text) };
}

// ---------------------------------------------------------------- sources

interface Mt { description: string; medical_specialty: string; sample_name: string; transcription: string }
interface Gr { document_type: string; generated_text: string; pii_spans: string }
interface Mc { subject: string; body: string; labels: string | string[] }
interface Sp { text: string; label: string }

async function medical(): Promise<EvalCase[]> {
  const rows = (await parquet<Mt>("mtsamples.parquet", SOURCES.mtsamples, ["description", "medical_specialty", "sample_name", "transcription"]))
    .filter((r) => r.transcription && r.transcription.length > 200);
  return sample(rows, 120).map((r, i) => {
    const subject = i % 2 ? `Visit summary: ${r.sample_name.trim()}` : `Your report from ${r.medical_specialty.trim()}`;
    const text = `${r.description.trim()}\n\n${clean(r.transcription)}`;
    return asEmail(`ext-mt-${i}`, "medical", ["external", "source:mtsamples"], subject, text, i >= 70);
  });
}

async function gretel(): Promise<{ cases: EvalCase[]; redaction: RedactionCase[] }> {
  const cases: EvalCase[] = [];
  const redaction: RedactionCase[] = [];
  for (const lang of GRETEL_LANGS) {
    const rows = await parquet<Gr>(`gretel-${lang}.parquet`, SOURCES.gretel(lang), ["document_type", "generated_text", "pii_spans"]);
    const fin = rows.filter((r) => GRETEL_FINANCIAL.has(r.document_type));
    const med = rows.filter((r) => GRETEL_MEDICAL.has(r.document_type));
    const tag = LANG_TAG[lang]!;
    sample(fin, lang === "English" ? 40 : 12).forEach((r, i) =>
      cases.push(asEmail(`ext-gr-${lang}-f${i}`, "financial", ["external", "source:gretel", tag], r.document_type, r.generated_text, i % 2 === 0)),
    );
    sample(med, lang === "English" ? 10 : 4).forEach((r, i) =>
      cases.push(asEmail(`ext-gr-${lang}-m${i}`, "medical", ["external", "source:gretel", tag], r.document_type, r.generated_text, true)),
    );
    for (const r of rows) {
      const rc = toRedactionCase(`gr-${lang}-${redaction.length}`, r, tag);
      if (rc) redaction.push(rc);
    }
  }
  return { cases, redaction: sample(redaction, 3000) };
}

async function other(): Promise<EvalCase[]> {
  const mcPath = await cached("multiclass.json", SOURCES.multiclass);
  const mc = JSON.parse(readFileSync(mcPath, "utf8")) as Mc[];
  const labelsOf = (r: Mc) =>
    (Array.isArray(r.labels) ? r.labels : r.labels.replace(/[[\]']/g, "").split(",")).map((s) => s.trim());
  const nonFinance = mc.filter((r) => !labelsOf(r).includes("Finance & Bills"));
  const financeOnly = mc.filter((r) => labelsOf(r).join() === "Finance & Bills");

  const out: EvalCase[] = sample(nonFinance, 130).map((r, i) => ({
    id: `ext-mc-o${i}`,
    expected: "other" as Category,
    tags: ["external", "source:multiclass", ...labelsOf(r).map((l) => `mc:${l}`)],
    from: "sender@example.com",
    subject: r.subject,
    body: clip(r.body),
  }));
  // "Finance & Bills" mixes statements with utility bills and receipts, so these are marked
  // for review rather than scored until spot-checked.
  sample(financeOnly, 40).forEach((r, i) =>
    out.push({
      id: `ext-mc-f${i}`,
      expected: "financial",
      tags: ["external", "source:multiclass", "mc:Finance & Bills", "ambiguous"],
      from: "sender@example.com",
      subject: r.subject,
      body: clip(r.body),
    }),
  );

  const sp = await parquet<Sp>("spam-test.parquet", SOURCES.spam, ["text", "label"]);
  sample(sp.filter((r) => r.label === "not_spam" && r.text.length > 40), 40).forEach((r, i) =>
    out.push({ id: `ext-ham-${i}`, expected: "other", tags: ["external", "source:spam-set", "ham"], from: "sender@example.com", subject: r.text.slice(0, 60), body: clip(r.text) }),
  );
  sample(sp.filter((r) => r.label === "spam"), 30).forEach((r, i) =>
    out.push({ id: `ext-spam-${i}`, expected: "other", tags: ["external", "source:spam-set", "spam"], from: "promo@offers.example", subject: r.text.slice(0, 60), body: clip(r.text) }),
  );
  return out;
}

// ---------------------------------------------------------------- redaction set

export interface RedactionCase {
  id: string;
  tags: string[];
  text: string;
  /** Labelled values the detectors should find (checksum-valid where a checksum exists). */
  required: { item: SensitiveItem; label: string; value: string }[];
  /** Labelled values the detectors don't score (see NOT_CHECKED); the redactor benchmark uses the addresses. */
  gaps: { label: string; value: string }[];
}

function toRedactionCase(id: string, r: Gr, tag: string): RedactionCase | null {
  let spans: { start: number; end: number; label: string }[];
  try {
    spans = JSON.parse(r.pii_spans);
  } catch {
    return null;
  }
  const required: RedactionCase["required"] = [];
  const gaps: RedactionCase["gaps"] = [];
  for (const s of spans) {
    const value = r.generated_text.slice(s.start, s.end);
    const item = PII_ITEM[s.label];
    if (item) {
      const digits = value.replace(/\D/g, "");
      // Real card numbers and IBANs always pass their checksum; Gretel's invalid ones are skipped.
      if (s.label === "credit_card_number" && !(digits.length >= 13 && luhn(digits))) continue;
      if (s.label === "iban" && !ibanValid(value.replace(/\s/g, "").toUpperCase())) continue;
      required.push({ item, label: s.label, value });
    } else if (NOT_CHECKED.includes(s.label)) gaps.push({ label: s.label, value });
  }
  if (!required.length && !gaps.length) return null;
  return { id, tags: ["source:gretel", tag], text: r.generated_text, required, gaps };
}

// ---------------------------------------------------------------- main

async function buildSets() {
  const med = await medical();
  const gr = await gretel();
  const oth = await other();
  return { cases: [...med, ...gr.cases, ...oth], redaction: gr.redaction };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { cases, redaction } = await buildSets();
  writeFileSync(join(OUT, "cases.json"), JSON.stringify({ version: 1, generated: new Date().toISOString(), cases }, null, 1));
  writeFileSync(join(OUT, "redaction.json"), JSON.stringify({ version: 1, cases: redaction }, null, 1));
  const gr = { redaction };

  if (process.argv.includes("--holdout")) {
    // A second, disjoint sample from the same sources: never used to tune prompts or detectors,
    // so it shows whether improvements generalise. Same shapes, ids prefixed "ho-".
    // Three disjoint splits: dev (the main set: look at errors, change prompts), validation
    // ("holdout": compare versions on totals only) and test (locked: run once per release).
    const seen = new Set(cases.map((c) => c.body));
    const write = (name: string, idPrefix: string, set: { cases: EvalCase[]; redaction: RedactionCase[] }) => {
      // The sources contain repeated texts: drop any email already used by an earlier split.
      set = { ...set, cases: set.cases.filter((c) => !seen.has(c.body)) };
      for (const c of set.cases) seen.add(c.body);
      const dir = join(OUT, name);
      mkdirSync(dir, { recursive: true });
      const prefix = <T extends { id: string }>(xs: T[]) => xs.map((x) => ({ ...x, id: `${idPrefix}-${x.id}` }));
      writeFileSync(join(dir, "cases.json"), JSON.stringify({ version: 1, generated: new Date().toISOString(), cases: prefix(set.cases) }, null, 1));
      writeFileSync(join(dir, "redaction.json"), JSON.stringify({ version: 1, cases: prefix(set.redaction) }, null, 1));
      const overlap = set.cases.filter((c) => cases.some((m) => m.body === c.body)).length;
      console.log(`${name}: ${set.cases.length} classifier cases, ${set.redaction.length} redaction texts (overlap with dev: ${overlap})`);
    };
    exclude = new Set(picked);
    rand = rng(HOLDOUT_SEED);
    const ho = await buildSets();
    exclude = new Set(picked);
    rand = rng(TEST_SEED);
    const te = await buildSets();
    // The Gretel documents left after the dev sample are few, so validation and test split them in half.
    const pool = ho.redaction;
    const half = Math.ceil(pool.length / 2);
    write("holdout", "ho", { cases: ho.cases, redaction: pool.slice(0, half) });
    write("test", "te", { cases: te.cases, redaction: pool.slice(half) });
  }

  const count = (c: Category) => cases.filter((x) => x.expected === c && !x.tags.includes("ambiguous")).length;
  console.log(`classifier cases: ${cases.length} (medical ${count("medical")}, financial ${count("financial")}, other ${count("other")}, review-only ${cases.filter((x) => x.tags.includes("ambiguous")).length})`);
  console.log(`redaction texts: ${gr.redaction.length}, required values: ${gr.redaction.reduce((n, r) => n + r.required.length, 0)}`);

  const spot = sample(cases, 60)
    .map((c) => `### ${c.id} · expected **${c.expected}** · ${c.tags.join(", ")}\n**${c.subject}**\n\n> ${(c.attachments?.[0]?.text ?? c.body).slice(0, 400).replace(/\n+/g, " ")}\n\n- [ ] label correct`)
    .join("\n\n");
  writeFileSync(join(OUT, "spotcheck.md"), `# Spot-check: is each expected label right?\n\n${spot}\n`);
  console.log("wrote eval/external/cases.json, redaction.json, spotcheck.md");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
