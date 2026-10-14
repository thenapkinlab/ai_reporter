// Operational counters for CloudWatch alarms, written as Embedded Metric Format log lines: Lambda's
// log group turns them into metrics with no extra API calls. Counts only, no dimensions: never a
// user ID, query or anything about an email.

export const NAMESPACE = "AgentGateway";

export type MetricName =
  /** A request was refused because the shared classifier budget was full. */
  | "ModelBusy"
  /** Emails withheld because the model gave no answer for them (errors, throttling). */
  | "ModelUnavailable"
  /** A request hit a user's 10-minute or daily email limit. */
  | "UserLimitReached";

export function countMetric(name: MetricName, value = 1): void {
  if (value <= 0) return;
  console.log(
    JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: NAMESPACE, Dimensions: [[]], Metrics: [{ Name: name, Unit: "Count" }] }] },
      [name]: value,
    }),
  );
}
