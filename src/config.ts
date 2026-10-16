// Runtime configuration. The Lambda entry point fills secrets from SSM Parameter Store;
// the local dev server fills them with throwaway values.

export interface Config {
  authkitDomain: string;
  workosClientId: string;
  workosApiKey: string;
  googleClientId: string;
  googleClientSecret: string;
  /** base64 of 32 random bytes; signs dashboard cookies and OAuth state. */
  sessionSecret: string;
  withholdThreshold: number;
  /** Required `aud` on MCP tokens, if set (your gateway's /mcp URL). */
  mcpAudience?: string;
  /** Local dev only: test user, synthetic mailbox, "Bearer dev" on /mcp. Never set on Lambda. */
  dev: boolean;
  /** Usage limits; defaults to DEFAULT_LIMITS. */
  limits?: Limits;
  /** Only emails on the tester allow list can sign in or use the connector (`npm run testers`). */
  inviteOnly?: boolean;
  /** Where testers can reach the person running the beta (shown on the notice and guide). */
  contactEmail?: string;
}

export interface Limits {
  /** Emails one user's assistants can have checked per 10 minutes, and per UTC day. */
  emailsPer10Min: number;
  emailsPerDay: number;
  /** Classifier requests per minute across all users (the account's Bedrock quota, minus headroom). */
  modelRequestsPerMinute: number;
}

export const DEFAULT_LIMITS: Limits = { emailsPer10Min: 100, emailsPerDay: 500, modelRequestsPerMinute: 18 };

export function parseLimits(env: Record<string, string | undefined>): Limits {
  const n = (raw: string | undefined, fallback: number) => {
    const x = Number(raw);
    return Number.isInteger(x) && x > 0 ? x : fallback;
  };
  return {
    emailsPer10Min: n(env.USER_EMAILS_PER_10MIN, DEFAULT_LIMITS.emailsPer10Min),
    emailsPerDay: n(env.USER_EMAILS_PER_DAY, DEFAULT_LIMITS.emailsPerDay),
    modelRequestsPerMinute: n(env.MODEL_REQUESTS_PER_MINUTE, DEFAULT_LIMITS.modelRequestsPerMinute),
  };
}

export function parseThreshold(raw: string | undefined): number {
  const t = Number(raw);
  return Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.6;
}
