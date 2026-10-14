import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findValue, redactEmail, redactText } from "../src/filter/redactor";
import { integrityOk, leakOf, uniqueTokens, type RedactCase } from "../eval/redactor";

describe("redactor", () => {
  it("removes detector hits and model values, merging overlaps", () => {
    const text = "Card 4111 1111 1111 1111, ship to 12 Elm St, Leeds LS6 2AB.";
    expect(redactText(text, [{ item: "home_address", text: "12 Elm St, Leeds LS6 2AB" }])).toBe(
      "Card [removed: card number], ship to [removed: home address].",
    );
  });

  it("finds values despite changed line breaks, commas and case", () => {
    expect(findValue("Storgatan 12, lgh 1102,\n114 51 Stockholm", "storgatan 12 lgh 1102 114 51 stockholm")).toHaveLength(1);
    expect(findValue("Storgatan 12", "Storgatan 13")).toHaveLength(0);
  });

  it("removes every occurrence, in the subject too, and rebuilds the snippet", () => {
    const r = redactEmail({
      subject: "Delivery to 9 Pine Road",
      body: "We'll come to 9 Pine Road at noon.",
      attachmentText: "",
      values: [{ item: "home_address", text: "9 Pine Road" }],
    });
    expect(r.subject).toBe("Delivery to [removed: home address]");
    expect(r.snippet).toBe("We'll come to [removed: home address] at noon.");
    expect(r.missing).toEqual([]);
  });

  it("reports values it can't find, and accepts values found only in attachments", () => {
    const r = redactEmail({ subject: "s", body: "b", attachmentText: "Tenant address: 1 Main St", values: [{ item: "home_address", text: "1 Main St" }, { item: "date_of_birth", text: "01/01/1990" }] });
    expect(r.missing.map((m) => m.item)).toEqual(["date_of_birth"]);
  });
});

describe("redaction benchmark scoring", () => {
  const original = "Deliver to Storgatan 12, lgh 1102, 114 51 Stockholm. Our office is in Stockholm.";
  const value = "Storgatan 12, lgh 1102, 114 51 Stockholm";

  it("counts full and partial leaks, ignoring tokens that appear elsewhere", () => {
    expect(uniqueTokens(value, original)).toEqual(["Storgatan", "lgh", "1102", "114"]);
    expect(leakOf(value, original, "Call 0114 5100")).toBe("none");
    expect(leakOf(value, original, "Deliver to [removed: home address]. Our office is in Stockholm.")).toBe("none");
    expect(leakOf(value, original, "Deliver to [removed: home address], lgh 1102.")).toBe("partial");
    expect(leakOf(value, original, original)).toBe("full");
    expect(leakOf(value, original, null)).toBe("none");
  });

  it("checks that only [removed: …] markers changed", () => {
    expect(integrityOk("Paid with 4111 1111 1111 1111 today", "Paid with [removed: card number] today")).toBe(true);
    expect(integrityOk("Paid with 4111 1111 1111 1111 today", "Paid with [removed: card number] yesterday")).toBe(false);
  });

  it("has a consistent hand-written set", () => {
    const { cases } = JSON.parse(readFileSync("eval/redaction-set.json", "utf8")) as { cases: RedactCase[] };
    const ids = new Set(cases.map((c) => c.id));
    expect(ids.size).toBe(cases.length);
    for (const c of cases) {
      const all = `${c.subject}\n${c.body}\n${(c.attachments ?? []).map((a) => a.text).join("\n")}`;
      for (const v of c.remove) expect(all, c.id).toContain(v.value);
      for (const k of [...c.keep, ...c.notSensitive]) expect(`${c.subject}\n${c.body}`, c.id).toContain(k);
      if (c.expect === "share") expect(c.remove, c.id).toEqual([]);
    }
  });
});
