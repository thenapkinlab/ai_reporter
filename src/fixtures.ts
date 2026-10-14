// Synthetic mailbox for local dev and tests. Every value is fake: card 4111… is a published
// test number, the IBAN is the standard example, the AWS key is AWS's documentation example.

import type { Email, Mailbox } from "./mail";

const enc = new TextEncoder();

function textAttachment(filename: string, text: string) {
  const bytes = enc.encode(text);
  return { filename, mimeType: "text/plain", size: bytes.length, load: async () => bytes };
}

export const FIXTURE_EMAILS: Email[] = [
  {
    id: "fx-lab",
    from: "MyChart <noreply@mychart.org>",
    subject: "Your lab results are ready",
    date: "2026-10-05T07:12:00Z",
    snippet: "Your blood test results from Oct 3 are now available.",
    body: "Hello Alex,\n\nYour lab results are ready. Glucose 98 mg/dL, Hemoglobin 13.5 g/dL.\nYour physician will follow up.\n\nPatient portal",
    attachments: [],
  },
  {
    id: "fx-statement",
    from: "HDFC Bank <alerts@hdfcbank.net>",
    subject: "Your account statement for September",
    date: "2026-10-04T05:00:00Z",
    snippet: "Your account statement is ready. Available balance as of 30 Sep.",
    body: "Dear customer, your account statement is ready.\nAccount number: 50100234567890\nAvailable balance: INR 1,24,500.00",
    attachments: [textAttachment("statement-sep.txt", "Account statement\nIBAN GB82 WEST 1234 5698 7654 32\nClosing balance 4,210.55")],
  },
  {
    id: "fx-card-receipt",
    from: "Bookshop <orders@bookshop.example>",
    subject: "Your order #4471 has shipped",
    date: "2026-10-03T16:20:00Z",
    snippet: "Thanks for your order. Paid with card 4111 1111 1111 1111.",
    body: "Thanks for your order of 2 books.\nPaid with card 4111 1111 1111 1111.\nTotal: $34.90",
    attachments: [],
  },
  {
    id: "fx-otp",
    from: "Acme Login <security@acme.example>",
    subject: "Your sign-in code",
    date: "2026-10-05T09:01:00Z",
    snippet: "Your verification code is 482913.",
    body: "Your verification code is 482913. It expires in 10 minutes.",
    attachments: [],
  },
  {
    id: "fx-newsletter",
    from: "FitLife Weekly <news@fitlife.example>",
    subject: "5 habits for better sleep",
    date: "2026-10-02T12:00:00Z",
    snippet: "This week: sleep, stretching and a smoothie recipe.",
    body: "This week: five habits for better sleep, a stretching routine, and a smoothie recipe. Unsubscribe anytime.",
    attachments: [],
  },
  {
    id: "fx-flight",
    from: "Example Air <booking@exampleair.example>",
    subject: "Flight confirmation: SFO to JFK",
    date: "2026-10-01T10:30:00Z",
    snippet: "Your flight on Oct 20 is confirmed. Confirmation ABC123.",
    body: "Your flight EA 42 from SFO to JFK on Oct 20 is confirmed. Confirmation code ABC123. Seat 14C.",
    attachments: [],
  },
  {
    id: "fx-aws-key",
    from: "Sam (Dev) <sam@startup.example>",
    subject: "Staging credentials",
    date: "2026-09-30T18:45:00Z",
    snippet: "Here are the staging creds you asked for.",
    body: "Here are the staging creds:\naws key AKIAIOSFODNN7EXAMPLE\npassword: hunter2-staging\nPlease rotate after use.",
    attachments: [],
  },
  {
    id: "fx-payslip",
    from: "Payroll <payroll@gusto.com>",
    subject: "Your payslip for September is available",
    date: "2026-09-30T08:00:00Z",
    snippet: "Your pay stub for the period ending Sep 30 is ready.",
    body: "Your payslip for September is available. Net pay deposited by direct deposit.",
    attachments: [],
  },
];

export class FixtureMailbox implements Mailbox {
  constructor(private emails: Email[] = FIXTURE_EMAILS) {}

  async search(query: string, max: number): Promise<string[]> {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t && !t.includes(":"));
    const match = (e: Email) => {
      const hay = `${e.from} ${e.subject} ${e.body}`.toLowerCase();
      return terms.length === 0 || terms.some((t) => hay.includes(t));
    };
    return this.emails.filter(match).slice(0, max).map((e) => e.id);
  }

  async get(id: string): Promise<Email> {
    const e = this.emails.find((x) => x.id === id);
    if (!e) throw new Error(`No message ${id}`);
    return e;
  }

  async headers(ids: string[]): Promise<Record<string, { subject: string; from: string }>> {
    const out: Record<string, { subject: string; from: string }> = {};
    for (const id of ids) {
      const e = this.emails.find((x) => x.id === id);
      out[id] = e ? { subject: e.subject, from: e.from } : { subject: "(no longer available)", from: "" };
    }
    return out;
  }
}
