// Benchmark for the share-or-withhold decision. Runs labelled emails through the same
// decide() logic as the gateway, with each candidate Bedrock model plus a rules-only baseline.
//
//   npm run eval                                   # our hand-written edge cases
//   npm run eval -- --external                     # + public-dataset emails (npm run eval:import first)
//   npm run eval -- --external --docs 300          # + 300 public finance documents with sensitive values
//   npm run eval -- --models eu.amazon.nova-micro-v1:0,<other-id> --tags adversarial
//
// Needs AWS credentials (aws login) with Bedrock access in --region (default eu-north-1).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockClassifier, type CallInfo } from "../src/aws/bedrock";
import type { Label } from "../src/filter/classifier";
import type { RedactionCase } from "./import";
import { accuracyByTag, confusion, outcomeFor, percentile, prepare, score, type EvalCase, type Outcome, type Prepared } from "./score";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODELS = ["eu.amazon.nova-micro-v1:0", "eu.amazon.nova-lite-v1:0"];
const THRESHOLDS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
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
}

async function runModel(model: string, prepared: Prepared[], client: BedrockRuntimeClient, concurrency: number): Promise<Run> {
  const run: Run = { name: model, rulesOnly: false, answers: new Map(), inputTokens: 0, outputTokens: 0, failures: 0 };
  await mapLimit(prepared, concurrency, async (p) => {
    let last: CallInfo | null = null;
    const classifier = new BedrockClassifier(model, client, (info) => {
      last = info;
      run.inputTokens += info.inputTokens;
      run.outputTokens += info.outputTokens;
    });
    try {
      const label = await classifier.classify({ from: p.c.from, subject: p.c.subject, text: p.text });
      run.answers.set(p.c.id, { label, error: null, latencyMs: (last as CallInfo | null)?.latencyMs ?? null });
      process.stdout.write(".");
    } catch (e) {
      run.failures++;
      run.answers.set(p.c.id, { label: null, error: e instanceof Error ? e.message : String(e), latencyMs: null });
      process.stdout.write("x");
    }
  });
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

function report(runs: Run[], prepared: Prepared[], threshold: number): string {
  const lines: string[] = [];
  lines.push(`# Share-or-withhold benchmark`, ``, `${new Date().toISOString()} · ${prepared.length} cases · category threshold ${threshold}`, ``);
  lines.push(`## Summary`, ``);
  lines.push(`| Model | Withheld when it should (recall) | Precision | Everyday emails wrongly withheld | Category accuracy | Model failures | Latency p50 / p95 | Tokens in / out |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of runs) {
    const o = outcomes(r, prepared, threshold);
    const s = score(o);
    const lat = o.map((x) => x.latencyMs).filter((x): x is number => x !== null);
    const p50 = percentile(lat, 0.5), p95 = percentile(lat, 0.95);
    lines.push(
      `| ${r.name} | ${pct(s.recall)} | ${pct(s.precision)} | ${pct(s.falseAlarmRate)} | ${pct(s.categoryAccuracy)} | ${r.failures} | ${p50 === null ? "–" : `${p50} / ${p95} ms`} | ${r.inputTokens} / ${r.outputTokens} |`,
    );
  }
  lines.push(``);

  for (const r of runs) {
    const o = outcomes(r, prepared, threshold);
    const s = score(o);
    lines.push(`## ${r.name}`, ``, `**Category threshold sweep** (sensitive items withhold regardless)`, ``, `| Threshold | Recall | Wrongly withheld |`, `|---|---|---|`);
    for (const t of THRESHOLDS) {
      const st = score(outcomes(r, prepared, t));
      lines.push(`| ${t}${t === threshold ? " (current)" : ""} | ${pct(st.recall)} | ${pct(st.falseAlarmRate)} |`);
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
    lines.push(``, `**Missed: shared but should be withheld** (${s.missed.length})`, ...s.missed.slice(0, 60).map(detail));
    lines.push(``, `**False alarms: withheld but should be shared** (${s.falseAlarms.length})`, ...s.falseAlarms.slice(0, 60).map(detail));
    const errs = o.filter((x) => x.modelError);
    if (errs.length) lines.push(``, `**Model errors** (${errs.length})`, ...errs.slice(0, 10).map((x) => `- \`${x.id}\`: ${x.modelError}`));
    lines.push(``);
  }
  return lines.join("\n");
}

function loadCases(): EvalCase[] {
  const read = (f: string) => (JSON.parse(readFileSync(f, "utf8")) as { cases: EvalCase[] }).cases;
  let cases = read(join(here, "dataset.json"));
  if (process.argv.includes("--external")) {
    const f = join(here, "external", "cases.json");
    if (!existsSync(f)) throw new Error("Run `npm run eval:import` first.");
    cases = [...cases, ...read(f)];
  }
  const docs = Number(arg("docs", "0"));
  if (docs > 0) {
    const f = join(here, "external", "redaction.json");
    if (!existsSync(f)) throw new Error("Run `npm run eval:import` first.");
    // Public finance documents with labelled sensitive values: every one should be withheld.
    const rc = (JSON.parse(readFileSync(f, "utf8")) as { cases: RedactionCase[] }).cases.filter((c) => c.required.length > 0);
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
  const concurrency = Number(arg("concurrency", "4"));
  const client = new BedrockRuntimeClient({ region, maxAttempts: 6 });
  const prepared = cases.map(prepare);
  console.log(`${cases.length} cases, models: ${models.join(", ")}, region ${region}`);

  const runs: Run[] = [{ name: "rules + detectors only (no model)", rulesOnly: true, answers: new Map(), inputTokens: 0, outputTokens: 0, failures: 0 }];
  for (const m of models) {
    console.log(`Running ${m}`);
    runs.push(await runModel(m, prepared, client, concurrency));
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
