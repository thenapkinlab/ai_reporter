// Connects the MCP tools to a mailbox, the filter engine and the audit log.

import { filterNote, processEmail, processEmails, type Decision, type EngineDeps } from "./filter/engine";
import type { Mailbox } from "./mail";
import { toolError, type ToolBackend, type ToolResult } from "./mcp";
import { DEFAULT_LIMITS, type Limits } from "./config";
import { limitMessage, type Reservation } from "./limits";
import { ModelBusyError } from "./filter/classifier";
import { MODEL_UNAVAILABLE } from "./filter/engine";
import { countMetric } from "./metrics";
import { randomId } from "./crypto";
import { newRunId, type RunMeta, type UserStore } from "./store/types";

const CONCURRENCY = 5;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function result(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

export class GatewayService implements ToolBackend {
  constructor(
    private mailbox: Mailbox,
    private deps: EngineDeps,
    private store: UserStore,
    private meta: Omit<RunMeta, "tool" | "query">,
    private limits: Limits = DEFAULT_LIMITS,
    private now: () => Date = () => new Date(),
  ) {}

  private async record(tool: string, query: string, decisions: Decision[]) {
    countMetric("ModelUnavailable", decisions.filter((d) => d.because.includes(MODEL_UNAVAILABLE)).length);
    const now = this.now();
    await this.store.recordRun(newRunId(now, randomId()), { ...this.meta, tool, query }, decisions, now);
  }

  /** Reserves emails against the user's limits, runs `work` on the allowed ones, and gives back unused ones. */
  private async withBudget<T>(ids: string[], work: (ids: string[]) => Promise<T>): Promise<{ result: T; reservation: Reservation } | ToolResult> {
    const now = this.now();
    const reservation = await this.store.reserveEmails(ids.length, this.limits, now);
    if (reservation.limitedBy) countMetric("UserLimitReached");
    if (ids.length > 0 && reservation.allowed === 0) return toolError(limitMessage(reservation, this.limits));
    try {
      return { result: await work(ids.slice(0, reservation.allowed)), reservation };
    } catch (e) {
      await this.store.releaseEmails(reservation.allowed, now);
      if (e instanceof ModelBusyError) {
        countMetric("ModelBusy");
        return toolError(BUSY);
      }
      throw e;
    }
  }

  async searchEmail(query: string, maxResults: number, pageToken?: string): Promise<ToolResult> {
    const page = await this.mailbox.search(query, maxResults, pageToken);
    const out = await this.withBudget(page.ids, async (ids) => {
      const emails = await mapLimit(ids, CONCURRENCY, (id) => this.mailbox.get(id));
      const decisions = await processEmails(emails, this.deps);
      await this.record("search_email", query, decisions);
      return decisions;
    });
    if ("content" in out) return out;
    const { result: decisions, reservation } = out;
    const results = decisions
      .filter((d) => d.filtered)
      .map((d) => {
        const f = d.filtered!;
        return {
          id: f.id, from: f.from, subject: f.subject, date: f.date, snippet: f.snippet, attachments: f.attachments.length,
          ...(d.action === "redacted" ? { values_removed: d.because } : {}),
        };
      });
    const truncated = reservation.allowed < page.ids.length;
    return result({
      results,
      filter_note: filterNote(decisions),
      // A cut-short page has no next page: the rest is over the user's limit.
      next_page_token: truncated ? null : page.nextPageToken,
      ...(truncated ? { usage_note: `Only ${reservation.allowed} of ${page.ids.length} matching emails were checked. ${limitMessage(reservation, this.limits)}` } : {}),
    });
  }

  async readEmail(messageId: string): Promise<ToolResult> {
    const out = await this.withBudget([messageId], async () => {
      const decision = await processEmail(await this.mailbox.get(messageId), this.deps);
      await this.record("read_email", messageId, [decision]);
      return decision;
    });
    if ("content" in out) return out;
    const decision = out.result;
    if (!decision.filtered) {
      return result({
        id: messageId,
        withheld: true,
        notice: `This email was withheld by the user's privacy settings (${decision.because.join(", ")}).`,
        filter_note: filterNote([decision]),
      });
    }
    const removed = decision.action === "redacted" ? { values_removed: decision.because } : {};
    return result({ ...decision.filtered, ...removed, filter_note: filterNote([decision]) });
  }
}

const BUSY = "The privacy filter is busy right now (shared capacity is full). Wait about a minute and try again; tell the user if it keeps happening.";
