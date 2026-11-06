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

/** The name users see. Kept in one place so a rename is a one-line change. */
const BRAND = "Warded";

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
<title>${esc(title)} · ${BRAND}</title><style>${CSS}</style></head>
<body><header><div class="bar"><span class="brand">${BRAND}</span>${navHtml}</div></header><main>${body}</main>
<footer class="muted" style="max-width:960px;margin:24px auto;padding:0 16px">Open source under the AGPL-3.0:
<a href="${SOURCE_URL}">source code</a> · <a href="/privacy">privacy policy</a> · <a href="/notice">beta notice</a> · <a href="/guide">tester guide</a></footer></body></html>`;
}

export function html(page: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(page, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

export function landingPage(dev: boolean): string {
  return layout(
    "See what your AI reads in your email",
    `<h1>See what your AI reads in your email</h1>
     <p class="muted">${BRAND} sits between your AI assistant and your Gmail. It holds back medical and financial emails, removes
     values like card numbers and passwords, and shows you every email your assistant read.</p>
     <p class="row"><a class="btn primary" href="/login">Sign in</a><a class="btn" href="/guide">Read the tester guide</a></p>
     <div class="notice">Invite-only beta. This is a personal, open-source project, and the filter can make mistakes. Read the
     <a href="/notice">beta notice</a> before you connect Gmail.</div>

     <h2>How it works</h2>
     <ol>
       <li><b>Your assistant asks for email.</b> You connect ${BRAND} to your assistant as a custom connector, in place of its built-in Gmail access.</li>
       <li><b>${BRAND} checks each email first.</b> It fetches the email with read-only access, and a filter decides what your assistant may see.</li>
       <li><b>Your assistant gets the safe version.</b> The email is shared as it is, shared with sensitive values removed, or withheld.</li>
       <li><b>You can see what happened.</b> Your dashboard lists each request and decision, and you can release anything that was held back.</li>
     </ol>

     <h2>What it does with your email</h2>
     <ul>
       <li><b>Withheld:</b> medical and financial emails, by default.</li>
       <li><b>Removed:</b> home addresses, dates of birth, ID numbers, card and bank details, passwords, keys and one-time codes.</li>
       <li><b>Never opened:</b> attachments. Your assistant only sees their names.</li>
       <li><b>Never stored:</b> email bodies, subjects, senders or the sensitive values themselves.</li>
     </ul>
     <p>${BRAND} can only read email, and can't send, change or delete anything. Read the <a href="/privacy">privacy policy</a> for
     what's stored, for how long, and who's involved.</p>
     <p class="muted">${BRAND} isn't affiliated with or endorsed by Google, or by any AI assistant it connects to.</p>
     ${dev ? `<p class="muted">Dev mode is on: sign-in uses a local test user and a synthetic mailbox.</p>` : ""}`,
    null,
  );
}

export function privacyPage(contactEmail: string | null): string {
  const reach = contact(contactEmail);
  return layout(
    "Privacy policy",
    `<h1>Privacy policy</h1>
     <p class="muted">Last updated 6 November 2026.</p>
     <p>${BRAND} is a personal, open-source project run by Kriti Joshi (The Napkin Lab), who is responsible for your data. For any
     question about it, contact ${reach}.</p>

     <h2>What we access from Google</h2>
     <p>When you connect Gmail, we ask Google for one permission: to read your email (<code style="word-break:normal">gmail.readonly</code>). We use it only when
     your AI assistant asks for email through ${BRAND}, to fetch those emails, filter them and pass on what the filter allows. We can't
     send, change or delete email. We never download attachment contents, only their names, types and sizes.</p>

     <h2>What happens to an email</h2>
     <ol>
       <li>It's fetched from Gmail and held in memory for the length of the request.</li>
       <li>Its sender, subject, attachment names and up to about 20,000 characters of text go to an AI model on Amazon Bedrock, which
       decides whether it's sensitive. Longer emails are cut off at that point before they go any further.</li>
       <li>Depending on that decision, it goes to the AI assistant you connected, with sensitive values removed if needed, or it's held back.</li>
     </ol>
     <p>What reaches your assistant is then handled under that assistant's own terms.</p>

     <h2>What we store</h2>
     <div class="scroll"><table>
       <tr><th>Data</th><th>Kept</th></tr>
       <tr><td>Your sign-in email, Gmail address and Gmail access token (encrypted)</td><td>Until you disconnect or delete your account</td></tr>
       <tr><td>Each request: time, assistant, tool, the search your assistant ran, and counts. A search can itself say something about you.</td><td>90 days</td></tr>
       <tr><td>Each email: its Gmail ID, the decision, the reason types and your feedback</td><td>7 days</td></tr>
       <tr><td>The filter's label for emails with nothing to remove, under a scrambled version of the email's ID</td><td>7 days</td></tr>
       <tr><td>Usage counters</td><td>1 to 2 days</td></tr>
       <tr><td>Service-wide daily totals, with no personal data</td><td>400 days</td></tr>
     </table></div>
     <p><b>Never stored:</b> email bodies, subjects, senders, attachments, or the sensitive values themselves.</p>

     <h2>Who's involved</h2>
     <div class="scroll"><table>
       <tr><th>Service</th><th>What it does</th></tr>
       <tr><td>Amazon Web Services</td><td>Runs the service in Stockholm, and the AI filter on Amazon Bedrock in EU regions</td></tr>
       <tr><td>WorkOS</td><td>Handles sign-in, using your email address. It's a US company, so this may be processed outside the UK and EU.</td></tr>
       <tr><td>Langfuse (EU)</td><td>Receives a technical log of each request: time, assistant, tool, result, counts, reason types, timings and error types. It has no email content, searches, message IDs, names, email addresses or account IDs.</td></tr>
       <tr><td>Google</td><td>Provides your email through the Gmail API</td></tr>
       <tr><td>Your AI assistant</td><td>Receives the filtered email, under its own terms</td></tr>
     </table></div>

     <h2>Google user data</h2>
     <p>${BRAND}'s use and transfer to any other app of information received from Google APIs will adhere to the
     <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the
     Limited Use requirements. In particular:</p>
     <ul>
       <li>We use your Gmail data only to provide the filtering you asked for and to show you what happened.</li>
       <li>We don't sell it, or use it for advertising.</li>
       <li>We don't use it to train AI models, general or otherwise.</li>
       <li>We only share it with the services above, as needed to run ${BRAND}, or if the law requires it.</li>
       <li>People don't read your email. The person running the project can technically access the stored records above to operate the
       service, but email content isn't kept.</li>
     </ul>

     <h2>Cookies</h2>
     <p>We use one cookie to keep you signed in. We don't use advertising or analytics cookies.</p>

     <h2>Your choices and rights</h2>
     <ul>
       <li><b>Stop access:</b> disconnect Gmail on Setup, or remove access in your Google Account under Security → Third-party connections.</li>
       <li><b>Delete everything:</b> use "Delete my data" in Settings, which also revokes our Google access.</li>
       <li><b>Your legal rights:</b> depending on where you live, you can ask for a copy of your data, or ask us to correct, delete or stop
       using it. Contact ${reach}. You can also complain to your data protection authority, which in the UK is the
       <a href="https://ico.org.uk/make-a-complaint/">Information Commissioner's Office</a>.</li>
     </ul>
     <p>We rely on your request for the service as the legal basis for handling your email, and on our legitimate interest in keeping it secure and working for technical logs.</p>

     <h2>Security</h2>
     <p>Your Gmail token is encrypted with AWS KMS and data is sent over HTTPS. The filter can miss things, so don't connect an inbox
     where a single slip would be serious.</p>

     <h2>Age and changes</h2>
     <p>${BRAND} isn't for anyone under 18. If this policy changes, we'll update the date above and tell testers about significant changes.</p>`,
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
     To join, contact ${contact(contactEmail)} with the email address you sign in with.</p>
     <p class="muted">Nothing about you was stored.</p>
     <p><a href="/guide">Read the tester guide</a></p>`,
    null,
  );
}

export function noticePage(contactEmail: string | null, technicalLog = false): string {
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
       <li>Attachments are never opened or sent. The assistant only sees their names, and names that reveal a sensitive document, like "passport", are removed too.</li>
       <li>Very long emails are cut off where the filter stops checking, and the assistant is told.</li>
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
     ${technicalLog ? `<p>A technical log of each request goes to Langfuse, in the EU: the time, assistant, tool, result, counts of shared, redacted and
     withheld emails, reason types (for example "medical"), timings and error types. It has no email content, searches, message IDs,
     names, email addresses or account IDs.</p>` : ""}

     <h2>Leaving</h2>
     <p>Disconnect Gmail on Setup, or delete everything in Settings → "Delete my data", which also revokes our Google access. You can
     also remove access in your Google Account → Security → Third-party connections.</p>`,
    null,
  );
}

export function guidePage(mcpUrl: string, contactEmail: string | null): string {
  return layout(
    "Tester guide",
    `<h1>Tester onboarding guide</h1>
     <p>Thanks for testing ${BRAND}. It sits between your AI assistant and your Gmail: it holds back medical and financial emails,
     removes sensitive values from the rest, and shows you what your assistant read. Setup takes about 10 minutes.</p>
     <p>Before you start, read the <a href="/notice">beta notice</a>. This is an early experiment and the filter can make mistakes.</p>

     <h2>1. Get invited</h2>
     <p>Send ${contact(contactEmail)}:</p>
     <ul>
       <li>the email you'll sign in with;</li>
       <li>which assistant you use.</li>
     </ul>
     <p>Wait for a confirmation first. The sign-in page blocks addresses that haven't been added.</p>

     <h2>2. Sign in and connect Gmail</h2>
     <ol>
       <li><a href="/login">Sign in</a> with your invited email.</li>
       <li>On <b>Setup</b>, tick that you've read the beta notice and click <b>Connect Gmail</b>.</li>
       <li>Google will say it "hasn't verified this app". That's expected for a small beta: choose <b>Advanced → Go to … (unsafe)</b>, then allow read-only access.</li>
     </ol>

     <h2>3. Add the connector to your assistant</h2>
     <div class="notice"><b>First, turn off your assistant's built-in Gmail or Google Workspace access.</b> If it stays on, your assistant can read your email, including attachments, without going through the filter, and anything you test won't reflect this product.</div>
     <p>Claude is the only assistant we've tested, and Muse support is the least certain. For the others, you're finding out with us: menus change often, so tell us if a step doesn't match.</p>
     ${assistantSteps(mcpUrl)}

     <h2>4. Check it works</h2>
     <ol>
       <li>Ask your assistant: "Using ${BRAND}, how many emails did I get yesterday?"</li>
       <li>Open <a href="/activity">Activity</a>. Your request should appear within a few seconds, with the assistant's name.</li>
       <li>If it doesn't appear, your assistant probably used another route. Check step 3.</li>
     </ol>

     <h2>5. Try these</h2>
     <div class="scroll"><table>
       <thead><tr><th>Ask</th><th>What should happen</th></tr></thead>
       <tbody>
         <tr><td>"When is my next flight or booking?"</td><td>Trip details come through. Dates of birth and passport numbers show as <code>[removed: …]</code>.</td></tr>
         <tr><td>"Where are my recent orders?"</td><td>Order details come through. Your home address shows as <code>[removed: home address]</code>.</td></tr>
         <tr><td>"Show my latest verification codes."</td><td>The code is removed, or the email is withheld if it's from your bank.</td></tr>
         <tr><td>"Show my latest bank statement."</td><td>Withheld. Your assistant is told how many emails were held back and why.</td></tr>
         <tr><td>"Any test results or GP letters?"</td><td>Withheld.</td></tr>
         <tr><td>Your usual questions and scheduled tasks</td><td>This is the most useful test of all.</td></tr>
       </tbody>
     </table></div>

     <h2>6. Tell us what happens</h2>
     <p>On <a href="/activity">Activity</a>, open a request's <b>Emails</b> and use <b>Open in Gmail</b> to compare.</p>
     <ul>
       <li><b>Something sensitive got through:</b> press <b>Something leaked</b> and pick the type. Only the type is recorded.</li>
       <li><b>Something was withheld that shouldn't have been:</b> press <b>Release next time</b>.</li>
       <li><b>Anything else</b> (confusing steps, slow answers, ideas): email ${contact(contactEmail)}. Describe the type of email, and <b>please don't forward or paste its contents</b>.</li>
     </ul>

     <h2>If something goes wrong</h2>
     <div class="scroll"><table>
       <thead><tr><th>What you see</th><th>What to do</th></tr></thead>
       <tbody>
         <tr><td>"This beta is invite-only"</td><td>Sign in with the email you sent us, or ask us to add it.</td></tr>
         <tr><td>Google says "Access blocked"</td><td>Your Gmail address isn't on Google's test list yet. Tell us the address.</td></tr>
         <tr><td>"Couldn't reach Gmail" or a red notice in Activity</td><td>Google access has lapsed, which can happen during this beta. Disconnect and reconnect Gmail on <a href="/setup">Setup</a>.</td></tr>
         <tr><td>"The privacy filter is busy" or "couldn't run"</td><td>Nothing was shared. Try again in a minute.</td></tr>
         <tr><td>"Usage limit reached"</td><td>The limits are 100 emails per 10 minutes and 500 per day. Try again later.</td></tr>
         <tr><td>Your assistant can't find the connector</td><td>Check it's turned on for that chat, and that your plan allows custom connectors.</td></tr>
         <tr><td>An error with a reference</td><td>Send us the reference. It lets us find the problem without seeing your email.</td></tr>
       </tbody>
     </table></div>

     <h2>Good to know</h2>
     <ul>
       <li>Attachment contents are never opened or shared, only their names.</li>
       <li>Other connected tools, and your assistant's own web search, don't go through this filter.</li>
     </ul>

     <h2>Leaving</h2>
     <p>In <b>Settings → Delete my data</b> you can delete everything, which also revokes our Google access. Remove the connector from your assistant too.</p>`,
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

const STEP_URL = `style="overflow-wrap:anywhere"`;

/** How to add the connector to each assistant. These menus change often, so a step that doesn't match should be reported. */
function assistantSteps(mcpUrl: string): string {
  const url = `<code ${STEP_URL}>${esc(mcpUrl)}</code>`;
  return `<h3>Claude <span class="chip c-shared">Tested</span></h3>
     <ol>
       <li>Open Claude: <b>Settings → Connectors → Add custom connector</b>.</li>
       <li>Name it "${BRAND}" and paste ${url}, then click Add.</li>
       <li>Sign in with your invited email when Claude asks, and approve.</li>
       <li><b>Turn off Claude's built-in Gmail connector</b>, and remove Claude in Google Account → Security → Third-party connections.</li>
     </ol>
     <h3>ChatGPT <span class="chip">Not tested yet</span></h3>
     <ol>
       <li>On chatgpt.com, open <b>Settings → Apps &amp; Connectors → Advanced</b> and turn on <b>Developer mode</b>. If it isn't there, look under Settings → Security. Availability depends on your plan, and a work account's admin may need to allow it.</li>
       <li>Back in Apps &amp; Connectors, click <b>Create</b>, name it "${BRAND}", paste ${url}, choose <b>OAuth</b> and save.</li>
       <li>Sign in with your invited email when asked, and approve.</li>
       <li>In a new chat, pick the connector from the tools menu.</li>
       <li><b>Disconnect ChatGPT's built-in Gmail</b>, and remove OpenAI in Google Account → Security → Third-party connections.</li>
     </ol>
     <h3>Gemini app <span class="chip">Not tested yet</span></h3>
     <ol>
       <li>On <b>gemini.google.com</b> (web only, in English), open <b>Settings → Connected Apps</b>. Custom apps depend on your account and location, and may need Keep Activity turned on.</li>
       <li>Under <b>Custom apps</b>, add a new app, paste ${url} and click Next.</li>
       <li>Approve the connection and sign in with your invited email. The app then also shows in the Gemini mobile app.</li>
       <li><b>Turn off Gemini's built-in Gmail access</b> in Connected Apps, because that route doesn't go through this filter.</li>
     </ol>
     <h3>Perplexity <span class="chip">Not tested yet</span></h3>
     <ol>
       <li>Open <b>Plugins</b> in the sidebar and select <b>Add custom</b>. This may need a paid plan.</li>
       <li>Name it "${BRAND}", paste ${url}, and sign in with your invited email when asked.</li>
       <li><b>Turn off Perplexity's built-in Gmail connector</b>, if you've added it.</li>
     </ol>
     <h3>Muse <span class="chip">Not tested yet</span></h3>
     <p>As far as we can tell, the Muse app doesn't offer custom connectors yet, so this may not work for you. Muse Code is reported to support them. Check its documentation, as these steps are unconfirmed.</p>
     <ol>
       <li>In Muse Code's settings file (<code>~/.config/muse/settings.json</code>), add a "${BRAND}" entry with ${url} under <code>mcp_servers</code>.</li>
       <li>Restart Muse Code, and sign in with your invited email if asked.</li>
     </ol>`;
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
         <div class="notice"><b>Google will show a warning, and that's expected.</b> ${BRAND} hasn't finished Google's verification yet, so you'll see "Google hasn't verified this app".
           <ol>
             <li>Check the app is ${BRAND}, then click <b>Advanced</b>.</li>
             <li>Click <b>Go to … (unsafe)</b>. Google uses that wording for every app it hasn't verified.</li>
             <li>Allow read-only access to your email.</li>
           </ol>
           Only continue if you're comfortable with this. <a href="/privacy">Read what we do with your email</a>.</div>
         <form method="get" action="/gmail/connect">
           <p><label class="row"><input type="checkbox" name="ack" value="1" required> I've read the <a href="/notice" target="_blank" rel="noopener">beta notice</a>: what's read, what's stored, and that the filter can make mistakes.</label></p>
           <p><button class="btn primary">Connect Gmail</button></p>
         </form>
</div>`;
  return layout(
    "Setup",
    `<h1>Setup</h1>
     ${gmailCard}
     <div class="card"><b>Step 2. Your connector URL</b>
       <p><code id="u">${esc(mcpUrl)}</code></p>
       <p class="muted">Paste this into your assistant as a custom connector.</p></div>
     ${assistantSteps(mcpUrl)}
     <div class="notice">If an assistant's built-in Gmail stays connected, it can read your email without going through this filter.</div>`,
    nav,
  );
}

const ASSISTANT: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", muse: "Muse", unknown: "Unknown assistant" };

const FAILURE: Record<string, string> = {
  gmail_unavailable: "Gmail access lapsed: reconnect on Setup",
  gmail_auth_expired: "Gmail access lapsed: reconnect on Setup",
  no_gmail: "Gmail wasn't connected",
  limit: "Usage limit reached",
  busy: "Filter busy, nothing was shared",
  gmail_not_found: "Email not found",
  gmail_rate_limited: "Gmail was limiting requests",
  gmail_api: "Gmail returned an error",
  model_throttled: "Filter couldn't run, nothing was shared",
  model_timeout: "Filter couldn't run, nothing was shared",
  model_access: "Filter couldn't run, nothing was shared",
  model_unparseable: "Filter couldn't run, nothing was shared",
  model_error: "Filter couldn't run, nothing was shared",
};
const failureLabel = (f: string) => FAILURE[f] ?? "The request failed";
const needsReconnect = (f: string | null | undefined) => f === "gmail_unavailable" || f === "gmail_auth_expired";

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
  if (r.failure) c.push(`<span class="chip c-withheld">${esc(failureLabel(r.failure))}</span>`);
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
     ${gmailConnected && needsReconnect(runs[0]?.failure) ? `<div class="notice"><b>Your assistant can't reach Gmail.</b> Google access has lapsed, which can happen during this beta. <a href="/setup">Reconnect on Setup</a>.</div>` : ""}
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
  const failed = run.failure
    ? `<div class="notice"><b>${esc(failureLabel(run.failure))}.</b> No emails were shared in this request.${run.error_ref ? ` If you report it, quote reference <code>${esc(run.error_ref)}</code>.` : ""}</div>`
    : "";
  const body = run.failure
    ? failed
    : items.length
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
