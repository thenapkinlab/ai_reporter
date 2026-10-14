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
}

export function parseThreshold(raw: string | undefined): number {
  const t = Number(raw);
  return Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.6;
}
