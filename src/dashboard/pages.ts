// Server-rendered dashboard pages. Every dynamic value goes through esc().

import type { RunItemRow, RunRow, Totals } from "../store/types";

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root{--bg:#f5f7f8;--surface:#fff;--fg:#17212a;--muted:#56636f;--line:#d9e0e5;--accent:#0d7a72;--accent-soft:#e1f2f0;
--ok:#2f7d4f;--ok-bg:#e4f3ea;--stop:#b4462f;--stop-bg:#fbe9e4;--warn:#8a5a00;--warn-bg:#fbf0d6;--chip:#eef2f4}
@media (prefers-color-scheme:dark){:root{--bg:#11171c;--surface:#182129;--fg:#e4eaee;--muted:#9aa8b3;--line:#2b3741;--accent:#4fc2b6;
--accent-soft:#163430;--ok:#7fd3a0;--ok-bg:#173326;--stop:#f29a85;--stop-bg:#3a1f19;--warn:#e8c46f;--warn-bg:#352a12;--chip:#1f2a33;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:var(--surface);border-bottom:1px solid var(--line)}
.bar{max-width:980px;margin:0 auto;padding:12px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.brand{font-weight:700;margin-right:auto}.bar a{color:var(--muted);text-decoration:none}.bar a.on{color:var(--fg);font-weight:600}
main{max-width:980px;margin:0 auto;padding:24px 20px 64px}
h1{font-size:26px;margin:0 0 6px}h2{font-size:19px;margin:28px 0 10px}p{max-width:68ch}
.muted{color:var(--muted)}a{color:var(--accent)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:16px 0}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.tile b{display:block;font-size:28px;font-variant-numeric:tabular-nums}.tile span{color:var(--muted);font-size:13px}
.chip{display:inline-block;font:12px/1.6 ui-monospace,Menlo,monospace;padding:1px 8px;border-radius:99px;background:var(--chip);color:var(--muted);white-space:nowrap}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.c-shared{background:var(--ok-bg);color:var(--ok)}.c-withheld{background:var(--stop-bg);color:var(--stop)}.c-redacted{background:var(--warn-bg);color:var(--warn)}
.c-bg{background:var(--accent-soft);color:var(--accent)}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;font-size:15px}
th{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.scroll{overflow-x:auto}td .chips{display:flex;gap:6px;flex-wrap:wrap}
.btn{display:inline-block;border:1px solid var(--line);background:var(--surface);color:var(--fg);border-radius:8px;padding:7px 14px;font:inherit;cursor:pointer;text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}.btn.danger{color:var(--stop);border-color:var(--stop)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
form.inline{display:inline}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
code{font:13px ui-monospace,Menlo,monospace;background:var(--chip);padding:2px 6px;border-radius:4px;word-break:break-all}
ol li{margin:6px 0;max-width:70ch}.notice{background:var(--accent-soft);border-radius:10px;padding:12px 16px;margin:12px 0}
`;

export interface Nav {
  email: string;
  active: "setup" | "activity" | "settings" | "";
  dev: boolean;
}

/** AGPL-3.0 section 13: people using the service over the network can get its source. */
export const SOURCE_URL = "https://github.com/thenapkinlab/ai_reporter";

export function layout(title: string, body: string, nav: Nav | null): string {
  const link = (href: string, key: Nav["active"], label: string) =>
    `<a href="${href}" class="${nav?.active === key ? "on" : ""}">${label}</a>`;
  const navHtml = nav
    ? `${link("/activity", "activity", "Activity")}${link("/setup", "setup", "Setup")}${link("/settings", "settings", "Settings")}
       <span class="muted">${esc(nav.email)}${nav.dev ? " · dev mode" : ""}</span>
       <form class="inline" method="post" action="/logout"><button class="btn">Sign out</button></form>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Private Gmail</title><style>${CSS}</style></head>
<body><header><div class="bar"><span class="brand">Private Gmail</span>${navHtml}</div></header><main>${body}</main>
<footer class="muted" style="max-width:960px;margin:24px auto;padding:0 16px">Open source under the AGPL-3.0:
<a href="${SOURCE_URL}">source code</a> · <a href="/notice">beta notice</a> · <a href="/guide">tester guide</a></footer></body></html>`;
}

export function html(page: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(page, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

export function landingPage(dev: boolean): string {
  return layout(
    "Welcome",
    `<h1>See what your AI reads in your email</h1>
     <p class="muted">Private Gmail sits between Claude or ChatGPT and your inbox. It holds back medical and financial
     emails, hides values like card numbers, and shows you every email your assistant read.</p>
     <p><a class="btn primary" href="/login">Sign in</a></p>
     <div class="notice">Invite-only beta. This is a personal, experimental project. Read the <a href="/notice">beta notice</a>
     and the <a href="/guide">tester guide</a> before you connect Gmail.</div>
     ${dev ? `<p class="muted">Dev mode is on: sign-in uses a local test user and a synthetic mailbox.</p>` : ""}`,
    null,
  );
}

const contact = (email: string | null) =>
  email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : "the person who invited you";

export function notInvitedPage(email: string, contactEmail: string | null): string {
  return layout(
    "Invite only",
    `<h1>This beta is invite-only</h1>
     <p>${email ? `<b>${esc(email)}</b> isn't on the tester list yet.` : "Your account isn't on the tester list yet."}
     To join, contact ${contact(contactEmail)} with the email address you sign in with and the Gmail address you'd connect.</p>
     <p class="muted">Nothing about you was stored.</p>
     <p><a href="/guide">Read the tester guide</a></p>`,
    null,
  );
}

export function noticePage(contactEmail: string | null): string {
  return layout(
    "Beta notice",
    `<h1>Beta notice</h1>
     <p>Please read this before you connect Gmail. It's short, and it's the whole deal.</p>

     <h2>What this is</h2>
     <p>A personal, experimental project run by one person in their own time. It isn't a company product, it comes with no
     guarantees, and it may change or shut down. Contact: ${contact(contactEmail)}.</p>

     <h2>What happens when your assistant reads email</h2>
     <ul>
       <li>Only the emails your assistant (Claude or ChatGPT) asks for are fetched from Gmail, read-only. Your inbox is never scanned in the background.</li>
       <li>Medical and financial emails (lab results, bank statements, payslips…) are withheld completely.</li>
       <li>In other emails, card and bank numbers, ID numbers, passwords and keys, one-time codes, home addresses and dates of birth are
       replaced with <code>[removed: …]</code>.</li>
       <li>Attachments are never opened or sent. The assistant only sees their names.</li>
       <li>Everything that isn't withheld or removed goes to your assistant and is handled under that assistant's own terms.</li>
     </ul>

     <h2>The filter can make mistakes</h2>
     <p>In testing it removes about 96 to 100% of sensitive values and withholds about 96% of medical and financial emails, so it
     sometimes misses one. Don't connect an inbox where a single slip would be serious. If you see something that should have been
     removed, press "Something leaked" on your dashboard.</p>

     <h2>What is stored, and for how long</h2>
     <ul>
       <li>Your sign-in email, your Gmail address, and your Gmail access token (encrypted). Until you disconnect or delete your account.</li>
       <li>For each request: time, which assistant, the search your assistant ran (for example "flight newer_than:2m"), and counts. 90 days.
       Note that a search can itself say something about you.</li>
       <li>For each email: its Gmail ID (for "Open in Gmail"), the decision, the reason types, and your feedback. 7 days.</li>
       <li>Usage counters and service-wide daily totals with no personal data.</li>
       <li><b>Never stored:</b> email bodies, subjects, senders, attachments, or the sensitive values themselves.</li>
     </ul>

     <h2>Where, and who's involved</h2>
     <p>The service runs on Amazon Web Services in Stockholm (EU), and the filter's AI model runs on Amazon Bedrock in EU regions.
     Sign-in uses WorkOS. Gmail access uses Google's API. Only you see your dashboard. The person running the beta can technically
     access the stored records above to operate the service, but never email content, because it isn't kept.</p>

     <h2>Leaving</h2>
     <p>Disconnect Gmail on Setup, or delete everything in Settings → "Delete my data", which also revokes our Google access. You can
     also remove access in your Google Account → Security → Third-party connections.</p>`,
    null,
  );
}

export function guidePage(mcpUrl: string, contactEmail: string | null): string {
  return layout(
    "Tester guide",
    `<h1>Tester guide</h1>
     <p>Thanks for testing! This gateway sits between your AI assistant and Gmail: it holds back medical and financial emails, removes
     sensitive values from the rest, and shows you everything your assistant read. Setup takes about 5 minutes.</p>

     <h2>Before you start</h2>
     <ul>
       <li>A Gmail account, and Claude or ChatGPT (ChatGPT needs Plus or higher and Developer Mode for custom connectors).</li>
       <li>An invite: send ${contact(contactEmail)} the email you'll sign in with and the Gmail address you'll connect.
       Wait for a confirmation before setting up; Google blocks addresses that haven't been added yet.</li>
       <li>Read the <a href="/notice">beta notice</a>.</li>
     </ul>

     <h2>Setup</h2>
     <ol>
       <li><b>Sign in</b> on the <a href="/">home page</a> with your invited email.</li>
       <li><b>Connect Gmail</b> on the Setup page. Google will warn that it "hasn't verified this app": choose
       <b>Advanced → Go to … (unsafe)</b> and allow read-only access. That's expected for a small beta.</li>
       <li><b>Add the connector</b> to your assistant with this URL: <code>${esc(mcpUrl)}</code>. The Setup page has step-by-step
       instructions for Claude and ChatGPT. Sign in with the same account when your assistant asks.</li>
       <li><b>Turn off your assistant's built-in Gmail connector.</b> Otherwise it can read your email without going through the filter.</li>
     </ol>

     <h2>Try it</h2>
     <ul>
       <li>"When is my next flight?" or "Find my hotel bookings from the last 2 months."</li>
       <li>"Where are my recent orders?" Delivery addresses should show as <code>[removed: home address]</code>.</li>
       <li>"Show my latest bank statement." It should be withheld.</li>
       <li>Ask about newsletters, receipts, meetings: anything you'd normally ask.</li>
     </ul>

     <h2>Tell us what happens</h2>
     <ul>
       <li><b>Activity</b> shows every request and every email your assistant read, with "Open in Gmail" to compare.</li>
       <li>If something sensitive got through: <b>Something leaked</b>, and pick what it was. Only the type is recorded.</li>
       <li>If something was withheld that shouldn't have been: <b>Release next time</b>.</li>
       <li>Anything else (confusing steps, slow answers, ideas): email ${contact(contactEmail)}.</li>
     </ul>

     <h2>Good to know</h2>
     <ul>
       <li>Limits: 100 emails per 10 minutes and 500 per day. If the filter is busy, your assistant will say so; try again in a minute.</li>
       <li>Attachment contents are never shared, only their names.</li>
       <li>Delete everything any time in Settings.</li>
     </ul>`,
    null,
  );
}

export function devLoginPage(): string {
  return layout(
    "Dev sign-in",
    `<h1>Dev sign-in</h1><p class="muted">Local only. Signs you in as a test user with a synthetic mailbox.</p>
     <form method="post" action="/dev-login"><button class="btn primary">Continue as dev user</button></form>`,
    null,
  );
}

export function setupPage(
  nav: Nav,
  mcpUrl: string,
  gmail: { address: string } | null,
): string {
  const gmailCard = gmail
    ? `<div class="card"><b>Gmail connected:</b> ${esc(gmail.address)}
         <form class="inline" method="post" action="/gmail/disconnect"><button class="btn">Disconnect</button></form></div>`
    : `<div class="card"><b>Step 1. Connect Gmail.</b> Read-only access through Google's own sign-in screen. We never see your password.
         <form method="get" action="/gmail/connect">
           <p><label class="row"><input type="checkbox" name="ack" value="1" required> I've read the <a href="/notice" target="_blank" rel="noopener">beta notice</a>: what's read, what's stored, and that the filter can make mistakes.</label></p>
           <p><button class="btn primary">Connect Gmail</button></p>
         </form>
         <p class="muted">Google will say it "hasn't verified this app". That's expected for a small beta: choose <b>Advanced → Go to … (unsafe)</b>, then allow read-only access.</p></div>`;
  return layout(
    "Setup",
    `<h1>Setup</h1>
     ${gmailCard}
     <div class="card"><b>Step 2. Your connector URL</b>
       <p><code id="u">${esc(mcpUrl)}</code></p>
       <p class="muted">Paste this into your assistant as a custom connector.</p></div>
     <h2>Claude</h2>
     <ol>
       <li>Open Claude: <b>Settings → Connectors → Add custom connector</b>.</li>
       <li>Name it "Private Gmail", paste the URL above, click Add.</li>
       <li>Sign in with this same account when Claude asks, and approve.</li>
       <li><b>Turn off Claude's built-in Gmail connector</b>, and remove Claude in Google Account → Security → Third-party connections.</li>
     </ol>
     <h2>ChatGPT (Plus or higher, on the web)</h2>
     <ol>
       <li>Open chatgpt.com: <b>Settings → Apps → Advanced</b> and turn on <b>Developer Mode</b>.</li>
       <li>Click <b>Create</b>, name it "Private Gmail", paste the URL above, choose OAuth, save.</li>
       <li>Sign in with this same account when ChatGPT asks, and approve.</li>
       <li>In a chat, pick the connector from the <b>+</b> menu.</li>
       <li><b>Disconnect ChatGPT's built-in Gmail</b> in Settings → Apps, and remove OpenAI in Google Account → Security → Third-party connections.</li>
     </ol>
     <div class="notice">If an assistant's built-in Gmail stays connected, it can read your email without going through this filter.</div>`,
    nav,
  );
}

const ASSISTANT: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", unknown: "Unknown assistant" };

function when(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

const LEAK_OPTIONS = [
  ["home_address", "Home address"], ["date_of_birth", "Date of birth"], ["card_number", "Card number"], ["bank_account", "Bank account"],
  ["government_id", "ID number"], ["credentials", "Password or key"], ["one_time_code", "One-time code"], ["other", "Something else"],
].map(([v, l]) => `<option value="${v}">${l}</option>`).join("");

const ACTION_LABEL: Record<string, string> = { shared: "shared", redacted: "values removed", withheld: "withheld" };

function runChips(r: RunRow): string {
  const c: string[] = [];
  if (r.run_type === "background_likely") c.push(`<span class="chip c-bg">background, likely</span>`);
  if (r.shared_count) c.push(`<span class="chip c-shared">${r.shared_count} shared</span>`);
  if (r.redacted_count) c.push(`<span class="chip c-redacted">${r.redacted_count} values removed</span>`);
  if (r.withheld_count) c.push(`<span class="chip c-withheld">${r.withheld_count} withheld</span>`);
  if (!c.length) c.push(`<span class="chip">no emails</span>`);
  return c.join("");
}

function breakdown(title: string, counts: Record<string, number>, label: (k: string) => string = (k) => k): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "";
  return `<div class="card"><b>${esc(title)}</b><div class="chips" style="margin-top:8px">${entries
    .map(([k, v]) => `<span class="chip">${esc(label(k))} · ${v}</span>`)
    .join("")}</div></div>`;
}

export function activityPage(
  nav: Nav,
  totals: Totals,
  runs: RunRow[],
  gmailConnected: boolean,
  usage?: { today: number; perDay: number },
): string {
  const rows = runs
    .map(
      (r) => `<tr><td>${esc(when(r.created_at))}</td><td>${esc(ASSISTANT[r.assistant] ?? r.assistant)}<br><span class="muted">${esc(r.tool)}</span></td>
        <td>${esc(r.query ?? "")}</td><td><div class="chips">${runChips(r)}</div></td>
        <td><a href="/runs/${encodeURIComponent(r.id)}">Emails</a></td></tr>`,
    )
    .join("");
  return layout(
    "Activity",
    `<h1>Activity</h1>
     ${gmailConnected ? "" : `<div class="notice">Gmail isn't connected yet. <a href="/setup">Finish setup</a>.</div>`}
     <p class="muted">Last 7 days${usage ? ` · today ${usage.today} of ${usage.perDay} emails checked (resets 00:00 UTC)` : ""}</p>
     <div class="tiles">
       <div class="tile"><b>${totals.read}</b><span>emails your assistants read</span></div>
       <div class="tile"><b>${totals.withheld}</b><span>withheld</span></div>
       <div class="tile"><b>${totals.redacted}</b><span>shared with values removed</span></div>
       <div class="tile"><b>${totals.read - totals.withheld - totals.redacted}</b><span>shared unchanged</span></div>
       <div class="tile"><b>${totals.background}</b><span>runs that look like background tasks</span></div>
     </div>
     ${breakdown("Withheld or removed because", totals.byReason)}
     ${breakdown("Emails read by assistant", totals.byAssistant, (k) => ASSISTANT[k] ?? k)}
     <h2>Recent requests</h2>
     ${
       runs.length
         ? `<div class="scroll"><table><thead><tr><th>When</th><th>Assistant</th><th>Asked for</th><th>Result</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
         : `<div class="card">No activity yet. Ask Claude or ChatGPT about your email after connecting it.</div>`
     }
     <p class="muted">We keep each request (assistant, what it asked for, counts) for 90 days, and which emails it touched for 7 days.
     We never store email content, subjects or senders.</p>`,
    nav,
  );
}

/** Opens the message in the user's own Gmail. Our server never reads its subject or content for this. */
export function gmailLink(messageId: string, gmailAddress: string | null): string {
  const account = gmailAddress ? `?authuser=${encodeURIComponent(gmailAddress)}` : "";
  return `https://mail.google.com/mail/u/${account}#all/${encodeURIComponent(messageId)}`;
}

export function runPage(nav: Nav, run: RunRow, items: RunItemRow[], gmailAddress: string | null): string {
  const rows = items
    .map((i) => {
      const actionChip = `<span class="chip c-${esc(i.action)}">${esc(ACTION_LABEL[i.action] ?? i.action)}</span>`;
      const because = i.because ? `<div class="chips">${i.because.split(", ").map((b) => `<span class="chip">${esc(b)}</span>`).join("")}</div>` : `<span class="muted">–</span>`;
      const fb = i.feedback ? `<span class="muted">You ${i.feedback.startsWith("reported") ? "" : "chose: "}${esc(i.feedback)}</span>` : "";
      const hidden = `<input type="hidden" name="run" value="${esc(run.id)}"><input type="hidden" name="message" value="${esc(i.message_id)}">`;
      // Withheld: let the user release it. Shared or redacted: let them report a value that got through.
      const buttons =
        i.action === "withheld"
          ? `<form class="inline" method="post" action="/feedback">${hidden}
               <button class="btn" name="decision" value="release">Release next time</button>
               <button class="btn" name="decision" value="keep">Keep protected</button></form>`
          : `<form class="inline" method="post" action="/feedback">${hidden}
               <label class="sr" for="leak-${esc(i.message_id)}">What got through</label>
               <select name="item" id="leak-${esc(i.message_id)}">${LEAK_OPTIONS}</select>
               <button class="btn" name="decision" value="leak">Something leaked</button></form>`;
      return `<tr><td>${actionChip}</td><td>${because}</td>
        <td><a href="${esc(gmailLink(i.message_id, gmailAddress))}" target="_blank" rel="noopener">Open in Gmail ↗</a></td>
        <td><div class="row">${buttons}${fb}</div></td></tr>`;
    })
    .join("");
  const body = items.length
    ? `<div class="scroll"><table><thead><tr><th>Result</th><th>Why</th><th>Email</th><th>Your decision</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="card">Email details for this request have expired. We keep them for 7 days.</div>`;
  return layout(
    "Request",
    `<p><a href="/activity">← Activity</a></p>
     <h1>${esc(ASSISTANT[run.assistant] ?? run.assistant)} · ${esc(run.tool)}</h1>
     <p class="muted">${esc(when(run.created_at))} · asked for “${esc(run.query ?? "")}” · ${runChips(run)}</p>
     <p class="muted">"Open in Gmail" opens the email in your own Gmail. We don't store or fetch its subject or content.
     If you see a value that should have been removed, pick its type and press "Something leaked": we record only the type,
     never the value, and use it to improve the filter.</p>
     ${body}`,
    nav,
  );
}

export function settingsPage(nav: Nav, s: { medical: boolean; financial: boolean }, threshold: number): string {
  const box = (name: string, on: boolean, label: string) =>
    `<label class="row"><input type="checkbox" name="${name}" id="${name}" ${on ? "checked" : ""}> ${label}</label>`;
  return layout(
    "Settings",
    `<h1>Settings</h1>
     <form method="post" action="/settings" class="card">
       <b>Withhold these emails from assistants</b>
       ${box("medical", s.medical, "Medical: lab results, prescriptions, clinic letters, health insurance")}
       ${box("financial", s.financial, "Financial: bank and card statements, tax documents, payslips, loans")}
       <p class="muted">An email is withheld when the classifier is at least ${(threshold * 100).toFixed(0)}% confident.
       In every other email, card or bank account numbers, government IDs, passwords or keys, one-time codes,
       home addresses and dates of birth are always removed and replaced with [removed: …]. If a value can't be
       removed reliably, the whole email is withheld.</p>
       <button class="btn primary">Save</button>
     </form>
     <form method="post" action="/account/delete" class="card">
       <b>Delete my data</b>
       <p class="muted">Disconnects Gmail, revokes our Google access, and deletes your activity, labels and settings.</p>
       <label class="row"><input type="checkbox" name="confirm" id="confirm" required> I understand this can't be undone</label>
       <p><button class="btn danger">Delete everything</button></p>
     </form>`,
    nav,
  );
}

export function messagePage(title: string, message: string, nav: Nav | null): string {
  return layout(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">Home</a></p>`, nav);
}
