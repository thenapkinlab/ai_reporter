// Runs one email through detectors, signals and the classifier, then decides: share the
// email unchanged, share it with sensitive values removed, or withhold it whole (medical or
// financial emails, or when removal can't be verified). Also produces the audit record (no content).

import { detect, type Hit, DETECTOR_LABELS } from "./detectors";
import { computeSignals, isCandidate, type Signals } from "./signals";
import {
  DETECTOR_ITEM,
  ITEM_LABELS,
  ModelBusyError,
  fallbackLabel,
  ruleLabel,
  type Category,
  type ClassifyInput,
  type Classifier,
  type Label,
  type SensitiveItem,
} from "./classifier";
import { logError, logEvent } from "../logging";
import { redactEmail } from "./redactor";
import { sensitiveDocumentName } from "./signals";
import { senderDomain, type Email } from "../mail";

const MAX_TEXT_CHARS = 20000;
/** The body is cut here before anything else, so the assistant can only receive text the filter has checked. */
const MAX_BODY_CHARS = 18000;
const CUT_NOTE = "\n[Rest of this email not shown: too long for the privacy filter to check.]";
/** How much of an email a batch shows the model. A cached label from a batch says nothing about text past this. */
export const BATCH_CHECKED_CHARS = 4000;
export const DOCUMENT_NAME = "sensitive document name";
const DOCUMENT_PLACEHOLDER = "[removed: document name]";

export interface Policy {
  withhold: Set<Category>;
  threshold: number;
  releasedMessages: Set<string>;
  releasedSenders: Set<string>;
}

export interface LabelCache {
  get(messageId: string): Promise<Label | null>;
  put(messageId: string, label: Label): Promise<void>;
}

export interface EngineDeps {
  classifier: Classifier | null;
  cache: LabelCache;
  policy: Policy;
  /** Emails per model request; defaults to BATCH_SIZE. */
  batchSize?: number;
}

export type Action = "shared" | "redacted" | "withheld";

export interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
}

export interface FilteredEmail {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  attachments: AttachmentInfo[];
}

export interface Decision {
  messageId: string;
  senderDomain: string;
  action: Action;
  label: Label;
  hits: Hit[];
  /** Why it was withheld or redacted, e.g. ["financial"] or ["home address"]. Empty when shared unchanged. */
  because: string[];
  /** Present when shared or redacted: what the assistant receives. */
  filtered?: FilteredEmail;
}

export interface DecideInput {
  label: Label;
  rule: Label | null;
  hits: Hit[];
  modelFailed: boolean;
  /** The email had medical/financial hints or attachments. Kept for the evaluation; no longer changes the decision. */
  candidate: boolean;
  released: boolean;
  policy: Policy;
}

export type Verdict = "share" | "redact" | "withhold";

export const MODEL_UNAVAILABLE = "unchecked (model unavailable)";

/**
 * Withhold whole: a withheld category (from the model or a clear rule), or (fail closed) the
 * model was unavailable. Otherwise, redact any sensitive item
 * the model reports or a pattern detector proves. A user's "release" overrides all of it.
 */
export function decide(i: DecideInput): { verdict: Verdict; because: string[] } {
  if (i.released) return { verdict: "share", because: [] };
  const p = i.policy;
  const categories: string[] = [];
  // Without the model the label is only a guess from keywords, so it mustn't be reported as the reason.
  for (const l of i.modelFailed ? [i.rule] : [i.label, i.rule]) {
    if (l && l.category !== "other" && p.withhold.has(l.category) && l.confidence >= p.threshold && !categories.includes(l.category))
      categories.push(l.category);
  }
  if (categories.length) return { verdict: "withhold", because: categories };
  // Removing values depends on the model, so without it nothing can be shared safely.
  if (i.modelFailed) return { verdict: "withhold", because: [MODEL_UNAVAILABLE] };
  const items = new Set<SensitiveItem>([...i.label.sensitive, ...i.hits.map((h) => DETECTOR_ITEM[h.type])]);
  if (items.size) return { verdict: "redact", because: [...items].map((x) => ITEM_LABELS[x]) };
  return { verdict: "share", because: [] };
}

/** Emails per model request. Bedrock limits requests per minute far more tightly than tokens. */
export const BATCH_SIZE = 10;

interface PreparedEmail {
  email: Email;
  domain: string;
  text: string;
  hits: Hit[];
  signals: Signals;
  cached: Label | null;
}

// Attachments are never opened: their contents never reach the assistant, so they don't need
// checking. Their names do reach it, so names are classified and redacted like the body.
async function prepareEmail(original: Email, deps: EngineDeps): Promise<PreparedEmail> {
  const email = original.body.length > MAX_BODY_CHARS ? { ...original, body: original.body.slice(0, MAX_BODY_CHARS) + CUT_NOTE } : original;
  const domain = senderDomain(email.from);
  const names = email.attachments.map((a) => a.filename);
  // Names come before the body, so the model still sees them when a long email is cut short.
  const text = `${email.subject}\n${names.length ? `[Attachment names: ${names.join(", ")}]\n` : ""}${email.body}`.slice(0, MAX_TEXT_CHARS);
  const hits = [...detect(email.subject), ...detect(email.snippet), ...detect(email.body), ...names.flatMap((n) => detect(n))];
  const cached = await deps.cache.get(email.id);
  return {
    email,
    domain,
    text,
    hits,
    signals: computeSignals(domain, text, hits),
    // A cached label has item types but no values, so it can't drive redaction: only labels
    // without sensitive items are reused; the rest go back to the model.
    // Nor is a label reused for a long email: it may come from a batch that only read the start.
    cached: cached && cached.sensitive.length === 0 && text.length <= BATCH_CHECKED_CHARS ? cached : null,
  };
}

function finish(pe: PreparedEmail, label: Label, modelFailed: boolean, deps: EngineDeps): Decision {
  const { email, domain, hits } = pe;
  const p = deps.policy;
  const released = p.releasedMessages.has(email.id) || (domain !== "" && p.releasedSenders.has(domain));
  const { verdict, because } = decide({
    label,
    rule: ruleLabel(pe.signals),
    hits,
    modelFailed,
    candidate: isCandidate(pe.signals, email.attachments.length > 0),
    released,
    policy: p,
  });
  const base = { messageId: email.id, senderDomain: domain, label, hits, because };
  if (verdict === "withhold") return { ...base, action: "withheld" };
  const filtered: FilteredEmail = {
    id: email.id,
    from: email.from,
    subject: email.subject,
    date: email.date,
    snippet: email.snippet,
    body: email.body,
    attachments: email.attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.size })),
  };
  const documents = !released && email.attachments.some((a) => sensitiveDocumentName(a.filename));
  const hideDocuments = <T extends { filename: string }>(atts: T[]) => atts.map((a) => (sensitiveDocumentName(a.filename) ? { ...a, filename: DOCUMENT_PLACEHOLDER } : a));
  if (verdict === "share") {
    if (!documents) return { ...base, action: "shared", filtered };
    return { ...base, because: [...because, DOCUMENT_NAME], action: "redacted", filtered: { ...filtered, attachments: hideDocuments(filtered.attachments) } };
  }

  // Every item the model reported must be removable: either it gave the value, or a detector found it.
  const values = label.values ?? [];
  const detected = new Set(hits.map((h) => DETECTOR_ITEM[h.type]));
  const unremovable = label.sensitive.filter((item) => !detected.has(item) && !values.some((v) => v.item === item));
  const r = redactEmail({ subject: email.subject, body: email.body, attachmentNames: email.attachments.map((a) => a.filename), values });
  if (unremovable.length || r.missing.length) {
    return { ...base, because: [...because, "couldn't remove safely"], action: "withheld" };
  }
  const attachments = hideDocuments(filtered.attachments.map((a, i) => ({ ...a, filename: r.attachmentNames[i] ?? a.filename })));
  return { ...base, because: documents ? [...because, DOCUMENT_NAME] : because, action: "redacted", filtered: { ...filtered, subject: r.subject, body: r.body, snippet: r.snippet, attachments } };
}

/**
 * Decides several emails with as few model requests as possible: cached labels are reused,
 * the rest are labelled in batches of BATCH_SIZE. Any email the model didn't answer for is
 * treated as "model unavailable" and withheld. Throws ModelBusyError if the shared model budget
 * is used up, so the caller can ask the assistant to retry instead of withholding everything.
 */
export async function processEmails(emails: Email[], deps: EngineDeps): Promise<Decision[]> {
  const prepared = await Promise.all(emails.map((e) => prepareEmail(e, deps)));
  const results: { label: Label; modelFailed: boolean }[] = prepared.map((pe) =>
    pe.cached ? { label: pe.cached, modelFailed: false } : { label: fallbackLabel(pe.signals), modelFailed: false },
  );
  const todo = prepared.map((pe, i) => ({ pe, i })).filter((x) => !x.pe.cached);
  const classifier = deps.classifier;

  if (!classifier) {
    for (const { pe, i } of todo) results[i] = { label: ruleLabel(pe.signals) ?? fallbackLabel(pe.signals), modelFailed: false };
  } else {
    const size = deps.batchSize ?? BATCH_SIZE;
    for (let start = 0; start < todo.length; start += size) {
      const chunk = todo.slice(start, start + size);
      const inputs = chunk.map(({ pe }) => ({ from: pe.email.from, subject: pe.email.subject, text: pe.text }));
      const labels = await ask(classifier, inputs);
      // The model occasionally garbles a batch, or one email's answer uses up the output limit.
      // Asking again in two halves keeps one bad email from sinking the rest. Costs requests only when something went wrong.
      const missing = labels.flatMap((l, j) => (l ? [] : [j]));
      if (missing.length) {
        const half = Math.ceil(missing.length / 2);
        const groups = [missing.slice(0, half), missing.slice(half)].filter((g) => g.length);
        await Promise.all(
          groups.map(async (group) => {
            const retry = await ask(classifier, group.map((j) => inputs[j]!));
            group.forEach((j, k) => (labels[j] = retry[k] ?? null));
          }),
        );
        logEvent("model_retry", { asked: missing.length, stillUnanswered: labels.filter((l) => !l).length });
      }
      for (let j = 0; j < chunk.length; j++) {
        const { pe, i } = chunk[j]!;
        const label = labels[j] ?? null;
        if (label) {
          await deps.cache.put(pe.email.id, label);
          results[i] = { label, modelFailed: false };
        } else {
          // Not cached, so the model is tried again next time.
          results[i] = { label: fallbackLabel(pe.signals), modelFailed: true };
        }
      }
    }
  }
  return prepared.map((pe, i) => finish(pe, results[i]!.label, results[i]!.modelFailed, deps));
}

/** One model request for some emails; null where there's no usable answer. Only ModelBusyError escapes. */
async function ask(classifier: Classifier, inputs: ClassifyInput[]): Promise<(Label | null)[]> {
  try {
    return inputs.length > 1 && classifier.classifyBatch
      ? await classifier.classifyBatch(inputs)
      : await Promise.all(
          inputs.map((x) =>
            classifier.classify(x).catch((e) => {
              if (e instanceof ModelBusyError) throw e;
              logError("model_request_failed", e, { emails: 1 });
              return null;
            }),
          ),
        );
  } catch (e) {
    if (e instanceof ModelBusyError) throw e;
    logError("model_request_failed", e, { emails: inputs.length });
    return inputs.map(() => null);
  }
}

export async function processEmail(email: Email, deps: EngineDeps): Promise<Decision> {
  return (await processEmails([email], deps))[0]!;
}

/** The note the assistant sees: counts and reasons only, never subjects or values. */
export function filterNote(decisions: Decision[]): string {
  const part = (action: Action, what: string, keep: (d: Decision) => boolean = () => true) => {
    const ds = decisions.filter((d) => d.action === action && keep(d));
    if (!ds.length) return "";
    const reasons = [...new Set(ds.flatMap((d) => d.because))].join(", ");
    return `${ds.length} email${ds.length > 1 ? "s" : ""} ${what} (${reasons})`;
  };
  const unchecked = decisions.filter((d) => d.action === "withheld" && d.because.includes(MODEL_UNAVAILABLE)).length;
  const decided = part("withheld", "withheld", (d) => !d.because.includes(MODEL_UNAVAILABLE));
  const parts = [part("redacted", "shared with sensitive values removed, shown as [removed: …]"), decided].filter(Boolean);
  const notes: string[] = [];
  if (parts.length) notes.push(`Privacy filter, by the user's privacy settings: ${parts.join("; ")}. Don't guess removed values. Tell the user if this affects your answer; they can review it on their dashboard.`);
  if (unchecked) notes.push(`Privacy filter: ${unchecked} email${unchecked > 1 ? "s" : ""} couldn't be checked just now, so ${unchecked > 1 ? "they were" : "it was"} held back. This says nothing about what they contain: don't describe them as sensitive. Try again shortly, and tell the user if this affects your answer.`);
  return notes.length ? notes.join(" ") : "Privacy filter: nothing was removed or withheld.";
}

export function maskedHints(hits: Hit[]): string[] {
  return hits.slice(0, 10).map((h) => `${DETECTOR_LABELS[h.type]} ${h.masked}`);
}
