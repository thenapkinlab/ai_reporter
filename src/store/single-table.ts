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
//   USER#<uid>    LABEL#<messageId>               cached classifier result: category + item types only
//   USER#<uid>    RELEASE#message#<messageId>     user chose "Release next time"
//   USER#<uid>    FEEDBACK#<messageId>            release | keep
//
// Retention through the table's TTL attribute: RUN records (assistant, query, counts) 90 days;
// ITEM and LABEL records (anything about an individual email) 7 days. No email content, sender,
// or model-written text is ever stored.

import type { Category, Label } from "../filter/classifier";
import type { Decision, LabelCache, Policy } from "../filter/engine";
import type { Item, Table } from "./table";
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
    withheld_count: Number(it.withheld ?? 0),
    created_at: String(it.createdAt),
  };
}

class TableUserStore implements UserStore {
  private pk: string;

  constructor(
    private table: Table,
    readonly userId: string,
  ) {
    this.pk = pkFor(userId);
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
        const r = await this.table.get({ pk: this.pk, sk: `LABEL#${messageId}` });
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
          sk: `LABEL#${messageId}`,
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
    const feedback = new Map(fb.map((f) => [String(f.messageId), String(f.decision)]));
    const items: RunItemRow[] = rows
      .map((i) => ({
        message_id: String(i.messageId),
        action: (i.action === "withheld" ? "withheld" : "shared") as RunItemRow["action"],
        because: (i.because as string) || null,
        feedback: feedback.get(String(i.messageId)) ?? null,
      }))
      .sort((a, b) => (a.action === b.action ? 0 : a.action === "withheld" ? -1 : 1));
    return { run: toRunRow(r), items };
  }

  async totals(days = 7, now = new Date()): Promise<Totals> {
    const since = new Date(now.getTime() - days * 86400000);
    const rows = await this.table.query(this.pk, { from: `RUN#${msKey(since)}`, to: "RUN#~" });
    const t: Totals = { read: 0, withheld: 0, background: 0, byReason: {}, byAssistant: {} };
    for (const r of rows) {
      const shared = Number(r.shared ?? 0), withheld = Number(r.withheld ?? 0);
      t.read += shared + withheld;
      t.withheld += withheld;
      if (r.runType === "background_likely") t.background++;
      const a = String(r.assistant ?? "unknown");
      t.byAssistant[a] = (t.byAssistant[a] ?? 0) + shared + withheld;
      for (const [k, v] of Object.entries((r.reasons as Record<string, number>) ?? {})) t.byReason[k] = (t.byReason[k] ?? 0) + Number(v);
    }
    return t;
  }

  async feedback(messageId: string, decision: "release" | "keep") {
    await this.table.put({ pk: this.pk, sk: `FEEDBACK#${messageId}`, messageId, decision, at: new Date().toISOString() });
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
  constructor(private table: Table) {}

  forUser(userId: string): UserStore {
    return new TableUserStore(this.table, userId);
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
