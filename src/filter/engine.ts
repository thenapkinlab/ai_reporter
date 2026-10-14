// Runs one email through detectors, signals and the classifier, then decides: share the
// email unchanged, or withhold it whole. Also produces the audit record (no content).

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

export type Action = "shared" | "withheld";

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
  /** Why it was withheld, e.g. ["financial", "bank account"]. Empty when shared. */
  because: string[];
  unscannedAttachments: string[];
  /** Present only when shared. */
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

/** The model's label for an email (cached). `modelFailed` means the fallback was used instead. */
async function labelEmail(email: Email, text: string, signals: Signals, deps: EngineDeps): Promise<{ label: Label; modelFailed: boolean }> {
  const cached = await deps.cache.get(email.id);
  if (cached) return { label: cached, modelFailed: false };
  if (!deps.classifier) return { label: ruleLabel(signals) ?? fallbackLabel(signals), modelFailed: false };
  try {
    const label = await deps.classifier.classify({ from: email.from, subject: email.subject, text });
    await deps.cache.put(email.id, label);
    return { label, modelFailed: false };
  } catch {
    // Not cached, so the model is tried again next time.
    return { label: fallbackLabel(signals), modelFailed: true };
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

/**
 * Withhold if any of: a withheld category (from the model or a clear rule), any sensitive item
 * the model reports, any sensitive item a pattern detector proves, or (fail closed) the model
 * was unavailable for an email with sensitive hints. A user's "release" overrides all of it.
 */
export function decide(i: DecideInput): string[] {
  if (i.released) return [];
  const because: string[] = [];
  const p = i.policy;
  for (const l of [i.label, i.rule]) {
    if (l && l.category !== "other" && p.withhold.has(l.category) && l.confidence >= p.threshold && !because.includes(l.category))
      because.push(l.category);
  }
  const items = new Set<SensitiveItem>([...i.label.sensitive, ...i.hits.map((h) => DETECTOR_ITEM[h.type])]);
  for (const item of items) because.push(ITEM_LABELS[item]);
  if (i.modelFailed && i.candidate && because.length === 0) because.push("unchecked (model unavailable)");
  return because;
}

export async function processEmail(email: Email, deps: EngineDeps): Promise<Decision> {
  const domain = senderDomain(email.from);
  const scanned = await Promise.all(email.attachments.map((a) => scanAttachment(a, deps)));
  const attachmentText = scanned
    .filter((s) => s.text)
    .map((s) => `\n[Attachment: ${s.att.filename}]\n${s.text}`)
    .join("");
  const text = `${email.subject}\n${email.body}${attachmentText}`.slice(0, MAX_TEXT_CHARS);
  const hits = [...detect(email.subject), ...detect(email.snippet), ...detect(email.body), ...scanned.flatMap((s) => s.hits)];
  const signals = computeSignals(domain, text, hits);
  const { label, modelFailed } = await labelEmail(email, text, signals, deps);

  const p = deps.policy;
  const because = decide({
    label,
    rule: ruleLabel(signals),
    hits,
    modelFailed,
    candidate: isCandidate(signals, email.attachments.length > 0),
    released: p.releasedMessages.has(email.id) || (domain !== "" && p.releasedSenders.has(domain)),
    policy: p,
  });
  const unscannedAttachments = scanned.filter((s) => s.text === null).map((s) => s.att.filename);
  const base = { messageId: email.id, senderDomain: domain, label, hits, because, unscannedAttachments };

  if (because.length) return { ...base, action: "withheld" };
  return {
    ...base,
    action: "shared",
    filtered: {
      id: email.id,
      from: email.from,
      subject: email.subject,
      date: email.date,
      snippet: email.snippet,
      body: email.body,
      attachments: email.attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.size })),
    },
  };
}

/** The note the assistant sees: counts and reasons only, never subjects or values. */
export function filterNote(decisions: Decision[]): string {
  const withheld = decisions.filter((d) => d.action === "withheld");
  if (!withheld.length) return "Privacy filter: nothing was withheld.";
  const reasons = [...new Set(withheld.flatMap((d) => d.because))].join(", ");
  return (
    `Privacy filter: ${withheld.length} email${withheld.length > 1 ? "s" : ""} withheld by the user's privacy settings ` +
    `(${reasons}). Tell the user if this affects your answer; they can review it on their dashboard.`
  );
}

export function maskedHints(hits: Hit[]): string[] {
  return hits.slice(0, 10).map((h) => `${DETECTOR_LABELS[h.type]} ${h.masked}`);
}
