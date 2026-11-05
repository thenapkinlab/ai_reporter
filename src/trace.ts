// Technical log of what the connector did, sent to Langfuse when keys are in SSM. Off without them.
//
// Privacy rule: every field is a number or comes from a fixed list, checked here before sending.
// Never a user ID, email address, search, message ID, sender, subject, body or model output, and
// no free text can get through, so nothing depends on spotting sensitive data after the fact.
// Sent directly as OTLP JSON (no SDK), and a failure or slow response never affects the user's request.

import { randomBytes } from "node:crypto";
import { ITEM_LABELS, PROMPT_VERSION } from "./filter/classifier";
import { DOCUMENT_NAME, MODEL_UNAVAILABLE, type Decision } from "./filter/engine";
import { logEvent } from "./logging";
import type { Assistant } from "./store/types";

export interface LangfuseKeys {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

export interface ToolTrace {
  tool: string;
  outcome: string;
  assistant: Assistant;
  totalMs?: number;
  gmailMs?: number;
  filterMs?: number;
  decisions?: Decision[];
  errorType?: string;
  errorRef?: string | null;
}

export type Tracer = (t: ToolTrace) => Promise<void>;

const TIMEOUT_MS = 800;
const TOOLS = new Set(["search_email", "read_email"]);
const ASSISTANTS = new Set<string>(["claude", "chatgpt", "gemini", "perplexity", "muse", "unknown"]);
const REASONS = new Set<string>(["medical", "financial", MODEL_UNAVAILABLE, "couldn't remove safely", DOCUMENT_NAME, ...Object.values(ITEM_LABELS)]);

const word = (s: string | undefined | null) => (s && /^[a-z_]{1,40}$/.test(s) ? s : undefined);
const ms = (n: number | undefined) => (Number.isFinite(n) ? Math.max(0, Math.round(n!)) : undefined);

/** The only data that leaves: fixed names and counts. Anything unexpected is dropped or relabelled. */
export function traceFields(t: ToolTrace) {
  const decisions = t.decisions ?? [];
  const count = (action: Decision["action"]) => decisions.filter((d) => d.action === action).length;
  const reasons: Record<string, number> = {};
  for (const d of decisions) {
    for (const b of d.because) {
      const r = REASONS.has(b) ? b : "other";
      reasons[r] = (reasons[r] ?? 0) + 1;
    }
  }
  return {
    tool: TOOLS.has(t.tool) ? t.tool : "unknown",
    assistant: ASSISTANTS.has(t.assistant) ? t.assistant : "unknown",
    outcome: word(t.outcome) ?? "unknown",
    prompt_version: PROMPT_VERSION,
    emails: { shared: count("shared"), redacted: count("redacted"), withheld: count("withheld") },
    reasons,
    total_ms: ms(t.totalMs),
    gmail_ms: ms(t.gmailMs),
    filter_ms: ms(t.filterMs),
    error_type: word(t.errorType),
    error_ref: t.errorRef && /^[A-Za-z0-9]{1,8}$/.test(t.errorRef) ? t.errorRef : undefined,
  };
}

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });

export function traceBody(t: ToolTrace, now = Date.now()): string {
  const f = traceFields(t);
  const { tool, assistant, outcome, emails, reasons, total_ms, gmail_ms, filter_ms, error_type, error_ref, prompt_version } = f;
  const failed = outcome !== "ok" && outcome !== "limit";
  const nanos = (x: number) => `${x}000000`;
  return JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [str("service.name", "agent-gateway")] },
      scopeSpans: [{
        scope: { name: "agent-gateway" },
        spans: [{
          traceId: randomBytes(16).toString("hex"),
          spanId: randomBytes(8).toString("hex"),
          name: tool,
          kind: 1,
          startTimeUnixNano: nanos(now - (total_ms ?? 0)),
          endTimeUnixNano: nanos(now),
          attributes: [
            str("langfuse.environment", "production"),
            str("langfuse.observation.type", "span"),
            str("langfuse.trace.name", tool),
            { key: "langfuse.trace.tags", value: { arrayValue: { values: [{ stringValue: assistant }, { stringValue: outcome }] } } },
            str("langfuse.observation.level", failed ? "ERROR" : "DEFAULT"),
            str("langfuse.observation.input", JSON.stringify({ tool, assistant, prompt_version })),
            str("langfuse.observation.output", JSON.stringify({ outcome, emails, reasons, total_ms, gmail_ms, filter_ms, error_type, error_ref })),
          ],
        }],
      }],
    }],
  });
}

export function createTracer(keys: LangfuseKeys | undefined, send: typeof fetch = fetch): Tracer {
  if (!keys) return async () => {};
  const authorization = `Basic ${Buffer.from(`${keys.publicKey}:${keys.secretKey}`).toString("base64")}`;
  return async (t) => {
    try {
      // Awaited because Lambda can freeze as soon as it responds; bounded so a slow Langfuse can't hold a search up.
      const res = await send(`${keys.baseUrl}/api/public/otel/v1/traces`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: traceBody(t),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) logEvent("trace_rejected", { status: res.status });
    } catch (e) {
      logEvent("trace_failed", { type: e instanceof Error ? e.name : "unknown" });
    }
  };
}
