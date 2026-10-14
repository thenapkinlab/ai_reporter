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

  it("shares a shop receipt with the card number removed", async () => {
    const d = await run("fx-card-receipt");
    expect(d.action).toBe("redacted");
    expect(d.because).toEqual(["card number"]);
    expect(d.filtered!.body).toBe("Thanks for your order of 2 books.\nPaid with card [removed: card number].\nTotal: $34.90");
  });

  it("removes keys, passwords and one-time codes", async () => {
    const key = await run("fx-aws-key");
    expect(key.because).toEqual(["password or key"]);
    expect(key.filtered!.body).not.toMatch(/AKIA|hunter2/);
    const otp = await run("fx-otp");
    expect(otp.filtered!.body).toBe("Your verification code is [removed: one-time code]. It expires in 10 minutes.");
  });

  const delivery = {
    id: "x2", from: "Shop <orders@shop.example>", subject: "Your delivery", date: "",
    snippet: "We'll deliver to Storgatan 12, lgh 1102,",
    body: "We'll deliver to Storgatan 12, lgh 1102,\n114 51 Stockholm on Friday between 9 and 13.", attachments: [],
  };
  const model = (values: { item: "home_address"; text: string }[], sensitive = ["home_address"] as const): Classifier => ({
    classify: async () => ({ category: "other", confidence: 0.9, sensitive: [...sensitive], reason: "delivery", source: "model", values }),
  });

  it("removes a value the model copied, even across a line break, and rebuilds the snippet", async () => {
    const d = await processEmail(delivery, deps({ classifier: model([{ item: "home_address", text: "Storgatan 12, lgh 1102, 114 51 Stockholm" }]) }));
    expect(d.action).toBe("redacted");
    expect(d.filtered!.body).toBe("We'll deliver to [removed: home address] on Friday between 9 and 13.");
    expect(d.filtered!.snippet).not.toContain("Storgatan");
  });

  it("withholds when a reported value can't be found or wasn't given (fail closed)", async () => {
    const wrong = await processEmail(delivery, deps({ classifier: model([{ item: "home_address", text: "Kungsgatan 3" }]) }));
    expect(wrong.action).toBe("withheld");
    expect(wrong.because).toContain("couldn't remove safely");
    const noValue = await processEmail(delivery, deps({ classifier: model([]) }));
    expect(noValue.action).toBe("withheld");
  });

  it("asks the model again instead of trusting a cached label with sensitive items", async () => {
    let calls = 0;
    const counting: Classifier = { classify: async () => (calls++, { category: "other", confidence: 0.9, sensitive: ["home_address"], reason: "", source: "model", values: [{ item: "home_address", text: "Storgatan 12, lgh 1102, 114 51 Stockholm" }] }) };
    const d = deps({ classifier: counting });
    await processEmail(delivery, d);
    const again = await processEmail(delivery, d);
    expect(calls).toBe(2);
    expect(again.action).toBe("redacted");
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
    expect(note).toContain("1 email shared with sensitive values removed");
    expect(note).toContain("(card number)");
    expect(note).toContain("1 email withheld (medical)");
    expect(note).not.toContain("lab results");
    expect(note).not.toContain("4111");
  });
});

describe("parseModelLabel", () => {
  it("parses JSON wrapped in prose and clamps confidence", () => {
    expect(parseModelLabel('Sure: {"category":"financial","confidence":1.4,"remove":[{"type":"bank_account","text":"12345678"},{"type":"nonsense","text":"x"}],"reason":"bank statement"}')).toEqual({
      category: "financial",
      confidence: 1,
      sensitive: ["bank_account"],
      reason: "bank statement",
      source: "model",
      values: [{ item: "bank_account", text: "12345678" }],
    });
  });
  it("rejects unknown categories", () => {
    expect(parseModelLabel('{"category":"legal","confidence":0.9}')).toBeNull();
  });
});
