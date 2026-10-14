// Redaction benchmark: runs emails through the same pipeline as the gateway (detectors, batched
// classifier, redactor, decision) and checks what the assistant would receive.
//
//   npm run eval:redactor                                  # hand-written shopping/travel set, Haiku
//   npm run eval:redactor -- --qa                          # + ask a model each case's question (end to end)
//   npm run eval:redactor -- --gretel 200                  # + 200 public finance documents (value recall only)
//   npm run eval:redactor -- --models <id>,<id> --rpm 9
//
// Metrics (see README):
//   Value recall        sensitive values that did not reach the assistant (full or partial leak = miss)
//   Usable rate         emails that should be shared (redacted or unchanged) and were not withheld
//   Over-redaction      strings that must stay (shop/venue addresses, order numbers...) but were removed
//   Facts kept          facts the assistant needs that are still in what it receives
//   Integrity           output equals the original apart from [removed: ...] markers
//   Answer accuracy     the assistant's answer to the user's question, redacted vs original email
//
// Needs AWS credentials (aws login) with Bedrock access in --region (default eu-north-1).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { BedrockClassifier, type CallInfo } from "../src/aws/bedrock";
import { PROMPT_VERSION, type ClassifyInput, type Classifier, type Label } from "../src/filter/classifier";
import { BATCH_SIZE, processEmails, type Decision, type EngineDeps } from "../src/filter/engine";
import { findValue } from "../src/filter/redactor";
import type { Email } from "../src/mail";
import type { RedactionCase } from "./import";
import { DEFAULT_POLICY, percentile } from "./score";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODELS = ["eu.anthropic.claude-haiku-4-5-20251001-v1:0"];

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export interface RedactCase {
  id: string;
  tags: string[];
  expect: "redact" | "share" | "withhold";
  from: string;
  subject: string;
  body: string;
  attachments?: { filename: string; text: string }[];
  remove: { item: string; value: string }[];
  keep: string[];
  notSensitive: string[];
  question?: string;
  answer?: string[];
  /** Public cases only: values grouped by the dataset's label. */
  byLabel?: Record<string, string[]>;
}

// ---------------------------------------------------------------- scoring (pure)

/** Tokens that belong only to the sensitive value: if one shows up in the output, part of the value leaked. */
export function uniqueTokens(value: string, original: string): string[] {
  let rest = original;
  for (const m of findValue(original, value).reverse()) rest = rest.slice(0, m.start) + " " + rest.slice(m.end);
  return value
    .split(/[\s,]+/)
    .map((t) => t.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, ""))
    .filter((t) => t.length >= 3 && !hasToken(rest, t));
}

/** Whole-token, case-insensitive: "114" doesn't match inside "011456". */
function hasToken(text: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\d])${esc}(?![\\p{L}\\d])`, "iu").test(text);
}

export type Leak = "none" | "partial" | "full";

export function leakOf(value: string, original: string, output: string | null): Leak {
  if (output === null) return "none";
  if (findValue(output, value).length) return "full";
  return uniqueTokens(value, original).some((t) => hasToken(output, t)) ? "partial" : "none";
}

/** True if `output` is `original` with some spans replaced by [removed: ...] markers and nothing else changed. */
export function integrityOk(original: string, output: string): boolean {
  const parts = output.split(/\[removed: [^\]]+\]/);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${parts.map(esc).join("[\\s\\S]+?")}$`).test(original);
}

// ---------------------------------------------------------------- running

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isThrottle = (e: unknown) => /throttl|too many requests|rate exceeded/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e));

/** Paces requests under the account's per-minute limit and retries throttled ones, like a patient gateway. */
class Paced implements Classifier {
  private last = 0;
  constructor(private inner: BedrockClassifier, private gapMs: number) {}
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      try {
        return await fn();
      } catch (e) {
        if (!isThrottle(e) || attempt >= 5) throw e;
        await sleep(this.gapMs * 2 ** attempt);
      }
    }
  }
  classify(i: ClassifyInput) {
    return this.call(() => this.inner.classify(i));
  }
  classifyBatch(i: ClassifyInput[]) {
    return this.call(() => this.inner.classifyBatch(i));
  }
}

function toEmail(c: RedactCase): Email {
  return {
    id: c.id,
    from: c.from,
    subject: c.subject,
    date: "",
    snippet: c.body.replace(/\s+/g, " ").slice(0, 150),
    body: c.body,
    attachments: (c.attachments ?? []).map((a) => {
      const bytes = new TextEncoder().encode(a.text);
      return { filename: a.filename, mimeType: "text/plain", size: bytes.length, load: async () => bytes };
    }),
  };
}

function fromGretel(r: RedactionCase): RedactCase {
  const values = [
    ...r.required.map((x) => ({ item: x.item as string, value: x.value, label: x.label })),
    ...r.gaps.filter((g) => g.label === "street_address").map((g) => ({ item: "home_address", value: g.value, label: g.label })),
  ].filter((v) => v.value.trim().length >= 3 && r.text.slice(0, 4000).includes(v.value));
  const byLabel: Record<string, string[]> = {};
  for (const v of values) (byLabel[v.label] ??= []).push(v.value);
  return {
    id: `gr-${r.id}`,
    tags: ["gretel", ...r.tags, ...new Set(values.map((v) => `label:${v.label}`))],
    expect: "redact",
    from: "noreply@service.example",
    subject: "Document",
    body: r.text.slice(0, 4000),
    remove: values.map(({ item, value }) => ({ item, value })),
    keep: [],
    notSensitive: [],
    byLabel,
  };
}

interface Run {
  name: string;
  decisions: Map<string, Decision>;
  latencies: number[];
  inputTokens: number;
  outputTokens: number;
}

async function runPipeline(name: string, cases: RedactCase[], classifier: Classifier | null, onBatch?: () => void): Promise<Run> {
  const cache = new Map<string, Label>();
  const deps: EngineDeps = {
    classifier,
    extractText: async () => null,
    cache: { get: async (id) => cache.get(id) ?? null, put: async (id, l) => void cache.set(id, l) },
    policy: DEFAULT_POLICY,
  };
  const run: Run = { name, decisions: new Map(), latencies: [], inputTokens: 0, outputTokens: 0 };
  for (let i = 0; i < cases.length; i += BATCH_SIZE) {
    const chunk = cases.slice(i, i + BATCH_SIZE);
    const ds = await processEmails(chunk.map(toEmail), deps);
    ds.forEach((d) => run.decisions.set(d.messageId, d));
    onBatch?.();
    process.stdout.write(ds.some((d) => d.label.source === "fallback" && classifier) ? "x" : ".");
  }
  process.stdout.write("\n");
  return run;
}

const outputOf = (d: Decision | undefined) => (d?.filtered ? `${d.filtered.subject}\n${d.filtered.snippet}\n${d.filtered.body}` : null);

async function ask(client: BedrockRuntimeClient, model: string, question: string, email: string, gapMs: number, state: { last: number }): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const wait = state.last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    state.last = Date.now();
    try {
      const r = await client.send(
        new ConverseCommand({
          modelId: model,
          system: [{ text: "You are an email assistant. Answer the user's question in one short sentence using only the email provided. If the email doesn't contain the answer, say you can't tell." }],
          messages: [{ role: "user", content: [{ text: `Email:\n${email}\n\nQuestion: ${question}` }] }],
          inferenceConfig: { maxTokens: 100, temperature: 0 },
        }),
      );
      return (r.output?.message?.content ?? []).map((b) => ("text" in b && b.text) || "").join("");
    } catch (e) {
      if (!isThrottle(e) || attempt >= 5) throw e;
      await sleep(gapMs * 2 ** attempt);
    }
  }
}

// ---------------------------------------------------------------- report

interface Scores {
  values: number;
  leakedFull: number;
  leakedPartial: number;
  valuesSent: number;
  leakedSent: number;
  usable: number;
  usableOf: number;
  wronglyRedacted: number;
  shareOf: number;
  withholdOk: number;
  withholdOf: number;
  overRedacted: number;
  notSensitiveOf: number;
  keptFacts: number;
  factsOf: number;
  integrity: number;
  integrityOf: number;
  leaks: string[];
  overs: string[];
  wrongActions: string[];
}

function score(cases: RedactCase[], run: Run): Scores {
  const s: Scores = {
    values: 0, leakedFull: 0, leakedPartial: 0, valuesSent: 0, leakedSent: 0, usable: 0, usableOf: 0, wronglyRedacted: 0, shareOf: 0,
    withholdOk: 0, withholdOf: 0, overRedacted: 0, notSensitiveOf: 0, keptFacts: 0, factsOf: 0, integrity: 0, integrityOf: 0,
    leaks: [], overs: [], wrongActions: [],
  };
  for (const c of cases) {
    const d = run.decisions.get(c.id);
    const out = outputOf(d);
    const original = `${c.subject}\n${c.body}`;
    for (const v of c.remove) {
      s.values++;
      const leak = leakOf(v.value, original, out);
      if (out !== null) s.valuesSent++;
      if (leak !== "none") {
        s.leakedSent++;
        if (leak === "full") s.leakedFull++;
        else s.leakedPartial++;
        s.leaks.push(`\`${c.id}\` ${v.item} ${leak} leak — model listed: ${(d?.label.values ?? []).map((x) => x.item).join(", ") || "nothing"}`);
      }
    }
    if (c.expect === "withhold") {
      s.withholdOf++;
      if (d?.action === "withheld") s.withholdOk++;
      else s.wrongActions.push(`\`${c.id}\` expected withheld, got ${d?.action}`);
      continue;
    }
    s.usableOf++;
    if (out !== null) s.usable++;
    else s.wrongActions.push(`\`${c.id}\` expected ${c.expect === "share" ? "shared" : "redacted"}, got withheld (${d?.because.join(", ")})`);
    if (c.expect === "share") {
      s.shareOf++;
      if (d?.action === "redacted") {
        s.wronglyRedacted++;
        s.wrongActions.push(`\`${c.id}\` expected shared unchanged, got redacted (${d.because.join(", ")})`);
      }
    }
    for (const k of c.notSensitive) {
      if (out === null) continue;
      s.notSensitiveOf++;
      if (!out.includes(k)) {
        s.overRedacted++;
        s.overs.push(`\`${c.id}\` removed "${k}"`);
      }
    }
    for (const k of c.keep) {
      s.factsOf++;
      if (out?.includes(k)) s.keptFacts++;
    }
    if (d?.filtered) {
      s.integrityOf++;
      if (integrityOk(c.body, d.filtered.body) && integrityOk(c.subject, d.filtered.subject)) s.integrity++;
    }
  }
  return s;
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "–");

async function main() {
  const set = JSON.parse(readFileSync(join(here, "redaction-set.json"), "utf8")) as { cases: RedactCase[] };
  let cases = set.cases;
  const gretelN = Number(arg("gretel", "0"));
  if (gretelN > 0) {
    const f = join(here, "external", "redaction.json");
    if (!existsSync(f)) throw new Error("Run `npm run eval:import` first.");
    const gr = (JSON.parse(readFileSync(f, "utf8")) as { cases: RedactionCase[] }).cases.map(fromGretel).filter((c) => c.remove.length);
    cases = [...cases, ...gr.slice(0, gretelN)];
  }
  const tagFilter = arg("tags");
  if (tagFilter) cases = cases.filter((c) => tagFilter.split(",").some((t) => c.tags.includes(t)));
  const models = (arg("models") ?? DEFAULT_MODELS.join(",")).split(",").filter(Boolean);
  const region = arg("region", "eu-north-1")!;
  const gapMs = Math.ceil(60000 / Number(arg("rpm", "9")));
  const qa = process.argv.includes("--qa");
  const qaModel = arg("qa-model", "eu.anthropic.claude-haiku-4-5-20251001-v1:0")!;
  const client = new BedrockRuntimeClient({ region, maxAttempts: 6 });
  console.log(`${cases.length} cases (${cases.filter((c) => c.tags.includes("gretel")).length} public), models: ${models.join(", ")}, prompt ${PROMPT_VERSION}`);

  const runs: Run[] = [await runPipeline("detectors only (no model)", cases, null)];
  for (const m of models) {
    console.log(`Running ${m}`);
    const r: Run = { name: m, decisions: new Map(), latencies: [], inputTokens: 0, outputTokens: 0 };
    const inner = new BedrockClassifier(m, client, (i: CallInfo) => {
      r.latencies.push(i.latencyMs);
      r.inputTokens += i.inputTokens;
      r.outputTokens += i.outputTokens;
    });
    const done = await runPipeline(m, cases, new Paced(inner, gapMs));
    runs.push({ ...r, decisions: done.decisions });
  }

  const own = cases.filter((c) => !c.tags.includes("gretel"));
  const pub = cases.filter((c) => c.tags.includes("gretel"));
  const lines: string[] = [
    `# Redaction benchmark`,
    ``,
    `${new Date().toISOString()} · ${own.length} hand-written cases (${own.reduce((n, c) => n + c.remove.length, 0)} sensitive values)` +
      (pub.length ? ` + ${pub.length} public documents` : "") + ` · prompt ${PROMPT_VERSION}`,
    ``,
    `Value recall = sensitive values that did not reach the assistant; a partial leak (e.g. street name left) is a miss. ` +
      `"When sent" counts only emails that were shared or redacted, not withheld. Usable = should-be-shared emails that weren't withheld. ` +
      `Over-redaction = must-stay strings (shop, venue or airport addresses, order numbers, masked cards) removed. ` +
      `Facts kept = facts the assistant needs still present. Integrity = output is the original plus [removed: …] markers only.`,
    ``,
    `## Hand-written set`,
    ``,
    `| Pipeline | Value recall | Recall when sent | Full / partial leaks | Usable | Over-redaction | Facts kept | Withheld correctly | Shared unchanged wrongly redacted | Integrity | Latency p50 / p95 | Tokens in / out |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ];
  const details: string[] = [];
  for (const r of runs) {
    const s = score(own, r);
    const p50 = percentile(r.latencies, 0.5), p95 = percentile(r.latencies, 0.95);
    lines.push(
      `| ${r.name} | ${pct(s.values - s.leakedSent, s.values)} | ${pct(s.valuesSent - s.leakedSent, s.valuesSent)} | ${s.leakedFull} / ${s.leakedPartial} | ${pct(s.usable, s.usableOf)} | ${pct(s.overRedacted, s.notSensitiveOf)} | ${pct(s.keptFacts, s.factsOf)} | ${s.withholdOk}/${s.withholdOf} | ${s.wronglyRedacted}/${s.shareOf} | ${pct(s.integrity, s.integrityOf)} | ${p50 === null ? "–" : `${p50} / ${p95} ms`} | ${r.inputTokens} / ${r.outputTokens} |`,
    );
    details.push(`### ${r.name}`, ``, `**Leaks** (${s.leaks.length})`, ...s.leaks, ``, `**Over-redaction** (${s.overs.length})`, ...s.overs, ``, `**Wrong action** (${s.wrongActions.length})`, ...s.wrongActions, ``);
  }

  if (pub.length) {
    lines.push(``, `## Public documents (Gretel)`, ``, `Addresses here include business addresses (Gretel labels every street address), so address recall is an upper bound on what we want removed.`, ``);
    const labels = [...new Set(pub.flatMap((c) => c.tags.filter((t) => t.startsWith("label:"))))].sort();
    lines.push(`| Pipeline | Withheld whole | ${labels.map((l) => l.slice(6)).join(" | ")} |`, `|---|---|${labels.map(() => "---").join("|")}|`);
    for (const r of runs) {
      const withheld = pub.filter((c) => r.decisions.get(c.id)?.action === "withheld").length;
      const cells = labels.map((l) => {
        let n = 0, ok = 0;
        for (const c of pub) {
          if (!c.tags.includes(l)) continue;
          const out = outputOf(r.decisions.get(c.id));
          if (out === null) continue;
          for (const v of c.byLabel?.[l.slice(6)] ?? []) {
            n++;
            if (leakOf(v, `${c.subject}\n${c.body}`, out) === "none") ok++;
          }
        }
        return `${pct(ok, n)} (${n})`;
      });
      lines.push(`| ${r.name} | ${pct(withheld, pub.length)} | ${cells.join(" | ")} |`);
    }
    lines.push(``, `Per-label cells: value recall in documents that were sent (redacted or shared), with the number of values.`);
  }

  if (qa) {
    lines.push(``, `## Answer accuracy (${qaModel} answers the user's question)`, ``, `| Pipeline | Original email | What the assistant receives |`, `|---|---|---|`);
    const state = { last: 0 };
    const withQ = own.filter((c) => c.question && c.answer);
    const hit = (ans: string, c: RedactCase) => c.answer!.some((a) => ans.toLowerCase().includes(a.toLowerCase()));
    let base = 0;
    console.log(`Asking ${withQ.length} questions on the original emails`);
    const baseAnswers = new Map<string, boolean>();
    for (const c of withQ) {
      const ok = hit(await ask(client, qaModel, c.question!, `Subject: ${c.subject}\n\n${c.body}`, gapMs, state), c);
      baseAnswers.set(c.id, ok);
      if (ok) base++;
    }
    for (const r of runs) {
      console.log(`Asking ${withQ.length} questions: ${r.name}`);
      let ok = 0;
      const wrong: string[] = [];
      for (const c of withQ) {
        const d = r.decisions.get(c.id);
        const email = d?.filtered ? `Subject: ${d.filtered.subject}\n\n${d.filtered.body}` : `(This email was withheld by the user's privacy settings.)`;
        const ans = await ask(client, qaModel, c.question!, email, gapMs, state);
        if (hit(ans, c)) ok++;
        else if (baseAnswers.get(c.id)) wrong.push(`\`${c.id}\` ${d?.action}: ${ans.replace(/\s+/g, " ").slice(0, 120)}`);
      }
      lines.push(`| ${r.name} | ${pct(base, withQ.length)} | ${pct(ok, withQ.length)} |`);
      details.push(`**Answers lost to the filter, ${r.name}** (${wrong.length})`, ...wrong, ``);
    }
  }

  const md = [...lines, ``, `## Details`, ``, ...details].join("\n");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(here, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `redaction-${stamp}.md`), md);
  console.log("\n" + lines.join("\n"));
  console.log(`\nFull report: eval/results/redaction-${stamp}.md`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
