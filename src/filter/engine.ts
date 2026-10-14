// Runs one email through detectors, signals and the classifier, then decides: share the
// email unchanged, share it with sensitive values removed, or withhold it whole (medical or
// financial emails, or when removal can't be verified). Also produces the audit record (no content).

import { detect, type Hit, DETECTOR_LABELS } from "./detectors";
import { computeSignals, isCandidate, type Signals } from "./signals";
import {
  DETECTOR_ITEM,
  ITEM_LABELS,
  fallbackLabel,
  ruleLabel,
  type Category,
  type Classifier,
  type Label,
  type SensitiveItem,
} from "./classifier";
import { redactEmail } from "./redactor";
import { senderDomain, type Attachment, type Email } from "../mail";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 20000;
const SCANNABLE = /^(application\/pdf|image\/(jpeg|jpg|png|webp|gif|bmp)|text\/)/i;

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
  /** Converts a PDF or image to text; returns null if it can't. */
  extractText: (att: Attachment, bytes: Uint8Array) => Promise<string | null>;
  cache: LabelCache;
  policy: Policy;
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
  unscannedAttachments: string[];
  /** Present when shared or redacted: what the assistant receives. */
  filtered?: FilteredEmail;
}

interface ScannedAttachment {
  att: Attachment;
  text: string | null;
  hits: Hit[];
}

async function scanAttachment(att: Attachment, deps: EngineDeps): Promise<ScannedAttachment> {
  if (att.size > MAX_ATTACHMENT_BYTES || !SCANNABLE.test(att.mimeType)) return { att, text: null, hits: [] };
  try {
    const bytes = await att.load();
    const text = att.mimeType.startsWith("text/") ? new TextDecoder().decode(bytes) : await deps.extractText(att, bytes);
    if (text === null) return { att, text: null, hits: [] };
    const clipped = text.slice(0, MAX_TEXT_CHARS);
    return { att, text: clipped, hits: detect(clipped) };
  } catch {
    return { att, text: null, hits: [] };
  }
}

export interface DecideInput {
  label: Label;
  rule: Label | null;
  hits: Hit[];
  modelFailed: boolean;
  /** The email had medical/financial hints or attachments (used only when the model failed). */
  candidate: boolean;
  released: boolean;
  policy: Policy;
}

export type Verdict = "share" | "redact" | "withhold";

/**
 * Withhold whole: a withheld category (from the model or a clear rule), or (fail closed) the
 * model was unavailable for an email with sensitive hints. Otherwise, redact any sensitive item
 * the model reports or a pattern detector proves. A user's "release" overrides all of it.
 */
export function decide(i: DecideInput): { verdict: Verdict; because: string[] } {
  if (i.released) return { verdict: "share", because: [] };
  const p = i.policy;
  const categories: string[] = [];
  for (const l of [i.label, i.rule]) {
    if (l && l.category !== "other" && p.withhold.has(l.category) && l.confidence >= p.threshold && !categories.includes(l.category))
      categories.push(l.category);
  }
  if (categories.length) return { verdict: "withhold", because: categories };
  if (i.modelFailed && i.candidate) return { verdict: "withhold", because: ["unchecked (model unavailable)"] };
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
  attachmentText: string;
  hits: Hit[];
  signals: Signals;
  unscannedAttachments: string[];
  cached: Label | null;
}

async function prepareEmail(email: Email, deps: EngineDeps): Promise<PreparedEmail> {
  const domain = senderDomain(email.from);
  const scanned = await Promise.all(email.attachments.map((a) => scanAttachment(a, deps)));
  const attachmentText = scanned
    .filter((s) => s.text)
    .map((s) => `\n[Attachment: ${s.att.filename}]\n${s.text}`)
    .join("");
  const text = `${email.subject}\n${email.body}${attachmentText}`.slice(0, MAX_TEXT_CHARS);
  const hits = [...detect(email.subject), ...detect(email.snippet), ...detect(email.body), ...scanned.flatMap((s) => s.hits)];
  const cached = await deps.cache.get(email.id);
  return {
    email,
    domain,
    text,
    attachmentText,
    hits,
    signals: computeSignals(domain, text, hits),
    unscannedAttachments: scanned.filter((s) => s.text === null).map((s) => s.att.filename),
    // A cached label has item types but no values, so it can't drive redaction: only labels
    // without sensitive items are reused; the rest go back to the model.
    cached: cached && cached.sensitive.length === 0 ? cached : null,
  };
}

function finish(pe: PreparedEmail, label: Label, modelFailed: boolean, deps: EngineDeps): Decision {
  const { email, domain, hits } = pe;
  const p = deps.policy;
  const { verdict, because } = decide({
    label,
    rule: ruleLabel(pe.signals),
    hits,
    modelFailed,
    candidate: isCandidate(pe.signals, email.attachments.length > 0),
    released: p.releasedMessages.has(email.id) || (domain !== "" && p.releasedSenders.has(domain)),
    policy: p,
  });
  const base = { messageId: email.id, senderDomain: domain, label, hits, because, unscannedAttachments: pe.unscannedAttachments };
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
  if (verdict === "share") return { ...base, action: "shared", filtered };

  // Every item the model reported must be removable: either it gave the value, or a detector found it.
  const values = label.values ?? [];
  const detected = new Set(hits.map((h) => DETECTOR_ITEM[h.type]));
  const unremovable = label.sensitive.filter((item) => !detected.has(item) && !values.some((v) => v.item === item));
  const r = redactEmail({ subject: email.subject, body: email.body, attachmentText: pe.attachmentText, values });
  if (unremovable.length || r.missing.length) {
    return { ...base, because: [...because, "couldn't remove safely"], action: "withheld" };
  }
  return { ...base, action: "redacted", filtered: { ...filtered, subject: r.subject, body: r.body, snippet: r.snippet } };
}

/**
 * Decides several emails with as few model requests as possible: cached labels are reused,
 * the rest are labelled in batches of BATCH_SIZE. Any email the model didn't answer for is
 * treated as "model unavailable" (fail closed for emails with sensitive hints).
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
    for (let start = 0; start < todo.length; start += BATCH_SIZE) {
      const chunk = todo.slice(start, start + BATCH_SIZE);
      const inputs = chunk.map(({ pe }) => ({ from: pe.email.from, subject: pe.email.subject, text: pe.text }));
      let labels: (Label | null)[];
      try {
        labels =
          chunk.length > 1 && classifier.classifyBatch
            ? await classifier.classifyBatch(inputs)
            : await Promise.all(inputs.map((x) => classifier.classify(x).catch(() => null)));
      } catch {
        labels = chunk.map(() => null);
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

export async function processEmail(email: Email, deps: EngineDeps): Promise<Decision> {
  return (await processEmails([email], deps))[0]!;
}

/** The note the assistant sees: counts and reasons only, never subjects or values. */
export function filterNote(decisions: Decision[]): string {
  const part = (action: Action, what: string) => {
    const ds = decisions.filter((d) => d.action === action);
    if (!ds.length) return "";
    const reasons = [...new Set(ds.flatMap((d) => d.because))].join(", ");
    return `${ds.length} email${ds.length > 1 ? "s" : ""} ${what} (${reasons})`;
  };
  const parts = [part("redacted", "shared with sensitive values removed, shown as [removed: …]"), part("withheld", "withheld")].filter(Boolean);
  if (!parts.length) return "Privacy filter: nothing was removed or withheld.";
  return (
    `Privacy filter, by the user's privacy settings: ${parts.join("; ")}. ` +
    `Don't guess removed values. Tell the user if this affects your answer; they can review it on their dashboard.`
  );
}

export function maskedHints(hits: Hit[]): string[] {
  return hits.slice(0, 10).map((h) => `${DETECTOR_LABELS[h.type]} ${h.masked}`);
}
