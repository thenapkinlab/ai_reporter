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

  it("withholds a shop receipt that contains a card number", async () => {
    const d = await run("fx-card-receipt");
    expect(d.action).toBe("withheld");
    expect(d.label.category).toBe("other");
    expect(d.because).toEqual(["card number"]);
    expect(d.filtered).toBeUndefined();
  });

  it("withholds emails with keys, passwords or one-time codes", async () => {
    expect((await run("fx-aws-key")).because).toEqual(["password or key"]);
    expect((await run("fx-otp")).because).toEqual(["one-time code"]);
  });

  it("withholds when the model reports a sensitive item the patterns can't see", async () => {
    const email = {
      id: "x2", from: "Shop <orders@shop.example>", subject: "Your delivery", date: "", snippet: "",
      body: "We'll deliver to Storgatan 12, 114 51 Stockholm on Friday.", attachments: [],
    };
    const model: Classifier = { classify: async () => ({ category: "other", confidence: 0.9, sensitive: ["home_address"], reason: "delivery address", source: "model" }) };
    const d = await processEmail(email, deps({ classifier: model }));
    expect(d.action).toBe("withheld");
    expect(d.because).toEqual(["home address"]);
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
    const model: Classifier = { classify: async () => ({ category: "medical", confidence: 0.82, sensitive: [], reason: "doctor follow-up", source: "model" }) };
    const viaModel = await processEmail(ambiguous, deps({ classifier: model }));
    expect(viaModel.label.source).toBe("model");
    expect(viaModel.action).toBe("withheld");

    const broken: Classifier = { classify: async () => { throw new Error("down"); } };
    const viaFallback = await processEmail(ambiguous, deps({ classifier: broken }));
    expect(viaFallback.label.source).toBe("fallback");
    // Fails closed: an email with medical hints is withheld when the model is unavailable.
    expect(viaFallback.action).toBe("withheld");
  });

  it("writes a note with counts and reasons only", async () => {
    const ds = await Promise.all(["fx-lab", "fx-card-receipt", "fx-flight"].map((id) => run(id)));
    const note = filterNote(ds);
    expect(note).toContain("2 emails withheld");
    expect(note).toContain("medical, card number");
    expect(note).not.toContain("lab results");
    expect(note).not.toContain("4111");
  });
});

describe("parseModelLabel", () => {
  it("parses JSON wrapped in prose and clamps confidence", () => {
    expect(parseModelLabel('Sure: {"category":"financial","confidence":1.4,"sensitive":["bank_account","nonsense"],"reason":"bank statement"}')).toEqual({
      category: "financial",
      confidence: 1,
      sensitive: ["bank_account"],
      reason: "bank statement",
      source: "model",
    });
  });
  it("rejects unknown categories", () => {
    expect(parseModelLabel('{"category":"legal","confidence":0.9}')).toBeNull();
  });
});
