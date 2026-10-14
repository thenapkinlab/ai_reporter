// Detector benchmark: runs the detectors (no model, no AWS) over the Gretel texts built by
// `npm run eval:import` and reports recall per sensitive item, per Gretel label and per language.
// A value counts as found when a detector for the same item overlaps it.
//
//   npm run eval:redaction

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detect } from "../src/filter/detectors";
import { DETECTOR_ITEM } from "../src/filter/classifier";
import type { RedactionCase } from "./import";

const here = dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(readFileSync(join(here, "external", "redaction.json"), "utf8")) as { cases: RedactionCase[] };

type Tally = { required: number; found: number; examples: string[] };
const tally = (m: Map<string, Tally>, key: string, found: boolean, example: string) => {
  const t = m.get(key) ?? { required: 0, found: 0, examples: [] };
  t.required++;
  if (found) t.found++;
  else if (t.examples.length < 3) t.examples.push(example);
  m.set(key, t);
};
const perItem = new Map<string, Tally>();
const perLabel = new Map<string, Tally>();
const perLang = new Map<string, Tally>();
const gaps = new Map<string, number>();
let textsWithHit = 0, textsWithRequired = 0;

for (const c of cases) {
  const hits = detect(c.text);
  const lang = c.tags.find((t) => t.startsWith("lang:")) ?? "?";
  if (c.required.length) {
    textsWithRequired++;
    if (hits.length) textsWithHit++;
  }
  for (const r of c.required) {
    const start = c.text.indexOf(r.value);
    const found = hits.some((h) => DETECTOR_ITEM[h.type] === r.item && start >= 0 && h.start < start + r.value.length && h.end > start);
    const example = `${c.id}: "${r.value.slice(0, 40)}"`;
    tally(perItem, r.item, found, example);
    tally(perLabel, r.label, found, example);
    tally(perLang, lang, found, example);
  }
  for (const g of c.gaps) gaps.set(g, (gaps.get(g) ?? 0) + 1);
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "–");
const table = (title: string, m: Map<string, Tally>, examples: boolean) => {
  console.log(`\n| ${title} | Found | Recall |${examples ? " Missed examples |" : ""}\n|---|---|---|${examples ? "---|" : ""}`);
  for (const [k, t] of [...m].sort()) console.log(`| ${k} | ${t.found}/${t.required} | ${pct(t.found, t.required)} |${examples ? ` ${t.examples.join("; ")} |` : ""}`);
};
console.log(`# Detector benchmark · ${cases.length} texts`);
console.log(`\nRecall = labelled values found / labelled values. Texts with at least one detector hit (would be withheld without the model): ${pct(textsWithHit, textsWithRequired)} (${textsWithHit}/${textsWithRequired}).`);
table("Sensitive item", perItem, false);
table("Gretel label", perLabel, true);
table("Language", perLang, false);
console.log(`\n**Not scored** (outside the policy, or left to the model): ${[...gaps].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join(", ")}`);
