// Operational and product metrics for CloudWatch, written as Embedded Metric Format log lines:
// Lambda's log group turns them into metrics with no extra API calls.
//
// Privacy rule: values are counts and timings only, and dimensions come from small fixed sets
// (tool, outcome, action, reason type, prompt version, funnel step). Never a user ID, query,
// message ID, sender, or anything from an email.

export const NAMESPACE = "AgentGateway";

export type MetricName =
  /** A request was refused because the shared classifier budget was full. */
  | "ModelBusy"
  /** Emails withheld because the model gave no answer for them (errors, throttling). */
  | "ModelUnavailable"
  /** A request hit a user's 10-minute or daily email limit. */
  | "UserLimitReached"
  /** One MCP tool call, by Tool and Outcome. */
  | "ToolCalls"
  /** Timings of one tool call in milliseconds, by Tool: total, Gmail fetch, filter (classifier + redaction). */
  | "TotalMs"
  | "GmailMs"
  | "FilterMs"
  /** Emails decided, by Action (shared / redacted / withheld) and PromptVersion. */
  | "Emails"
  /** Why emails were withheld or redacted, by Reason (a fixed list of types). */
  | "Reasons"
  /** Dashboard feedback, by Kind (release / keep / leak) and Item (leak type, or "-"). */
  | "Feedback"
  /** Sign-in and Gmail connection steps, by Step. */
  | "Funnel"
  /** Daily totals from the nightly job, by Stat. */
  | "Daily";

type Unit = "Count" | "Milliseconds" | "Percent" | "None";

export interface Measure {
  name: MetricName;
  value: number;
  unit?: Unit;
}

/** Emits measures that share the same dimensions in one log line. */
export function emit(measures: Measure[], dimensions: Record<string, string> = {}): void {
  const ms = measures.filter((m) => Number.isFinite(m.value));
  if (!ms.length) return;
  const line: Record<string, unknown> = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        { Namespace: NAMESPACE, Dimensions: [Object.keys(dimensions)], Metrics: ms.map((m) => ({ Name: m.name, Unit: m.unit ?? "Count" })) },
      ],
    },
    ...dimensions,
  };
  for (const m of ms) line[m.name] = m.value;
  console.log(JSON.stringify(line));
}

export function countMetric(name: MetricName, value = 1, dimensions: Record<string, string> = {}): void {
  if (value <= 0) return;
  emit([{ name, value }], dimensions);
}
