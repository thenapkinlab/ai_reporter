// Benchmark for the share-or-withhold decision. Runs labelled emails through the same
// decide() logic as the gateway, with each candidate Bedrock model plus a rules-only baseline.
//
//   npm run eval                                   # our hand-written edge cases
//   npm run eval -- --external                     # + public-dataset emails (npm run eval:import first)
//   npm run eval -- --external --docs 300          # + 300 public finance documents with sensitive values
//   npm run eval -- --models eu.amazon.nova-micro-v1:0,<other-id> --tags adversarial
//   --batch 10 (emails per request, like the gateway)   --rpm 15 (stay under the account's request limit)
//   npm run eval -- --holdout --docs 191           # disjoint public sample never used for tuning (eval:import -- --holdout)
//
// Needs AWS credentials (aws login) with Bedrock access in --region (default eu-north-1).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockClassifier, type CallInfo } from "../src/aws/bedrock";
import { PROMPT_VERSION, type Label } from "../src/filter/classifier";
import type { RedactionCase } from "./import";
import { accuracyByTag, confusion, outcomeFor, percentile, prepare, score, wilson, type EvalCase, type Outcome, type Prepared } from "./score";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODELS = ["eu.amazon.nova-2-lite-v1:0", "eu.anthropic.claude-haiku-4-5-20251001-v1:0"];
const THRESHOLDS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

interface ModelAnswer {
  label: Label | null;
  error: string | null;
  latencyMs: number | null;
}

interface Run {
  name: string;
  rulesOnly: boolean;
  answers: Map<string, ModelAnswer>;
  inputTokens: number;
  outputTokens: number;
  failures: number;
  /** Follow-up requests for emails a batch left unanswered. */
  retries: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isThrottle = (e: unknown) => /throttl|too many requests|rate exceeded/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e));

/** Sends batches one after another, at most `rpm` requests per minute, retrying throttled requests. */
async function runModel(model: string, prepared: Prepared[], client: BedrockRuntimeClient, batch: number, rpm: number): Promise<Run> {
  const run: Run = { name: model, rulesOnly: false, answers: new Map(), inputTokens: 0, outputTokens: 0, failures: 0, retries: 0 };
  const gapMs = Math.ceil(60000 / rpm);
  let lastStart = 0;
  for (let start = 0; start < prepared.length; start += batch) {
    const chunk = prepared.slice(start, start + batch);
    let last: CallInfo | null = null;
    const classifier = new BedrockClassifier(model, client, (info) => {
      last = info;
      run.inputTokens += info.inputTokens;
      run.outputTokens += info.outputTokens;
    });
    const inputs = chunk.map((p) => ({ from: p.c.from, subject: p.c.subject, text: p.text }));
    let labels: (Label | null)[] | null = null;
    let error = "";
    for (let attempt = 0; attempt < 6 && !labels; attempt++) {
      const wait = lastStart + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      try {
        labels = chunk.length > 1 ? await classifier.classifyBatch(inputs) : [await classifier.classify(inputs[0]!)];
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        if (!isThrottle(e)) break;
        await sleep(gapMs * 2 ** attempt);
      }
    }
    // Like the gateway: one follow-up request for any emails left unanswered.
    const missing = (labels ?? chunk.map(() => null)).flatMap((l, j) => (l ? [] : [j]));
    if (labels && missing.length) {
      const wait = lastStart + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      try {
        const sub = missing.map((j) => inputs[j]!);
        const retry = sub.length > 1 ? await classifier.classifyBatch(sub) : [await classifier.classify(sub[0]!)];
        missing.forEach((j, k) => (labels![j] = retry[k] ?? null));
        run.retries++;
      } catch {
        // Still unanswered: withheld, as in the gateway.
      }
    }
    const latency = (last as CallInfo | null)?.latencyMs ?? null;
    chunk.forEach((p, j) => {
      const label = labels?.[j] ?? null;
      if (!label) run.failures++;
      run.answers.set(p.c.id, { label, error: label ? null : error || "no answer for this email in the batch", latencyMs: latency });
    });
    process.stdout.write(labels ? "." : "x");
  }
  process.stdout.write("\n");
  return run;
}

function outcomes(run: Run, prepared: Prepared[], threshold: number): Outcome[] {
  return prepared.map((p) => {
    const a = run.answers.get(p.c.id);
    return outcomeFor(p, a?.label ?? null, a?.error ?? null, a?.latencyMs ?? null, threshold, run.rulesOnly);
  });
}

const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(1)}%`);
const ci = (k: number, n: number) => {
  const [lo, hi] = wilson(k, n);
  return n ? `(${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)})` : "";
};

function report(runs: Run[], prepared: Prepared[], threshold: number): string {
  const lines: string[] = [];
  lines.push(`# Share-or-withhold benchmark`, ``, `${new Date().toISOString()} · ${prepared.length} cases · category threshold ${threshold} · prompt ${PROMPT_VERSION}`, ``);
  lines.push(
    `Positive = should be withheld. Recall = TP / (TP + FN). Precision = TP / (TP + FP). FPR (false positive rate) = FP / (FP + TN).`,
    `Category accuracy = correct medical / financial / other label. Unanswered rate = emails the model gave no usable answer for (the gateway withholds these if they look sensitive).`,
    ``,
  );
  lines.push(`## Summary`, ``);
  lines.push(`Ranges are 95% confidence intervals (Wilson): differences inside them are likely noise.`, ``);
  lines.push(`| Model | Recall | Precision | FPR | Category accuracy | Unanswered rate | Latency p50 / p95 (per request) | Tokens in / out |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of runs) {
    const o = outcomes(r, prepared, threshold);
    const s = score(o);
    const lat = o.map((x) => x.latencyMs).filter((x): x is number => x !== null);
    const p50 = percentile(lat, 0.5), p95 = percentile(lat, 0.95);
    lines.push(
      `| ${r.name} | ${pct(s.recall)} ${ci(s.tp, s.tp + s.fn)} | ${pct(s.precision)} | ${pct(s.fpr)} ${ci(s.fp, s.fp + s.tn)} | ${pct(s.categoryAccuracy)} | ${r.rulesOnly ? "–" : `${pct(r.failures / prepared.length)} (${r.failures}; ${r.retries} retries)`} | ${p50 === null ? "–" : `${p50} / ${p95} ms`} | ${r.inputTokens} / ${r.outputTokens} |`,
    );
  }
  lines.push(``);

  for (const r of runs) {
    const o = outcomes(r, prepared, threshold);
    const s = score(o);
    lines.push(`## ${r.name}`, ``, `**Category threshold sweep** (sensitive items withhold regardless)`, ``, `| Threshold | Recall | FPR |`, `|---|---|---|`);
    for (const t of THRESHOLDS) {
      const st = score(outcomes(r, prepared, t));
      lines.push(`| ${t}${t === threshold ? " (current)" : ""} | ${pct(st.recall)} | ${pct(st.fpr)} |`);
    }
    lines.push(``, `**Correct decisions by case type**`, ``, `| Tag | Correct |`, `|---|---|`);
    for (const [tag, v] of Object.entries(accuracyByTag(o)).sort()) lines.push(`| ${tag} | ${v.correct}/${v.n} |`);
    const m = confusion(o);
    lines.push(``, `**Category confusion** (rows = expected, columns = label used)`, ``, `| | medical | financial | other |`, `|---|---|---|---|`);
    for (const e of ["medical", "financial", "other"] as const) lines.push(`| ${e} | ${m[e].medical} | ${m[e].financial} | ${m[e].other} |`);
    const byId = new Map(o.map((x) => [x.id, x]));
    const detail = (id: string) => {
      const x = byId.get(id)!;
      return `- \`${id}\` expected ${x.expected}${x.expectWithhold ? " (withhold)" : ""}; label ${x.label.category} ${x.label.confidence.toFixed(2)} [${x.label.sensitive.join(", ")}] (${x.label.source}); because: ${x.because.join(", ") || "–"} — ${x.label.reason}`;
    };
    lines.push(``, `**False negatives: shared but should be withheld** (${s.falseNegatives.length})`, ...s.falseNegatives.slice(0, 60).map(detail));
    lines.push(``, `**False positives: withheld but should be shared** (${s.falsePositives.length})`, ...s.falsePositives.slice(0, 60).map(detail));
    const errs = o.filter((x) => x.modelError);
    if (errs.length) lines.push(``, `**Model errors** (${errs.length})`, ...errs.slice(0, 10).map((x) => `- \`${x.id}\`: ${x.modelError}`));
    lines.push(``);
  }
  return lines.join("\n");
}

function reviewedNoise(): Set<string> {
  const f = join(here, "label-review.json");
  if (!existsSync(f)) return new Set();
  const { noise } = JSON.parse(readFileSync(f, "utf8")) as { noise: { case: string; value: string }[] };
  return new Set(noise.map((n) => `${n.case}|${n.value}`));
}

function loadCases(): EvalCase[] {
  const read = (f: string) => (JSON.parse(readFileSync(f, "utf8")) as { cases: EvalCase[] }).cases;
  // Held-out runs leave out the hand-written cases too: prompts were tuned on them.
  let cases = process.argv.includes("--holdout") || process.argv.includes("--test") ? [] : read(join(here, "dataset.json"));
  // --holdout: the disjoint public sample (npm run eval:import -- --holdout), never used for tuning.
  const split = process.argv.includes("--test") ? "test" : process.argv.includes("--holdout") ? "holdout" : "";
  const ext = join(here, "external", split);
  if (process.argv.includes("--external") || split) {
    const f = join(ext, "cases.json");
    if (!existsSync(f)) throw new Error("Run `npm run eval:import` first.");
    cases = [...cases, ...read(f)];
  }
  const docs = Number(arg("docs", "0"));
  if (docs > 0) {
    const f = join(ext, "redaction.json");
    if (!existsSync(f)) throw new Error("Run `npm run eval:import` first.");
    // Public finance documents with labelled sensitive values: every one should be withheld.
    // Values a person reviewed and found mislabelled don't count; documents left with none are dropped.
    const noise = reviewedNoise();
    const rc = (JSON.parse(readFileSync(f, "utf8")) as { cases: RedactionCase[] }).cases
      .map((c) => ({ ...c, required: c.required.filter((r) => !noise.has(`${c.id.replace(/^(ho|te)-/, "")}|${r.value}`)) }))
      .filter((c) => c.required.length > 0);
    cases = [
      ...cases,
      ...rc.slice(0, docs).map((c) => ({
        id: `doc-${c.id}`,
        tags: [...c.tags, "docs", "withhold", "no-category"],
        expected: "other" as const,
        from: "noreply@service.example",
        subject: "Document",
        body: c.text.slice(0, 4000),
      })),
    ];
  }
  const tagFilter = arg("tags");
  if (tagFilter) cases = cases.filter((c) => tagFilter.split(",").some((t) => c.tags.includes(t)));
  const limit = Number(arg("limit", "0"));
  return limit > 0 ? cases.slice(0, limit) : cases;
}

async function main() {
  const cases = loadCases();
  const models = (arg("models") ?? DEFAULT_MODELS.join(",")).split(",").filter(Boolean);
  const region = arg("region", "eu-north-1")!;
  const threshold = Number(arg("threshold", "0.6"));
  const batch = Number(arg("batch", "10"));
  const rpm = Number(arg("rpm", "15"));
  const client = new BedrockRuntimeClient({ region, maxAttempts: 6 });
  const prepared = cases.map(prepare);
  console.log(`${cases.length} cases, models: ${models.join(", ")}, region ${region}, ${batch} emails per request, ${rpm} requests/min`);

  const runs: Run[] = [{ name: "rules + detectors only (no model)", rulesOnly: true, answers: new Map(), inputTokens: 0, outputTokens: 0, failures: 0, retries: 0 }];
  for (const m of models) {
    console.log(`Running ${m}`);
    runs.push(await runModel(m, prepared, client, batch, rpm));
  }

  const md = report(runs, prepared, threshold);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(here, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${stamp}.md`), md);
  writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify(runs.map((r) => ({ ...r, answers: Object.fromEntries(r.answers) })), null, 2));
  const summaryEnd = md.indexOf("\n## ", md.indexOf("## Summary") + 5);
  console.log("\n" + (summaryEnd > 0 ? md.slice(0, summaryEnd) : md));
  console.log(`Full report: eval/results/${stamp}.md`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
