// Redaction benchmark: runs the detectors (no model, no AWS) over the Gretel texts built by
// `npm run eval:import` and reports, per value type, how many labelled values were found.
//
//   npm run eval:redaction

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detect, type DetectorType } from "../src/filter/detectors";
import type { RedactionCase } from "./import";

const here = dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(readFileSync(join(here, "external", "redaction.json"), "utf8")) as { cases: RedactionCase[] };

const perType = new Map<DetectorType, { required: number; found: number; examples: string[] }>();
const perLang = new Map<string, { required: number; found: number }>();
const gaps = new Map<string, number>();

for (const c of cases) {
  const hits = detect(c.text);
  const lang = c.tags.find((t) => t.startsWith("lang:")) ?? "?";
  for (const r of c.required) {
    const start = c.text.indexOf(r.value);
    const found = hits.some((h) => h.type === r.type && start >= 0 && h.start < start + r.value.length && h.end > start);
    const t = perType.get(r.type) ?? { required: 0, found: 0, examples: [] };
    t.required++;
    if (found) t.found++;
    else if (t.examples.length < 3) t.examples.push(`${c.id}: "${r.value}"`);
    perType.set(r.type, t);
    const l = perLang.get(lang) ?? { required: 0, found: 0 };
    l.required++;
    if (found) l.found++;
    perLang.set(lang, l);
  }
  for (const g of c.gaps) gaps.set(g, (gaps.get(g) ?? 0) + 1);
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "–");
console.log(`# Redaction benchmark · ${cases.length} texts\n`);
console.log(`| Value type | Found | Recall | Missed examples |\n|---|---|---|---|`);
for (const [type, t] of [...perType].sort()) console.log(`| ${type} | ${t.found}/${t.required} | ${pct(t.found, t.required)} | ${t.examples.join("; ")} |`);
console.log(`\n| Language | Recall |\n|---|---|`);
for (const [lang, l] of [...perLang].sort()) console.log(`| ${lang} | ${pct(l.found, l.required)} (${l.found}/${l.required}) |`);
console.log(`\n**Not detected yet** (labelled values in these texts): ${[...gaps].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join(", ")}`);
