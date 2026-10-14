// Connects the MCP tools to a mailbox, the filter engine and the audit log.

import { filterNote, processEmail, type Decision, type EngineDeps } from "./filter/engine";
import type { Mailbox } from "./mail";
import type { ToolBackend, ToolResult } from "./mcp";
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
    private now: () => Date = () => new Date(),
  ) {}

  private async record(tool: string, query: string, decisions: Decision[]) {
    const now = this.now();
    await this.store.recordRun(newRunId(now, randomId()), { ...this.meta, tool, query }, decisions, now);
  }

  async searchEmail(query: string, maxResults: number): Promise<ToolResult> {
    const ids = await this.mailbox.search(query, maxResults);
    const decisions = await mapLimit(ids, CONCURRENCY, async (id) => processEmail(await this.mailbox.get(id), this.deps));
    await this.record("search_email", query, decisions);
    const results = decisions
      .filter((d) => d.filtered)
      .map((d) => {
        const f = d.filtered!;
        return { id: f.id, from: f.from, subject: f.subject, date: f.date, snippet: f.snippet, attachments: f.attachments.length };
      });
    return result({ results, filter_note: filterNote(decisions) });
  }

  async readEmail(messageId: string): Promise<ToolResult> {
    const decision = await processEmail(await this.mailbox.get(messageId), this.deps);
    await this.record("read_email", messageId, [decision]);
    if (!decision.filtered) {
      return result({
        id: messageId,
        withheld: true,
        notice: `This email was withheld by the user's privacy settings (${decision.label.category}).`,
        filter_note: filterNote([decision]),
      });
    }
    return result({ ...decision.filtered, filter_note: filterNote([decision]) });
  }
}
