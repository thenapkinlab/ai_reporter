// Optional: sends classifier benchmark results to Langfuse (npm run eval -- --langfuse), so prompt
// versions and models can be compared side by side. Nothing in src/ imports this or the SDK.
// The gateway's own log to Langfuse is separate and carries no content: see src/trace.ts.
//
// No email text ever leaves this machine, not even from made-up cases:
//   scores   case ID, tags, decision, category and scores (dev)
//   totals   one row of run totals, no per-case data (validation and test, so their mistakes can't be read)
// To read a case's text, look its ID up in eval/dataset.json or eval/external/.
//
// Keys go in .env (git-ignored): LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, optional LANGFUSE_BASE_URL.
// Runs after the report is written; a Langfuse failure never affects the benchmark.

import { existsSync } from "node:fs";
import { PROMPT_VERSION } from "../src/filter/classifier";
import { score, type Outcome, type Prepared } from "./score";

export type Split = "dev" | "holdout" | "test";

export interface RunTotals {
  name: string;
  inputTokens: number;
  outputTokens: number;
  failures: number;
  retries: number;
}

export function caseInput(p: Prepared): Record<string, unknown> {
  return { caseId: p.c.id, tags: p.c.tags };
}

// Not the model's reason or values: they can quote the email.
export function caseOutput(o: Outcome): Record<string, unknown> {
  return { verdict: o.verdict, withheld: o.withheld, category: o.label.category, confidence: o.label.confidence, source: o.label.source };
}

export function runTotals(run: RunTotals, outcomes: Outcome[]): Record<string, number | null> {
  const { scored, recall, precision, fpr, categoryAccuracy, tp, fn, fp, tn } = score(outcomes);
  return { scored, recall, precision, fpr, category_accuracy: categoryAccuracy, tp, fn, fp, tn, input_tokens: run.inputTokens, output_tokens: run.outputTokens, unanswered: run.failures, retries: run.retries };
}

/** Called before the benchmark starts: the SDK swallows export failures, so bad keys or a dead URL must show up here. */
export async function checkLangfuse(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const { LANGFUSE_PUBLIC_KEY: pub, LANGFUSE_SECRET_KEY: secret } = process.env;
  if (!pub || !secret) throw new Error("--langfuse needs LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in .env");
  const base = (process.env.LANGFUSE_BASE_URL ??= "https://cloud.langfuse.com"); // EU
  const res = await fetch(`${base}/api/public/projects`, { headers: { authorization: `Basic ${Buffer.from(`${pub}:${secret}`).toString("base64")}` } });
  if (!res.ok) throw new Error(`Langfuse rejected the keys in .env (HTTP ${res.status})`);
}

const scores = (totals: Record<string, number | null>) =>
  Object.entries(totals).flatMap(([name, value]) => (value === null ? [] : [{ name, value }]));

export async function uploadToLangfuse(split: Split, stamp: string, threshold: number, prepared: Prepared[], runs: { run: RunTotals; outcomes: Outcome[] }[]): Promise<void> {
  const [{ LangfuseClient }, { LangfuseSpanProcessor }, { NodeSDK }] = await Promise.all([
    import("@langfuse/client"),
    import("@langfuse/otel"),
    import("@opentelemetry/sdk-node"),
  ]);
  const otel = new NodeSDK({ autoDetectResources: false, serviceName: "agent-gateway-eval", spanProcessors: [new LangfuseSpanProcessor()] });
  otel.start();
  const langfuse = new LangfuseClient();
  const datasetName = "classifier-dev";
  try {
    const metadata = { prompt: PROMPT_VERSION, threshold, split, stamp };
    if (split !== "dev") {
      for (const { run, outcomes } of runs) {
        const totals = runTotals(run, outcomes);
        await langfuse.experiment.run({
          name: `classifier-${split}`,
          runName: `${run.name} ${PROMPT_VERSION} ${stamp}`,
          metadata,
          data: [{ input: { split, cases: outcomes.length, model: run.name } }],
          task: async () => totals,
          evaluators: [async () => scores(totals)],
        });
      }
      return;
    }

    if (!(await langfuse.dataset.get(datasetName).catch(() => null))) {
      await langfuse.api.datasets.create({ name: datasetName, description: "Dev split of the share-or-withhold benchmark: case IDs and scores, no email text." });
    }
    const itemId = (id: string) => `${datasetName}-${id}`;
    for (let i = 0; i < prepared.length; i += 20) {
      await Promise.all(
        prepared.slice(i, i + 20).map((p) =>
          langfuse.dataset.createItem({
            datasetName,
            id: itemId(p.c.id),
            input: caseInput(p),
            expectedOutput: { category: p.c.expected },
            metadata: { caseId: p.c.id, tags: p.c.tags },
          }),
        ),
      );
    }
    const ids = new Set(prepared.map((p) => itemId(p.c.id)));
    // Earlier runs may have added other items; compare only what this run scored.
    const items = (await langfuse.dataset.get(datasetName)).items.filter((item) => ids.has(item.id));

    for (const { run, outcomes } of runs) {
      const byId = new Map(outcomes.map((o) => [o.id, o]));
      const of = (item: { metadata?: unknown }) => byId.get((item.metadata as { caseId: string }).caseId)!;
      await langfuse.experiment.run({
        name: datasetName,
        runName: `${run.name} ${PROMPT_VERSION} ${stamp}`,
        metadata,
        data: items,
        maxConcurrency: 20,
        task: async (item) => caseOutput(of(item)),
        evaluators: [
          async ({ metadata: m }) => {
            const o = byId.get((m as { caseId: string }).caseId)!;
            if (o.tags.includes("ambiguous")) return [];
            const out = [{ name: "correct", value: o.withheld === o.expectWithhold ? 1 : 0 }];
            if (o.model && !o.tags.includes("no-category")) out.push({ name: "category_correct", value: o.model.category === o.expected ? 1 : 0 });
            return out;
          },
        ],
        runEvaluators: [async () => scores(runTotals(run, outcomes))],
      });
    }
  } finally {
    await langfuse.shutdown().catch(() => {});
    await otel.shutdown().catch(() => {});
  }
}
