// Mail model shared by the Gmail client, the dev fixtures and the filter engine.

export interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
  /** Loads raw bytes on demand; attachments are never stored. */
  load: () => Promise<Uint8Array>;
}

export interface Email {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  attachments: Attachment[];
}

export interface Mailbox {
  /** Returns message IDs matching a Gmail search query, newest first. */
  search(query: string, max: number): Promise<string[]>;
  get(id: string): Promise<Email>;
  /** Live subject and sender lookup for the dashboard (nothing is stored). */
  headers(ids: string[]): Promise<Record<string, { subject: string; from: string }>>;
}

export function senderDomain(from: string): string {
  const m = from.match(/@([A-Za-z0-9.-]+)/);
  return (m?.[1] ?? "").toLowerCase();
}
