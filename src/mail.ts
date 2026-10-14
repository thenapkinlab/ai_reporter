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

export interface SearchPage {
  ids: string[];
  /** Pass back to get the next page; null when there are no more results. */
  nextPageToken: string | null;
}

export interface Mailbox {
  /** Returns message IDs matching a Gmail search query, newest first, one page at a time. */
  search(query: string, max: number, pageToken?: string): Promise<SearchPage>;
  get(id: string): Promise<Email>;
}

export function senderDomain(from: string): string {
  const m = from.match(/@([A-Za-z0-9.-]+)/);
  return (m?.[1] ?? "").toLowerCase();
}
