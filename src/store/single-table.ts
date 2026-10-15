// Single-table design: every record for a user shares one partition key, and the sort key
// says what the record is. One query fetches a user's runs in time order, and deleting a
// user is "delete everything in this partition".
//
//   pk            sk                              what
//   USER#<uid>    PROFILE                         email
//   USER#<uid>    GMAIL                           address, KMS-encrypted refresh token
//   USER#<uid>    SETTINGS                        withhold medical / financial
//   USER#<uid>    RUN#<runId>                     one assistant tool call (runId sorts by time)
//   USER#<uid>    ITEM#<runId>#<messageId>        one email touched by that call: ID + decision only
//   USER#<uid>    LABEL#<hash of messageId>       cached classifier result: category + item types only.
//                                                 The key is an HMAC of the message ID, so the cache can't
//                                                 be matched to an email without the secret.
//   USER#<uid>    RELEASE#message#<messageId>     user chose "Release next time"
//   USER#<uid>    FEEDBACK#<messageId>            release | keep
//   USER#<uid>    USAGE#10m#<window> / USAGE#day#<date>   emails checked (a number), for usage limits
//   GLOBAL        MODELRPM#<minute>               classifier requests that minute, across all users
//
// Retention through the table's TTL attribute: RUN records (assistant, query, counts) 90 days;
// ITEM and LABEL records (anything about an individual email) 7 days. No email content, sender,
// or model-written text is ever stored.

import type { Limits } from "../config";
import { tenMinuteWindow, utcDay, type Reservation } from "../limits";
import type { Category, Label } from "../filter/classifier";
import type { Decision, LabelCache, Policy } from "../filter/engine";
import type { Item, Table } from "./table";
import { keyedHash } from "../crypto";
import {
  inferRunType,
  type Accounts,
  type GmailConnection,
  type RunItemRow,
  type RunMeta,
  type RunRow,
  type Totals,
  type UserStore,
} from "./types";

export const RUN_DAYS = 90;
export const EMAIL_DAYS = 7;

const pkFor = (uid: string) => `USER#${uid}`;
const msKey = (d: Date) => String(d.getTime()).padStart(13, "0");
const expiresAt = (now: Date, days: number) => Math.floor(now.getTime() / 1000) + days * 86400;

function toRunRow(it: Item): RunRow {
  return {
    id: String(it.runId),
    assistant: it.assistant as RunRow["assistant"],
    tool: String(it.tool),
    query: (it.query as string | null) ?? null,
    run_type: it.runType as RunRow["run_type"],
    shared_count: Number(it.shared ?? 0),
    redacted_count: Number(it.redacted ?? 0),
    withheld_count: Number(it.withheld ?? 0),
    created_at: String(it.createdAt),
  };
}

const ORDER: Record<RunItemRow["action"], number> = { withheld: 0, redacted: 1, shared: 2 };
const GLOBAL_PK = "GLOBAL";

class TableUserStore implements UserStore {
  private pk: string;

  constructor(
    private table: Table,
    readonly userId: string,
    private cacheSecret: string,
  ) {
    this.pk = pkFor(userId);
  }

  private labelKey(messageId: string): Promise<string> {
    return keyedHash(`${this.userId}:${messageId}`, this.cacheSecret, "label-cache").then((h) => `LABEL#${h}`);
  }

  async policy(threshold: number): Promise<Policy> {
    const s = await this.settings();
    const withhold = new Set<Category>();
    if (s.medical) withhold.add("medical");
    if (s.financial) withhold.add("financial");
    const rel = await this.table.query(this.pk, { prefix: "RELEASE#message#" });
    return {
      withhold,
      threshold,
      releasedMessages: new Set(rel.map((r) => String(r.value))),
      releasedSenders: new Set(),
    };
  }

  async settings() {
    const s = await this.table.get({ pk: this.pk, sk: "SETTINGS" });
    return { medical: s ? s.medical !== false : true, financial: s ? s.financial !== false : true };
  }

  async saveSettings(medical: boolean, financial: boolean) {
    await this.table.put({ pk: this.pk, sk: "SETTINGS", medical, financial });
  }

  labelCache(): LabelCache {
    return {
      get: async (messageId) => {
        const r = await this.table.get({ pk: this.pk, sk: await this.labelKey(messageId) });
        return r
          ? {
              category: r.category as Category,
              confidence: Number(r.confidence),
              sensitive: (r.sensitive as Label["sensitive"]) ?? [],
              reason: "",
              source: r.source as Label["source"],
            }
          : null;
      },
      put: async (messageId, label) => {
        // The model's free-text reason is not stored.
        await this.table.put({
          pk: this.pk,
          sk: await this.labelKey(messageId),
          category: label.category,
          confidence: label.confidence,
          sensitive: label.sensitive,
          source: label.source,
          expiresAt: expiresAt(new Date(), EMAIL_DAYS),
        });
      },
    };
  }

  async recordRun(runId: string, meta: RunMeta, decisions: Decision[], now: Date) {
    const since = new Date(now.getTime() - 8 * 86400000);
    const prior = (await this.table.query(this.pk, { from: `RUN#${msKey(since)}`, to: "RUN#~", limit: 500 }))
      .filter((r) => r.assistant === meta.assistant && r.query === meta.query)
      .map((r) => new Date(String(r.createdAt)));
    const count = (a: string) => decisions.filter((d) => d.action === a).length;
    const reasons: Record<string, number> = {};
    for (const d of decisions) for (const b of d.because) reasons[b] = (reasons[b] ?? 0) + 1;

    const run: Item = {
      pk: this.pk,
      sk: `RUN#${runId}`,
      runId,
      assistant: meta.assistant,
      clientId: meta.clientId,
      userAgent: meta.userAgent,
      headerNames: meta.headerNames,
      tool: meta.tool,
      query: meta.query,
      runType: inferRunType(meta.query, prior, now),
      shared: count("shared"),
      redacted: count("redacted"),
      withheld: count("withheld"),
      reasons,
      createdAt: now.toISOString(),
      expiresAt: expiresAt(now, RUN_DAYS),
    };
    const items: Item[] = decisions.map((d) => ({
      pk: this.pk,
      sk: `ITEM#${runId}#${d.messageId}`,
      messageId: d.messageId,
      action: d.action,
      because: d.because.join(", "),
      expiresAt: expiresAt(now, EMAIL_DAYS),
    }));
    await this.table.putMany([run, ...items]);
  }

  async recentRuns(limit = 50): Promise<RunRow[]> {
    const rows = await this.table.query(this.pk, { prefix: "RUN#", descending: true, limit });
    return rows.map(toRunRow);
  }

  async run(runId: string) {
    const r = await this.table.get({ pk: this.pk, sk: `RUN#${runId}` });
    if (!r) return null;
    const rows = await this.table.query(this.pk, { prefix: `ITEM#${runId}#` });
    const fb = await this.table.getMany(rows.map((i) => ({ pk: this.pk, sk: `FEEDBACK#${String(i.messageId)}` })));
    const feedback = new Map(fb.map((f) => [String(f.messageId), f.decision === "leak" ? `reported a leak (${String(f.item ?? "other").replace(/_/g, " ")})` : String(f.decision)]));
    const items: RunItemRow[] = rows
      .map((i) => ({
        message_id: String(i.messageId),
        action: (i.action === "withheld" || i.action === "redacted" ? i.action : "shared") as RunItemRow["action"],
        because: (i.because as string) || null,
        feedback: feedback.get(String(i.messageId)) ?? null,
      }))
      .sort((a, b) => ORDER[a.action] - ORDER[b.action]);
    return { run: toRunRow(r), items };
  }

  async totals(days = 7, now = new Date()): Promise<Totals> {
    const since = new Date(now.getTime() - days * 86400000);
    const rows = await this.table.query(this.pk, { from: `RUN#${msKey(since)}`, to: "RUN#~" });
    const t: Totals = { read: 0, redacted: 0, withheld: 0, background: 0, byReason: {}, byAssistant: {} };
    for (const r of rows) {
      const shared = Number(r.shared ?? 0), redacted = Number(r.redacted ?? 0), withheld = Number(r.withheld ?? 0);
      t.read += shared + redacted + withheld;
      t.redacted += redacted;
      t.withheld += withheld;
      if (r.runType === "background_likely") t.background++;
      const a = String(r.assistant ?? "unknown");
      t.byAssistant[a] = (t.byAssistant[a] ?? 0) + shared + redacted + withheld;
      for (const [k, v] of Object.entries((r.reasons as Record<string, number>) ?? {})) t.byReason[k] = (t.byReason[k] ?? 0) + Number(v);
    }
    return t;
  }

  private usageKeys(now: Date) {
    const w = tenMinuteWindow(now);
    return {
      window: { key: { pk: this.pk, sk: `USAGE#10m#${w}` }, expiresAt: (w + 1) * 600 + 3600, resetsAt: new Date((w + 1) * 600000) },
      day: { key: { pk: this.pk, sk: `USAGE#day#${utcDay(now)}` }, expiresAt: expiresAt(now, 2), resetsAt: new Date(`${utcDay(now)}T00:00:00Z`) },
    };
  }

  async reserveEmails(n: number, limits: Limits, now: Date): Promise<Reservation> {
    const k = this.usageKeys(now);
    k.day.resetsAt.setUTCDate(k.day.resetsAt.getUTCDate() + 1);
    // Increment first, then check: concurrent requests can't both slip under the limit.
    const [inWindow, inDay] = await Promise.all([
      this.table.add(k.window.key, "count", n, k.window.expiresAt),
      this.table.add(k.day.key, "count", n, k.day.expiresAt),
    ]);
    const leftWindow = Math.max(0, n - Math.max(0, inWindow - limits.emailsPer10Min));
    const leftDay = Math.max(0, n - Math.max(0, inDay - limits.emailsPerDay));
    const allowed = Math.min(leftWindow, leftDay);
    if (allowed < n) await this.releaseEmails(n - allowed, now);
    const limitedBy = allowed === n ? null : leftDay <= leftWindow ? "day" : "10 minutes";
    return {
      allowed,
      limitedBy,
      resetsAt: limitedBy === "day" ? k.day.resetsAt : limitedBy ? k.window.resetsAt : null,
      usedToday: inDay - (n - allowed),
    };
  }

  async releaseEmails(n: number, now: Date) {
    if (n <= 0) return;
    const k = this.usageKeys(now);
    await Promise.all([
      this.table.add(k.window.key, "count", -n, k.window.expiresAt),
      this.table.add(k.day.key, "count", -n, k.day.expiresAt),
    ]);
  }

  async usageToday(now: Date) {
    return Number((await this.table.get(this.usageKeys(now).day.key))?.count ?? 0);
  }

  async feedback(messageId: string, decision: "release" | "keep" | "leak", item: string | null = null) {
    const now = new Date();
    // Kept 7 days like everything else about an individual email.
    await this.table.put({
      pk: this.pk, sk: `FEEDBACK#${messageId}`, messageId, decision, ...(item ? { item } : {}), at: now.toISOString(), expiresAt: expiresAt(now, EMAIL_DAYS),
    });
    if (decision === "leak") return;
    const releaseKey = { pk: this.pk, sk: `RELEASE#message#${messageId}` };
    if (decision === "release") await this.table.put({ ...releaseKey, value: messageId });
    else await this.table.delete(releaseKey);
  }

  async deleteAll() {
    const all = await this.table.query(this.pk);
    await this.table.deleteMany(all.map((r) => ({ pk: r.pk, sk: r.sk })));
  }
}

export class TableAccounts implements Accounts {
  /** `cacheSecret`: base64 secret for hashing classifier-cache keys. */
  constructor(
    private table: Table,
    private cacheSecret: string,
  ) {}

  forUser(userId: string): UserStore {
    return new TableUserStore(this.table, userId, this.cacheSecret);
  }

  async countModelRequest(minute: number) {
    // Kept for an hour; only the current minute matters.
    return this.table.add({ pk: GLOBAL_PK, sk: `MODELRPM#${minute}` }, "count", 1, minute * 60 + 3600);
  }

  async upsertUser(id: string, email: string) {
    const existing = await this.table.get({ pk: pkFor(id), sk: "PROFILE" });
    await this.table.put({
      pk: pkFor(id),
      sk: "PROFILE",
      email,
      createdAt: (existing?.createdAt as string) ?? new Date().toISOString(),
    });
  }

  async ensureUser(id: string, email: string) {
    const existing = await this.table.get({ pk: pkFor(id), sk: "PROFILE" });
    if (!existing) await this.table.put({ pk: pkFor(id), sk: "PROFILE", email, createdAt: new Date().toISOString() });
  }

  async getGmail(userId: string): Promise<GmailConnection | null> {
    const g = await this.table.get({ pk: pkFor(userId), sk: "GMAIL" });
    return g ? { gmail_address: String(g.address), encrypted_refresh_token: String(g.encryptedRefreshToken) } : null;
  }

  async saveGmail(userId: string, address: string, encryptedRefreshToken: string, scope: string) {
    await this.table.put({
      pk: pkFor(userId),
      sk: "GMAIL",
      address,
      encryptedRefreshToken,
      scope,
      connectedAt: new Date().toISOString(),
    });
  }

  async deleteGmail(userId: string) {
    await this.table.delete({ pk: pkFor(userId), sk: "GMAIL" });
  }
}
