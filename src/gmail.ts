// Google OAuth for Gmail (read-only) and a Mailbox backed by the Gmail API.

import { b64urlToBytes } from "./crypto";
import type { Attachment, Email, Mailbox, SearchPage } from "./mail";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export function googleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) throw new Error(`Google token error: ${json.error ?? res.status} ${json.error_description ?? ""}`);
  return json;
}

export function exchangeCode(code: string, clientId: string, clientSecret: string, redirectUri: string) {
  return tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
}

export async function refreshAccessToken(refreshToken: string, clientId: string, clientSecret: string): Promise<string> {
  const t = await tokenRequest({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  return t.access_token;
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
}

export async function gmailAddress(accessToken: string): Promise<string> {
  const res = await fetch(`${API}/profile`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Gmail profile error ${res.status}`);
  return ((await res.json()) as { emailAddress: string }).emailAddress;
}

// ---- message parsing ----

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

function header(part: GmailPart | undefined, name: string): string {
  return part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeData(data: string): string {
  return new TextDecoder().decode(b64urlToBytes(data));
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/** Walks the MIME tree: prefers text/plain, falls back to stripped HTML, collects attachments. */
export function parseParts(root: GmailPart | undefined): {
  body: string;
  attachments: { filename: string; mimeType: string; size: number; attachmentId?: string; data?: string }[];
} {
  let plain = "";
  let html = "";
  const attachments: { filename: string; mimeType: string; size: number; attachmentId?: string; data?: string }[] = [];
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    if (p.filename) {
      attachments.push({
        filename: p.filename,
        mimeType: p.mimeType ?? "application/octet-stream",
        size: p.body?.size ?? 0,
        attachmentId: p.body?.attachmentId,
        data: p.body?.data,
      });
    } else if (p.body?.data && p.mimeType === "text/plain") {
      plain += decodeData(p.body.data) + "\n";
    } else if (p.body?.data && p.mimeType === "text/html") {
      html += decodeData(p.body.data) + "\n";
    }
    p.parts?.forEach(walk);
  };
  walk(root);
  return { body: (plain.trim() || htmlToText(html)).slice(0, 50000), attachments };
}

export class GmailMailbox implements Mailbox {
  constructor(private accessToken: string) {}

  private async api<T>(path: string): Promise<T> {
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${this.accessToken}` } });
    if (!res.ok) throw new Error(`Gmail API ${res.status} on ${path.split("?")[0]}`);
    return (await res.json()) as T;
  }

  async search(query: string, max: number, pageToken?: string): Promise<SearchPage> {
    const p = new URLSearchParams({ q: query, maxResults: String(max) });
    if (pageToken) p.set("pageToken", pageToken);
    const r = await this.api<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${p}`);
    return { ids: (r.messages ?? []).map((m) => m.id), nextPageToken: r.nextPageToken ?? null };
  }

  async get(id: string): Promise<Email> {
    const m = await this.api<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
    const { body, attachments } = parseParts(m.payload);
    // Names, types and sizes only: attachment contents are never downloaded.
    const atts: Attachment[] = attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.size }));
    return {
      id: m.id,
      from: header(m.payload, "From"),
      subject: header(m.payload, "Subject"),
      date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : header(m.payload, "Date"),
      snippet: m.snippet ?? "",
      body,
      attachments: atts,
    };
  }

}
