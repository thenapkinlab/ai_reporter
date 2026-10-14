// Runs one email through detectors, signals, classifier and policy, and produces
// both the filtered view the assistant gets and the audit record (without content).

import { detect, redact, type Hit, DETECTOR_LABELS } from "./detectors";
import { computeSignals, isCandidate } from "./signals";
import { ruleLabel, fallbackLabel, type Category, type Classifier, type Label } from "./classifier";
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
  /** Values replaced with [REDACTED] in what the assistant received. */
  redactions: number;
  removedAttachments: string[];
  unscannedAttachments: string[];
  /** Present unless the email is withheld. */
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
    const text = att.mimeType.startsWith("text/")
      ? new TextDecoder().decode(bytes)
      : await deps.extractText(att, bytes);
    if (text === null) return { att, text: null, hits: [] };
    const clipped = text.slice(0, MAX_TEXT_CHARS);
    return { att, text: clipped, hits: detect(clipped) };
  } catch {
    return { att, text: null, hits: [] };
  }
}

async function labelEmail(email: Email, text: string, hits: Hit[], deps: EngineDeps): Promise<Label> {
  const cached = await deps.cache.get(email.id);
  if (cached) return cached;
  const signals = computeSignals(senderDomain(email.from), text, hits);
  let label = ruleLabel(signals, isCandidate(signals, email.attachments.length > 0));
  if (!label) {
    try {
      label = deps.classifier
        ? await deps.classifier.classify({ from: email.from, subject: email.subject, text })
        : fallbackLabel(signals);
    } catch {
      label = fallbackLabel(signals);
    }
  }
  await deps.cache.put(email.id, label);
  return label;
}

export async function processEmail(email: Email, deps: EngineDeps): Promise<Decision> {
  const domain = senderDomain(email.from);
  const subjectHits = detect(email.subject);
  const snippetHits = detect(email.snippet);
  const bodyHits = detect(email.body);
  const scanned = await Promise.all(email.attachments.map((a) => scanAttachment(a, deps)));

  const attachmentText = scanned
    .filter((s) => s.text)
    .map((s) => `\n[Attachment: ${s.att.filename}]\n${s.text}`)
    .join("");
  const text = `${email.subject}\n${email.body}${attachmentText}`.slice(0, MAX_TEXT_CHARS);
  const allHits = [...subjectHits, ...bodyHits, ...scanned.flatMap((s) => s.hits)];
  const label = await labelEmail(email, text, allHits, deps);

  const unscannedAttachments = scanned.filter((s) => s.text === null).map((s) => s.att.filename);
  const p = deps.policy;
  const released = p.releasedMessages.has(email.id) || (domain !== "" && p.releasedSenders.has(domain));

  if (!released && p.withhold.has(label.category) && label.confidence >= p.threshold) {
    return {
      messageId: email.id,
      senderDomain: domain,
      action: "withheld",
      label,
      hits: allHits,
      redactions: 0,
      removedAttachments: email.attachments.map((a) => a.filename),
      unscannedAttachments,
    };
  }

  const flagged = scanned.filter((s) => s.hits.length > 0);
  const kept = scanned.filter((s) => s.hits.length === 0);
  const redactions = subjectHits.length + snippetHits.length + bodyHits.length;

  return {
    messageId: email.id,
    senderDomain: domain,
    action: redactions + flagged.length > 0 ? "redacted" : "shared",
    label,
    hits: allHits,
    redactions,
    removedAttachments: flagged.map((s) => s.att.filename),
    unscannedAttachments,
    filtered: {
      id: email.id,
      from: email.from,
      subject: redact(email.subject, subjectHits),
      date: email.date,
      snippet: redact(email.snippet, snippetHits),
      body: redact(email.body, bodyHits),
      attachments: kept.map((s) => ({ filename: s.att.filename, mimeType: s.att.mimeType, size: s.att.size })),
    },
  };
}

/** The note the assistant sees: counts only, never subjects of withheld mail. */
export function filterNote(decisions: Decision[]): string {
  const withheld = decisions.filter((d) => d.action === "withheld");
  const values = decisions.reduce((n, d) => n + d.redactions, 0);
  const attachments = decisions
    .filter((d) => d.action !== "withheld")
    .reduce((n, d) => n + d.removedAttachments.length, 0);
  if (withheld.length === 0 && values === 0 && attachments === 0) return "Privacy filter: nothing was removed.";
  const parts: string[] = [];
  if (withheld.length) {
    const cats = [...new Set(withheld.map((d) => d.label.category))].join(", ");
    parts.push(`${withheld.length} email${withheld.length > 1 ? "s" : ""} withheld (${cats})`);
  }
  if (values) parts.push(`${values} sensitive value${values > 1 ? "s" : ""} redacted`);
  if (attachments) parts.push(`${attachments} attachment${attachments > 1 ? "s" : ""} removed`);
  return `Privacy filter: ${parts.join("; ")} by the user's privacy settings. Tell the user if this affects your answer.`;
}

export function maskedHints(hits: Hit[]): string[] {
  return hits.slice(0, 10).map((h) => `${DETECTOR_LABELS[h.type]} ${h.masked}`);
}
