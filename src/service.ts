// Connects the MCP tools to a mailbox, the filter engine and the audit log.

import { filterNote, processEmail, processEmails, type Decision, type EngineDeps } from "./filter/engine";
import type { Mailbox } from "./mail";
import { toolError, type ToolBackend, type ToolResult } from "./mcp";
import { DEFAULT_LIMITS, type Limits } from "./config";
import { limitMessage, type Reservation } from "./limits";
import { ModelBusyError, PROMPT_VERSION } from "./filter/classifier";
import { MODEL_UNAVAILABLE } from "./filter/engine";
import { countMetric, emit } from "./metrics";
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
    for (const action of ["shared", "redacted", "withheld"] as const)
      countMetric("Emails", decisions.filter((d) => d.action === action).length, { Action: action, PromptVersion: PROMPT_VERSION });
    const reasons = new Map<string, number>();
    for (const d of decisions) for (const b of d.because) reasons.set(b, (reasons.get(b) ?? 0) + 1);
    for (const [reason, n] of reasons) countMetric("Reasons", n, { Reason: reason });
    const now = this.now();
    await this.store.recordRun(newRunId(now, randomId()), { ...this.meta, tool, query }, decisions, now);
  }

  /** Records the outcome and timings of one tool call (counts and milliseconds only). */
  private async instrumented(tool: string, run: (t: Timing) => Promise<{ result: ToolResult; outcome: CallOutcome }>): Promise<ToolResult> {
    const started = Date.now();
    const t: Timing = { gmailMs: 0, filterMs: 0 };
    let outcome: CallOutcome = "error";
    try {
      const r = await run(t);
      outcome = r.outcome;
      return r.result;
    } finally {
      countMetric("ToolCalls", 1, { Tool: tool, Outcome: outcome });
      if (outcome === "ok")
        emit(
          [
            { name: "TotalMs", value: Date.now() - started, unit: "Milliseconds" },
            { name: "GmailMs", value: t.gmailMs, unit: "Milliseconds" },
            { name: "FilterMs", value: t.filterMs, unit: "Milliseconds" },
          ],
          { Tool: tool },
        );
    }
  }

  private async timed<T>(t: Timing, key: keyof Timing, fn: () => Promise<T>): Promise<T> {
    const s = Date.now();
    try {
      return await fn();
    } finally {
      t[key] += Date.now() - s;
    }
  }

  /** Reserves emails against the user's limits, runs `work` on the allowed ones, and gives back unused ones. */
  private async withBudget<T>(ids: string[], work: (ids: string[]) => Promise<T>): Promise<Budgeted<T>> {
    const now = this.now();
    const reservation = await this.store.reserveEmails(ids.length, this.limits, now);
    if (reservation.limitedBy) countMetric("UserLimitReached");
    if (ids.length > 0 && reservation.allowed === 0) return { refused: toolError(limitMessage(reservation, this.limits)), outcome: "limit" };
    try {
      return { result: await work(ids.slice(0, reservation.allowed)), reservation };
    } catch (e) {
      await this.store.releaseEmails(reservation.allowed, now);
      if (e instanceof ModelBusyError) {
        countMetric("ModelBusy");
        return { refused: toolError(BUSY), outcome: "busy" };
      }
      throw e;
    }
  }

  searchEmail(query: string, maxResults: number, pageToken?: string): Promise<ToolResult> {
    return this.instrumented("search_email", async (t) => {
      const page = await this.timed(t, "gmailMs", () => this.mailbox.search(query, maxResults, pageToken));
      const out = await this.withBudget(page.ids, async (ids) => {
        const emails = await this.timed(t, "gmailMs", () => mapLimit(ids, CONCURRENCY, (id) => this.mailbox.get(id)));
        const decisions = await this.timed(t, "filterMs", () => processEmails(emails, this.deps));
        await this.record("search_email", query, decisions);
        return decisions;
      });
      if ("refused" in out) return { result: out.refused, outcome: out.outcome };
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
      return {
        outcome: truncated ? "limit" : "ok",
        result: result({
          results,
          filter_note: filterNote(decisions),
          // A cut-short page has no next page: the rest is over the user's limit.
          next_page_token: truncated ? null : page.nextPageToken,
          ...(truncated ? { usage_note: `Only ${reservation.allowed} of ${page.ids.length} matching emails were checked. ${limitMessage(reservation, this.limits)}` } : {}),
        }),
      };
    });
  }

  readEmail(messageId: string): Promise<ToolResult> {
    return this.instrumented("read_email", async (t) => {
      const out = await this.withBudget([messageId], async () => {
        const email = await this.timed(t, "gmailMs", () => this.mailbox.get(messageId));
        const decision = await this.timed(t, "filterMs", () => processEmail(email, this.deps));
        await this.record("read_email", messageId, [decision]);
        return decision;
      });
      if ("refused" in out) return { result: out.refused, outcome: out.outcome };
      const decision = out.result;
      if (!decision.filtered) {
        return {
          outcome: "ok",
          result: result({
            id: messageId,
            withheld: true,
            notice: `This email was withheld by the user's privacy settings (${decision.because.join(", ")}).`,
            filter_note: filterNote([decision]),
          }),
        };
      }
      const removed = decision.action === "redacted" ? { values_removed: decision.because } : {};
      return { outcome: "ok", result: result({ ...decision.filtered, ...removed, filter_note: filterNote([decision]) }) };
    });
  }
}

type CallOutcome = "ok" | "limit" | "busy" | "error";
interface Timing {
  gmailMs: number;
  filterMs: number;
}
type Budgeted<T> = { result: T; reservation: Reservation } | { refused: ToolResult; outcome: CallOutcome };

const BUSY = "The privacy filter is busy right now (shared capacity is full). Wait about a minute and try again; tell the user if it keeps happening.";
