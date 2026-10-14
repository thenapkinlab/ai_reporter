// Classifier evaluation: runs the labelled test set through the filter with each candidate
// Bedrock model (plus a rules-only baseline) and writes a comparison report.
//
//   npm run eval                                   # default models
//   npm run eval -- --models eu.amazon.nova-micro-v1:0,eu.amazon.nova-lite-v1:0
//   npm run eval -- --tags adversarial --limit 10
//
// Needs AWS credentials (aws login) with Bedrock access in --region (default eu-north-1).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockClassifier, type CallInfo } from "../src/aws/bedrock";
import type { Label } from "../src/filter/classifier";
import {
  accuracyByTag,
  confusion,
  percentile,
  pipelineLabel,
  pipelineLabelModelOnAll,
  prepare,
  redactionCheck,
  score,
  type EvalCase,
  type Outcome,
  type Prepared,
} from "./score";

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

interface ModelRun {
  model: string;
  outcomes: Outcome[];
  inputTokens: number;
  outputTokens: number;
  failures: number;
}

async function runModel(model: string, prepared: Prepared[], client: BedrockRuntimeClient, concurrency: number): Promise<ModelRun> {
  let inputTokens = 0;
  let outputTokens = 0;
  let failures = 0;
  const outcomes = await mapLimit(prepared, concurrency, async (p) => {
    let last: CallInfo | null = null;
    const classifier = new BedrockClassifier(model, client, (info) => {
      last = info;
      inputTokens += info.inputTokens;
      outputTokens += info.outputTokens;
    });
    let label: Label | null = null;
    let error: string | null = null;
    try {
      label = await classifier.classify({ from: p.c.from, subject: p.c.subject, text: p.text });
    } catch (e) {
      failures++;
      error = e instanceof Error ? e.message : String(e);
    }
    process.stdout.write(label ? "." : "x");
    return {
      id: p.c.id,
      tags: p.c.tags,
      expected: p.c.expected,
      pipeline: pipelineLabel(p, label),
      model: label,
      modelError: error,
      latencyMs: (last as CallInfo | null)?.latencyMs ?? null,
    };
  });
  process.stdout.write("\n");
  return { model, outcomes, inputTokens, outputTokens, failures };
}

function rulesOnly(prepared: Prepared[]): ModelRun {
  const outcomes = prepared.map((p) => ({
    id: p.c.id,
    tags: p.c.tags,
    expected: p.c.expected,
    pipeline: pipelineLabel(p, null),
    model: null,
    modelError: null,
    latencyMs: null,
  }));
  return { model: "rules-only (no model)", outcomes, inputTokens: 0, outputTokens: 0, failures: 0 };
}

const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(1)}%`);

function report(runs: ModelRun[], prepared: Prepared[], threshold: number): string {
  const lines: string[] = [];
  const n = prepared.length;
  lines.push(`# Classifier evaluation`, ``, `${new Date().toISOString()} · ${n} cases · withhold threshold ${threshold}`, ``);

  lines.push(`## Summary`, ``);
  lines.push(`| Model | Recall (sensitive withheld) | Precision | Pipeline accuracy | Model-only accuracy | Model failures | Latency p50 / p95 | Tokens in / out |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of runs) {
    const s = score(r.outcomes, threshold);
    const lat = r.outcomes.map((o) => o.latencyMs).filter((x): x is number => x !== null);
    const p50 = percentile(lat, 0.5), p95 = percentile(lat, 0.95);
    lines.push(
      `| ${r.model} | ${pct(s.recall)} | ${pct(s.precision)} | ${pct(s.pipelineAccuracy)} | ${pct(s.modelAccuracy)} | ${r.failures} | ${p50 === null ? "–" : `${p50} / ${p95} ms`} | ${r.inputTokens} / ${r.outputTokens} |`,
    );
  }

  const red = redactionCheck(prepared);
  lines.push(``, `**Redaction detectors** (no model involved): ${red.found}/${red.required} required values found${red.misses.length ? `; missed: ${red.misses.join(", ")}` : ""}.`, ``);

  for (const r of runs) {
    const s = score(r.outcomes, threshold);
    lines.push(`## ${r.model}`, ``);
    lines.push(`**Threshold sweep**`, ``, `| Threshold | Recall | Precision |`, `|---|---|---|`);
    for (const t of THRESHOLDS) {
      const st = score(r.outcomes, t);
      lines.push(`| ${t}${t === threshold ? " (current)" : ""} | ${pct(st.recall)} | ${pct(st.precision)} |`);
    }
    lines.push(``, `**Accuracy by type**`, ``, `| Tag | Correct |`, `|---|---|`);
    for (const [tag, v] of Object.entries(accuracyByTag(r.outcomes)).sort()) {
      lines.push(`| ${tag} | ${v.correct}/${v.n} |`);
    }
    const m = confusion(r.outcomes);
    lines.push(``, `**Confusion matrix** (rows = expected, columns = pipeline)`, ``, `| | medical | financial | other |`, `|---|---|---|---|`);
    for (const e of ["medical", "financial", "other"] as const) {
      lines.push(`| ${e} | ${m[e].medical} | ${m[e].financial} | ${m[e].other} |`);
    }
    const byId = new Map(r.outcomes.map((o) => [o.id, o]));
    const detail = (id: string) => {
      const o = byId.get(id)!;
      return `- \`${id}\` expected ${o.expected}, got ${o.pipeline.category} ${o.pipeline.confidence.toFixed(2)} (${o.pipeline.source}) — ${o.pipeline.reason}`;
    };
    lines.push(``, `**Missed (sensitive but shared)**: ${s.missed.length}`, ...s.missed.map(detail));
    lines.push(``, `**False alarms (withheld but not sensitive)**: ${s.falseAlarms.length}`, ...s.falseAlarms.map(detail));
    const errs = r.outcomes.filter((o) => o.modelError);
    if (errs.length) lines.push(``, `**Model errors**`, ...errs.map((o) => `- \`${o.id}\`: ${o.modelError}`));
    lines.push(``);
  }
  return lines.join("\n");
}

async function main() {
  const data = JSON.parse(readFileSync(join(here, "dataset.json"), "utf8")) as { cases: EvalCase[] };
  const tagFilter = arg("tags");
  const limit = Number(arg("limit", "0"));
  let cases = data.cases;
  if (tagFilter) cases = cases.filter((c) => tagFilter.split(",").some((t) => c.tags.includes(t)));
  if (limit > 0) cases = cases.slice(0, limit);

  const models = (arg("models") ?? DEFAULT_MODELS.join(",")).split(",").filter(Boolean);
  const region = arg("region", "eu-north-1")!;
  const threshold = Number(arg("threshold", "0.6"));
  const concurrency = Number(arg("concurrency", "4"));
  const client = new BedrockRuntimeClient({ region, maxAttempts: 6 });

  const prepared = cases.map(prepare);
  console.log(`${cases.length} cases, models: ${models.join(", ")}, region ${region}`);

  const runs: ModelRun[] = [rulesOnly(prepared)];
  const byId = new Map(prepared.map((p) => [p.c.id, p]));
  for (const m of models) {
    console.log(`Running ${m}`);
    const r = await runModel(m, prepared, client, concurrency);
    runs.push(r);
    // Same model answers, scored as if the model saw every email (see pipelineLabelModelOnAll).
    runs.push({
      ...r,
      model: `${m} · model on every email`,
      outcomes: r.outcomes.map((o) => ({ ...o, pipeline: pipelineLabelModelOnAll(byId.get(o.id)!, o.model) })),
    });
  }

  const md = report(runs, prepared, threshold);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(here, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${stamp}.md`), md);
  writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify(runs, null, 2));
  console.log(`\n${md.split("## ")[1] ? "## " + md.split("## ")[1] : md}`);
  console.log(`Full report: eval/results/${stamp}.md`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
