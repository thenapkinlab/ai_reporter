import { describe, expect, it } from "vitest";
import { filterNote, processEmail, type EngineDeps, type Policy } from "../src/filter/engine";
import { parseModelLabel, type Classifier, type Label } from "../src/filter/classifier";
import { FixtureMailbox } from "../src/fixtures";

function policy(over: Partial<Policy> = {}): Policy {
  return {
    withhold: new Set(["medical", "financial"]),
    threshold: 0.6,
    releasedMessages: new Set(),
    releasedSenders: new Set(),
    ...over,
  };
}

function deps(over: Partial<EngineDeps> = {}): EngineDeps {
  const cache = new Map<string, Label>();
  return {
    classifier: null,
    extractText: async () => null,
    cache: { get: async (id) => cache.get(id) ?? null, put: async (id, l) => void cache.set(id, l) },
    policy: policy(),
    ...over,
  };
}

const mailbox = new FixtureMailbox();
const run = async (id: string, d = deps()) => processEmail(await mailbox.get(id), d);

describe("filter engine on synthetic mail", () => {
  it("withholds lab results as medical", async () => {
    const d = await run("fx-lab");
    expect(d.action).toBe("withheld");
    expect(d.label.category).toBe("medical");
    expect(d.filtered).toBeUndefined();
  });

  it("withholds a bank statement as financial, using the attachment too", async () => {
    const d = await run("fx-statement");
    expect(d.action).toBe("withheld");
    expect(d.label.category).toBe("financial");
    expect(d.hits.map((h) => h.type)).toContain("iban");
  });

  it("shares a shop receipt but redacts the card number", async () => {
    const d = await run("fx-card-receipt");
    expect(d.action).toBe("redacted");
    expect(d.label.category).toBe("other");
    expect(d.filtered?.body).toContain("[REDACTED: card number]");
    expect(d.filtered?.body).not.toContain("4111");
    expect(d.filtered?.snippet).not.toContain("4111");
  });

  it("redacts keys and passwords in a normal email", async () => {
    const d = await run("fx-aws-key");
    expect(d.action).toBe("redacted");
    expect(d.filtered?.body).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(d.filtered?.body).not.toContain("hunter2");
  });

  it("leaves a health newsletter and a flight confirmation alone", async () => {
    expect((await run("fx-newsletter")).action).toBe("shared");
    expect((await run("fx-flight")).action).toBe("shared");
  });

  it("respects a release for one message", async () => {
    const d = await run("fx-lab", deps({ policy: policy({ releasedMessages: new Set(["fx-lab"]) }) }));
    expect(d.action).toBe("shared");
  });

  it("respects a turned-off category", async () => {
    const d = await run("fx-lab", deps({ policy: policy({ withhold: new Set(["financial"]) }) }));
    expect(d.action).not.toBe("withheld");
  });

  it("uses the model for unclear emails and falls back to rules if it fails", async () => {
    const ambiguous = {
      id: "x1",
      from: "Dr. Rao <rao@clinic.example>",
      subject: "Follow-up",
      date: "",
      snippet: "",
      body: "Following your visit, please continue the prescription for two more weeks.",
      attachments: [],
    };
    const model: Classifier = { classify: async () => ({ category: "medical", confidence: 0.82, reason: "doctor follow-up", source: "model" }) };
    const viaModel = await processEmail(ambiguous, deps({ classifier: model }));
    expect(viaModel.label.source).toBe("model");
    expect(viaModel.action).toBe("withheld");

    const broken: Classifier = { classify: async () => { throw new Error("down"); } };
    const viaFallback = await processEmail(ambiguous, deps({ classifier: broken }));
    expect(viaFallback.label.source).toBe("fallback");
  });

  it("writes a note with counts only", async () => {
    const ds = await Promise.all(["fx-lab", "fx-card-receipt", "fx-flight"].map((id) => run(id)));
    const note = filterNote(ds);
    expect(note).toContain("1 email withheld (medical)");
    expect(note).toContain("redacted");
    expect(note).not.toContain("lab results");
  });
});

describe("parseModelLabel", () => {
  it("parses JSON wrapped in prose and clamps confidence", () => {
    expect(parseModelLabel('Sure: {"category":"financial","confidence":1.4,"reason":"bank statement"}')).toEqual({
      category: "financial",
      confidence: 1,
      reason: "bank statement",
      source: "model",
    });
  });
  it("rejects unknown categories", () => {
    expect(parseModelLabel('{"category":"legal","confidence":0.9}')).toBeNull();
  });
});
