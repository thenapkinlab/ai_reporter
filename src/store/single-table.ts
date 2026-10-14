// Single-table design: every record for a user shares one partition key, and the sort key
// says what the record is. One query fetches a user's runs in time order, and deleting a
// user is "delete everything in this partition".
//
//   pk            sk                              what
//   USER#<uid>    PROFILE                         email
//   USER#<uid>    GMAIL                           address, KMS-encrypted refresh token
//   USER#<uid>    SETTINGS                        withhold medical / financial
//   USER#<uid>    RUN#<runId>                     one assistant tool call (runId sorts by time)
//   USER#<uid>    ITEM#<runId>#<messageId>        one email touched by that call (no content)
//   USER#<uid>    LABEL#<messageId>               cached classifier label
//   USER#<uid>    RELEASE#message#<messageId>     user chose "Release next time"
//   USER#<uid>    FEEDBACK#<messageId>            release | keep
//
// RUN, ITEM and LABEL records expire after 90 days through the table's TTL attribute.

import type { Category, Label } from "../filter/classifier";
import { maskedHints, type Decision, type LabelCache, type Policy } from "../filter/engine";
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

const RETENTION_DAYS = 90;

const pkFor = (uid: string) => `USER#${uid}`;
const msKey = (d: Date) => String(d.getTime()).padStart(13, "0");
const expiresAt = (now: Date) => Math.floor(now.getTime() / 1000) + RETENTION_DAYS * 86400;

function toRunRow(it: Item): RunRow {
  return {
    id: String(it.runId),
    assistant: it.assistant as RunRow["assistant"],
    tool: String(it.tool),
    query: (it.query as string | null) ?? null,
    run_type: it.runType as RunRow["run_type"],
    shared_count: Number(it.shared ?? 0),
    withheld_count: Number(it.withheld ?? 0),
    redacted_count: Number(it.redacted ?? 0),
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
          ? { category: r.category as Category, confidence: Number(r.confidence), reason: String(r.reason ?? ""), source: r.source as Label["source"] }
          : null;
      },
      put: async (messageId, label) => {
        await this.table.put({ pk: this.pk, sk: `LABEL#${messageId}`, ...label, expiresAt: expiresAt(new Date()) });
      },
    };
  }

  async recordRun(runId: string, meta: RunMeta, decisions: Decision[], now: Date) {
    const since = new Date(now.getTime() - 8 * 86400000);
    const prior = (await this.table.query(this.pk, { from: `RUN#${msKey(since)}`, to: "RUN#~", limit: 500 }))
      .filter((r) => r.assistant === meta.assistant && r.query === meta.query)
      .map((r) => new Date(String(r.createdAt)));
    const count = (a: string) => decisions.filter((d) => d.action === a).length;
    const exp = expiresAt(now);

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
      redacted: count("redacted"),
      createdAt: now.toISOString(),
      expiresAt: exp,
    };
    const items: Item[] = decisions.map((d) => ({
      pk: this.pk,
      sk: `ITEM#${runId}#${d.messageId}`,
      messageId: d.messageId,
      senderDomain: d.senderDomain,
      action: d.action,
      category: d.label.category,
      confidence: d.label.confidence,
      reason: d.label.reason,
      detectors: [...new Set(d.hits.map((h) => h.type))].join(","),
      maskedHints: JSON.stringify(maskedHints(d.hits)),
      removedAttachments: d.removedAttachments.length,
      expiresAt: exp,
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
    const order = { withheld: 0, redacted: 1, shared: 2 } as const;
    const items: RunItemRow[] = rows
      .map((i) => ({
        message_id: String(i.messageId),
        sender_domain: (i.senderDomain as string) ?? null,
        action: i.action as RunItemRow["action"],
        category: i.category as Category,
        confidence: Number(i.confidence),
        reason: (i.reason as string) ?? null,
        detectors: (i.detectors as string) ?? null,
        masked_hints: (i.maskedHints as string) ?? null,
        removed_attachments: Number(i.removedAttachments ?? 0),
        feedback: feedback.get(String(i.messageId)) ?? null,
      }))
      .sort((a, b) => order[a.action] - order[b.action]);
    return { run: toRunRow(r), items };
  }

  async totals(days = 7, now = new Date()): Promise<Totals> {
    const since = new Date(now.getTime() - days * 86400000);
    const rows = await this.table.query(this.pk, { from: `RUN#${msKey(since)}`, to: "RUN#~" });
    const t: Totals = { read: 0, withheld: 0, redacted: 0, background: 0 };
    for (const r of rows) {
      const shared = Number(r.shared ?? 0), withheld = Number(r.withheld ?? 0), redacted = Number(r.redacted ?? 0);
      t.read += shared + withheld + redacted;
      t.withheld += withheld;
      t.redacted += redacted;
      if (r.runType === "background_likely") t.background++;
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
