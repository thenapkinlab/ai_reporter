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
.c-shared{background:var(--ok-bg);color:var(--ok)}.c-withheld{background:var(--stop-bg);color:var(--stop)}.c-redacted{background:var(--warn-bg);color:var(--warn)}
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
<body><header><div class="bar"><span class="brand">Private Gmail</span>${navHtml}</div></header><main>${body}</main></body></html>`;
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
     ${dev ? `<p class="muted">Dev mode is on: sign-in uses a local test user and a synthetic mailbox.</p>` : ""}`,
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
         <p><a class="btn primary" href="/gmail/connect">Connect Gmail</a></p></div>`;
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

function runChips(r: RunRow): string {
  const c: string[] = [];
  if (r.run_type === "background_likely") c.push(`<span class="chip c-bg">background, likely</span>`);
  if (r.shared_count) c.push(`<span class="chip c-shared">${r.shared_count} shared</span>`);
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

export function activityPage(nav: Nav, totals: Totals, runs: RunRow[], gmailConnected: boolean): string {
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
     <p class="muted">Last 7 days</p>
     <div class="tiles">
       <div class="tile"><b>${totals.read}</b><span>emails your assistants read</span></div>
       <div class="tile"><b>${totals.withheld}</b><span>withheld</span></div>
       <div class="tile"><b>${totals.read - totals.withheld}</b><span>shared</span></div>
       <div class="tile"><b>${totals.background}</b><span>runs that look like background tasks</span></div>
     </div>
     ${breakdown("Withheld because", totals.byReason)}
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
      const actionChip = `<span class="chip c-${esc(i.action)}">${esc(i.action)}</span>`;
      const because = i.because ? `<div class="chips">${i.because.split(", ").map((b) => `<span class="chip">${esc(b)}</span>`).join("")}</div>` : `<span class="muted">–</span>`;
      const fb = i.feedback ? `<span class="muted">You chose: ${esc(i.feedback)}</span>` : "";
      const buttons =
        i.action === "shared"
          ? ""
          : `<form class="inline" method="post" action="/feedback">
               <input type="hidden" name="run" value="${esc(run.id)}"><input type="hidden" name="message" value="${esc(i.message_id)}">
               <button class="btn" name="decision" value="release">Release next time</button>
               <button class="btn" name="decision" value="keep">Keep protected</button></form>`;
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
     <p class="muted">"Open in Gmail" opens the email in your own Gmail. We don't store or fetch its subject or content.</p>
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
       Emails containing card or bank account numbers, government IDs, passwords or keys, one-time codes,
       home addresses or dates of birth are always withheld.</p>
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
