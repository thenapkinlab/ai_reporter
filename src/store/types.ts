// What the app needs from storage, independent of the database behind it.

import type { Limits } from "../config";
import type { Reservation } from "../limits";
import type { Category } from "../filter/classifier";
import type { Decision, LabelCache, Policy } from "../filter/engine";

export type Assistant = "claude" | "chatgpt" | "unknown";
export type RunType = "background_likely" | "unknown";

export interface RunMeta {
  assistant: Assistant;
  clientId: string | null;
  userAgent: string | null;
  headerNames: string;
  tool: string;
  query: string | null;
}

export interface RunRow {
  id: string;
  assistant: Assistant;
  tool: string;
  query: string | null;
  run_type: RunType;
  shared_count: number;
  redacted_count: number;
  withheld_count: number;
  created_at: string;
}

/** One email touched by a run. Only its ID and the decision are kept, for 7 days. */
export interface RunItemRow {
  message_id: string;
  action: "shared" | "redacted" | "withheld";
  /** Why it was withheld or redacted, e.g. "financial" or "home address". Empty when shared unchanged. */
  because: string | null;
  feedback: string | null;
}

/** What a user can report as leaked: the sensitive item types, plus "other". */
export const LEAK_TYPES = ["home_address", "date_of_birth", "card_number", "bank_account", "government_id", "credentials", "one_time_code", "other"];

export interface Totals {
  read: number;
  redacted: number;
  withheld: number;
  background: number;
  /** Withhold and redaction reasons, e.g. { medical: 3, "home address": 2 }. */
  byReason: Record<string, number>;
  byAssistant: Record<string, number>;
}

/** Everything one signed-in user can read or change. */
export interface UserStore {
  readonly userId: string;
  policy(threshold: number): Promise<Policy>;
  settings(): Promise<{ medical: boolean; financial: boolean }>;
  saveSettings(medical: boolean, financial: boolean): Promise<void>;
  labelCache(): LabelCache;
  recordRun(runId: string, meta: RunMeta, decisions: Decision[], now: Date): Promise<void>;
  recentRuns(limit?: number): Promise<RunRow[]>;
  run(runId: string): Promise<{ run: RunRow; items: RunItemRow[] } | null>;
  totals(days?: number, now?: Date): Promise<Totals>;
  /** "leak" reports a value that reached the assistant; `item` is one of LEAK_TYPES. */
  feedback(messageId: string, decision: "release" | "keep" | "leak", item?: string | null): Promise<void>;
  deleteAll(): Promise<void>;
  /** Counts `n` emails against the user's limits and says how many may be processed now. */
  reserveEmails(n: number, limits: Limits, now: Date): Promise<Reservation>;
  /** Gives back emails reserved but not processed (e.g. the model was busy). */
  releaseEmails(n: number, now: Date): Promise<void>;
  /** Emails checked so far today (UTC). */
  usageToday(now: Date): Promise<number>;
}

export interface GmailConnection {
  gmail_address: string;
  encrypted_refresh_token: string;
}

export interface Accounts {
  forUser(userId: string): UserStore;
  /** Creates the user or updates their email. */
  upsertUser(id: string, email: string): Promise<void>;
  /** Creates the user only if missing (MCP calls may arrive before the first dashboard sign-in). */
  ensureUser(id: string, email: string): Promise<void>;
  getGmail(userId: string): Promise<GmailConnection | null>;
  saveGmail(userId: string, address: string, encryptedRefreshToken: string, scope: string): Promise<void>;
  deleteGmail(userId: string): Promise<void>;
  /** Tester allow list (lower-cased emails). */
  isAllowed(email: string): Promise<boolean>;
  allow(email: string): Promise<void>;
  disallow(email: string): Promise<void>;
  allowed(): Promise<string[]>;
  /** The email stored with the user's profile, if any. */
  profileEmail(userId: string): Promise<string | null>;
  /** Records when the user accepted the beta notice. */
  acceptNotice(userId: string, at: Date): Promise<void>;
  /** Adds one classifier request to the shared per-minute counter and returns that minute's total. */
  countModelRequest(minute: number): Promise<number>;
}

/**
 * "Background, likely": the same assistant asked the same thing before, a whole number of hours ago (±5 min).
 * Scheduled tasks run hourly or daily, so that rhythm is a strong hint nobody was chatting.
 */
export function inferRunType(query: string | null, priorTimes: Date[], now: Date): RunType {
  if (!query) return "unknown";
  for (const t of priorTimes) {
    const mins = (now.getTime() - t.getTime()) / 60000;
    const off = mins % 60;
    if (mins >= 55 && (off <= 5 || off >= 55)) return "background_likely";
  }
  return "unknown";
}

/** Run IDs start with a fixed-width timestamp so they sort by time as database keys. */
export function newRunId(now: Date, random: string): string {
  return `${String(now.getTime()).padStart(13, "0")}-${random}`;
}
