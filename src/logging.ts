// Error logging that can't leak email. Only a fixed error type, an HTTP status, a provider's
// short error code and code locations are written: never an error's message, which can carry
// message IDs, addresses or model output. Each failure gets a short reference, which the assistant
// and the dashboard can show so a report can be matched to the log line.

import { randomId } from "./crypto";

export type ErrorType =
  | "gmail_auth_expired"
  | "gmail_not_found"
  | "gmail_rate_limited"
  | "gmail_api"
  | "model_throttled"
  | "model_timeout"
  | "model_access"
  | "model_unparseable"
  | "model_error"
  | "sign_in"
  | "storage"
  | "network"
  | "internal";

export interface ErrorInfo {
  type: ErrorType;
  status?: number;
  /** A provider's own short code, e.g. invalid_grant. Lower-case letters and underscores only. */
  code?: string;
}

export function classifyError(e: unknown): ErrorInfo {
  const name = e instanceof Error ? e.name : "";
  const msg = e instanceof Error ? e.message : String(e);
  let m: RegExpMatchArray | null;
  if ((m = msg.match(/^Google token error: ([a-z_]+)/))) return { type: "gmail_auth_expired", code: m[1]! };
  if ((m = msg.match(/^Gmail (?:API|profile error) (\d{3})/))) {
    const status = Number(m[1]);
    if (status === 401) return { type: "gmail_auth_expired", status };
    if (status === 404) return { type: "gmail_not_found", status };
    if (status === 429 || status === 403) return { type: "gmail_rate_limited", status };
    return { type: "gmail_api", status };
  }
  if ((m = msg.match(/^Sign-in failed: (\d{3})(?: ([a-z_]+))?/))) return { type: "sign_in", status: Number(m[1]), ...(m[2] ? { code: m[2] } : {}) };
  if (msg === "unparseable model output") return { type: "model_unparseable" };
  if (/Throttling|TooManyRequests/i.test(name)) return { type: "model_throttled" };
  if (/ModelTimeout|ModelNotReady|ServiceUnavailable|InternalServer|ModelError/i.test(name)) return { type: "model_timeout", code: safeCode(name) };
  if (/AccessDenied|Validation|ResourceNotFound/i.test(name)) return { type: "model_access", code: safeCode(name) };
  if (/ProvisionedThroughput|ConditionalCheck|DynamoDB|TransactionCanceled/i.test(name)) return { type: "storage", code: safeCode(name) };
  if (name === "TimeoutError" || name === "AbortError" || /fetch failed|ECONN|ENOTFOUND|socket/i.test(msg)) return { type: "network" };
  return { type: "internal", code: safeCode(name) };
}

const safeCode = (s: string) => s.replace(/[^A-Za-z]/g, "").slice(0, 40).toLowerCase() || undefined;

/** Code locations only: the first line of a stack holds the message, so it's dropped. */
function frames(e: unknown): string[] {
  if (!(e instanceof Error) || !e.stack) return [];
  return e.stack.split("\n").filter((l) => l.trim().startsWith("at ")).slice(0, 5).map((l) => l.trim().slice(0, 160));
}

export const newRef = () => randomId().replace(/[^A-Za-z0-9]/g, "").slice(0, 8);

/** Logs a failure without its message and returns the reference. `context` must hold fixed values only, never content. */
export function logError(event: string, e: unknown, context: Record<string, string | number> = {}): string {
  const ref = newRef();
  console.error(JSON.stringify({ level: "error", event, ref, ...classifyError(e), ...context, at: frames(e) }));
  return ref;
}

/** Logs something worth noticing that isn't an exception. `fields` must hold fixed values only, never content. */
export function logEvent(event: string, fields: Record<string, string | number | undefined> = {}): void {
  console.warn(JSON.stringify({ level: "warn", event, ...fields }));
}

/** What the assistant is told. Never includes the underlying error text. */
export function agentMessage(type: ErrorType, ref: string): string {
  const tail = ` If it keeps happening, tell the user to quote reference ${ref}.`;
  if (type === "gmail_auth_expired") return `Gmail access has expired or been revoked. Ask the user to reconnect it on the dashboard's Setup page. Reference ${ref}.`;
  if (type === "gmail_not_found") return `That email wasn't found. It may have been deleted, or the ID may be wrong. Reference ${ref}.`;
  if (type === "gmail_rate_limited") return `Gmail is limiting requests right now. Wait a minute and try again.${tail}`;
  if (type.startsWith("model_")) return `The privacy filter couldn't run, so no email was shared. Try again in a minute.${tail}`;
  return `The request failed. Try again in a minute.${tail}`;
}
