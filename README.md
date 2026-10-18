# Private Gmail gateway

A remote MCP server that sits between AI assistants (Claude, ChatGPT) and a user's Gmail.
It withholds medical and financial emails, removes sensitive values from every other email
(card and bank numbers, ID numbers, passwords and keys, one-time codes, home addresses, dates of
birth), and shows each user what their assistant read on a per-user dashboard.

Runs on AWS: Lambda (Function URL), DynamoDB, KMS, Bedrock, SSM Parameter Store, deployed with
the AWS CDK. Sign-in is WorkOS AuthKit.

> **Status:** a personal project in an invite-only beta. It comes with no warranty: the filter catches most
> sensitive content but can miss some (see the benchmarks below). Don't rely on it for an inbox where a single
> slip would be serious. Security issues: see [SECURITY.md](SECURITY.md).

## How it works

```
Claude / ChatGPT ──MCP + AuthKit token──► Lambda Function URL /mcp ──► Gmail API (read-only)
                                                │
          detectors + batched classifier (Bedrock) → share, remove values, or withhold
                                                │
                     shared emails + filter note ◄── audit log in DynamoDB (no content)
```

- **Tools:** `search_email(query, max_results)` and `read_email(message_id)`, both read-only with explicit annotations.
- **Scope:** only the emails the assistant asks for are fetched and checked. The assistant's Gmail search query is
  passed unchanged to the Gmail API (`q`), so Gmail does the filtering; at most 25 results per page, with
  `page_token` for the next page. The inbox is never scanned in the background.

## Invite-only beta

Only emails on the tester allow list can sign in to the dashboard or use the connector; anyone else sees an
"invite-only" page and nothing about them is stored. Removing someone takes effect on their next request.

```bash
npm run testers -- add tester@example.com     # also add their Gmail address as a Google test user
npm run testers -- list
npm run testers -- remove tester@example.com
```

Send testers `/guide` (setup steps, what to try, how to report problems). `/notice` is the beta notice: what's
read, what's stored and for how long, where it runs, and how to leave. Testers must tick that they've read it
before connecting Gmail; the time they accepted is kept on their profile. `inviteOnly` is in
`cdk.json`; `contactEmail` is in your `deploy.local.json`.

## Usage limits

| Limit | Default | When it's reached |
|---|---|---|
| Emails checked per user, per 10 minutes | 100 | Only the emails that fit are checked; the result carries a `usage_note`, no `next_page_token`. With nothing left, the tool returns an error saying when to try again. |
| Emails checked per user, per UTC day | 500 | Same; the dashboard shows "today x of 500". |
| Classifier requests per minute, all users | 18 (account quota for Nova 2 Lite is 20) | A request waits up to 20 s for the next minute, then the tool says "busy, try again in a minute" and the emails are not counted. Nothing is shared without the model. |
| Lambda instances at once | 10 | Further requests are throttled by Lambda. |

Counters are numbers in DynamoDB (`USAGE#…` per user, `MODELRPM#…` shared) that expire on their own. Change the
defaults with the `userEmailsPer10Min`, `userEmailsPerDay`, `modelRequestsPerMinute` and `maxConcurrency` context
values in `cdk.json`.

### Alarms (for you, the operator)

CloudWatch alarms email the address in `alarmEmail` (or `budgetEmail`) from your `deploy.local.json` through an SNS topic; confirm the
subscription from the first email AWS sends. Users never get these: they see the tool's own "busy" or "limit
reached" message, and their usage on the dashboard.

| Alarm | Fires when |
|---|---|
| `agent-gateway-ModelBusy` | any request was refused as busy in 5 minutes (shared Bedrock budget full) |
| `agent-gateway-ModelUnavailable` | any email was withheld because the classifier didn't answer, in 5 minutes |
| `agent-gateway-UserLimits` | users hit their email limits 10+ times in an hour (loops, or limits too low) |
| `agent-gateway-LambdaErrors` | 3+ Lambda errors in 5 minutes |
| `agent-gateway-LambdaThrottles` | any request refused by the concurrency cap in 5 minutes |

| `agent-gateway-SearchLatency` | `search_email` p95 above 8 s for 15 minutes |
| `agent-gateway-DailyStatsErrors` | the nightly totals job failed |

## Metrics and the CloudWatch dashboard

The `agent-gateway` dashboard in CloudWatch has three sections. Everything is counts and timings, with
dimensions from small fixed lists; never a user ID, query, message ID, sender or anything from an email (a test
checks this).

| Section | Metrics |
|---|---|
| Reliability and performance | `ToolCalls` by tool and outcome (ok, limit, busy, error, no_gmail, gmail_unavailable); `TotalMs`, `GmailMs`, `FilterMs` (p50/p95) by tool; `ModelBusy`, `ModelUnavailable`, `UserLimitReached`; Lambda errors, throttles, duration |
| Filter quality | `Emails` by decision (shared / redacted / withheld) and prompt version; `Reasons` by type; `Feedback` by kind (release / keep / leak) and leaked type |
| Usage | `Funnel` steps (signed in, Gmail connect started / cancelled / no access / connected, disconnected, account deleted); nightly `Daily` totals: users, Gmail connected, used from an assistant, active 1/7/30 days, week-2 retention, searches, reads, emails by decision, runs by assistant, background runs, feedback |

The nightly job (`src/stats.ts`, 02:00 UTC) works the totals out from records the gateway already keeps and saves
only the totals (`STATS / DAY#<date>`, 400 days).

**Leak reports:** on a request's page, shared and redacted emails have a "Something leaked" button with a type
(home address, date of birth, card, bank, ID, password or key, code, other). Only the type is kept, for 7 days.
Each report becomes a synthetic case in `eval/redaction-set.json`, which the benchmarks then cover.
- **Decision:** each email is shared unchanged, shared with values removed, or withheld whole.
  - **Withheld whole:** medical or financial emails (removing values from a lab result still leaves a lab result).
  - **Values removed:** in every other email, card numbers, bank accounts, government IDs, passwords and keys,
    one-time codes, home addresses (including shipping and billing addresses) and dates of birth are replaced with
    `[removed: home address]` and similar markers. Order numbers, flight details, prices, masked cards ("Visa
    ending 4242") and shop, venue, hotel or airport addresses stay, so shopping and travel emails remain useful.
  - **How values are found:** pattern detectors and the model together. Detectors use checksums where a format
    has one (cards, IBANs, Aadhaar, personnummer) and otherwise only fire right after a label ("Passwort:",
    "date of birth", "routing number") in English, German, French, Spanish, Italian, Dutch and Swedish. The model
    copies the exact text of each value it finds; the gateway locates that text in the email itself and replaces
    it, so the model never rewrites the email.
  - **Fail closed:** if the model reports a value but the gateway can't find it in the email, or the model is
    unavailable, the whole email is withheld (removing values depends on the model).

## What the assistant receives, and what it never receives

| The assistant receives | The assistant never receives |
|---|---|
| Shared emails: sender, subject, date, snippet, body | **Withheld emails**: no subject, sender, snippet or body, only a count |
| In those emails, `[removed: …]` markers where sensitive values were, and a `values_removed` list of the types | The sensitive **values** themselves (the snippet is rebuilt from the redacted body, so it can't leak half a value) |
| For shared emails: each attachment's **file name, type and size** | **Attachment contents**, for any email, shared or withheld |
| A `filter_note` with counts and the reason **types** (e.g. "medical", "home address") | Which withheld email had which reason |
| For `read_email` on a withheld email: a notice that it was withheld | Anything from emails it didn't ask for |

Attachments are never opened or downloaded: the gateway reads only their names, types and sizes from Gmail.
Names are sent to the assistant, so they're classified and redacted like the body. A sensitive document attached
to a harmless email doesn't make the email sensitive, because its contents never leave Gmail.

## What we store

| Record | Contents | Kept |
|---|---|---|
| Request | Time, assistant, tool, the assistant's query, counts, counts of withhold reasons | 90 days |
| Per email | Gmail message ID (for "Open in Gmail"), decision, reason types; your feedback (release, keep, or the type of a leaked value) | 7 days |
| Usage counters | Emails checked per user per 10 minutes and per day (numbers) | 1-2 days |
| Daily totals | Product totals for the whole service (no per-user data) | 400 days |
| Classifier cache | Keyed by a secret-keyed hash (HMAC) of the message ID, not the ID itself; category, confidence. Only labels with no sensitive items are cached; emails with values to remove go back to the model each time, because the values themselves are never stored | 7 days |
| Gmail connection | Gmail address, refresh token encrypted with KMS (user ID as encryption context) | Until disconnected |

Never stored or logged: email bodies, subjects, senders, snippets, attachments or their text, sensitive values
(the model's copies are held in memory for the request only), or the model's written reasons.

## Code layout

| Path | What |
|---|---|
| `src/app.ts` | The whole app as `Request → Response`: MCP endpoint, sign-in, dashboard. No cloud code. |
| `src/mcp.ts` | Stateless MCP over HTTP (JSON-RPC), tools and annotations |
| `src/filter/` | Detectors, signals, classifier rules, policy engine |
| `src/store/` | Single-table data model (`single-table.ts`) on a small `Table` interface; `MemoryTable` for dev/tests |
| `src/aws/` | DynamoDB table, KMS cipher, Bedrock classifier, SSM secrets |
| `src/platform/lambda.ts` | Lambda handler: Function URL event ↔ Request/Response |
| `src/platform/local.ts` | Local dev server (in-memory, synthetic mailbox) |
| `infra/` | CDK app and stack |

## Run it locally (no AWS account needed)

```bash
npm install
npm run dev
```

Open http://localhost:8787 and choose "Continue as dev user". Dev mode uses an in-memory database (reset on
restart), a synthetic mailbox and the rules-only classifier. Call the MCP endpoint with the dev token:

```bash
curl -s -X POST http://localhost:8787/mcp -H 'authorization: Bearer dev' -H 'x-dev-assistant: claude' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_email","arguments":{"query":"statement lab order"}}}'
```

`npm test` runs the tests. `npm run typecheck` type-checks. `npm run synth` builds the CloudFormation template
without deploying.

## Evaluate the classifier

`eval/dataset.json` holds ~90 synthetic, labelled emails: clear and hard cases, look-alikes that must not be
withheld, other languages, attachments, prompt-injection attempts and redaction-only cases.

```bash
aws login
npm run eval                                  # rules-only baseline + Nova 2 Lite + Haiku 4.5
npm run eval -- --models eu.amazon.nova-micro-v1:0,<another-model-id> --tags adversarial
```

The report (`eval/results/<timestamp>.md`) shows, per model (positive = should be withheld):

| Metric | Meaning |
|---|---|
| Recall | TP / (TP + FN): sensitive emails that were withheld |
| Precision | TP / (TP + FP): withheld emails that should have been |
| FPR | FP / (FP + TN): everyday emails wrongly withheld |
| Category accuracy | medical / financial / other label correct |
| Unanswered rate | emails the model gave no usable answer for (withheld if they look sensitive) |
| Latency p50 / p95 | per Bedrock request (one batch of up to 10 emails) |

plus a threshold sweep (recall and FPR), accuracy by case type, the confusion matrix, and every false negative
and false positive. The prompt version is stamped on each report.

## Evaluate the redactor

`eval/redaction-set.json` holds 57 hand-written shopping, travel, account and membership emails in 7 languages.
Each case lists the values that must be removed, the facts the assistant still needs (`keep`), strings that must
not be removed (`notSensitive`: shop, venue and airport addresses, order numbers, masked cards) and, for most, a
question with its expected answer.

```bash
npm run eval:redactor                                    # detectors-only baseline + Haiku 4.5
npm run eval:redactor -- --qa --gretel 200               # + end-to-end answers + 200 public documents
npm run eval:redactor -- --models <id>,<id>
```

| Metric | Meaning |
|---|---|
| Value recall | sensitive values that did not reach the assistant; a partial leak (street name left) is a miss |
| Recall when sent | the same, counting only emails that were shared or redacted (withholding can't inflate it) |
| Usable | emails that should reach the assistant (redacted or unchanged) and weren't withheld |
| Over-redaction | must-stay strings that were removed |
| Facts kept | facts the assistant needs that are still present |
| Integrity | output equals the original apart from `[removed: …]` markers |
| Answer accuracy | a model answers each case's question from the original email and from what the assistant receives |

With `--gretel`, Gretel's labelled values (IDs, card and bank numbers, credentials, dates of birth, street
addresses) give value recall per label on public documents. Gretel labels business addresses too, so address
recall there is an upper bound.

### Dev, validation and test splits

`npm run eval:import -- --holdout` builds three disjoint samples of the public data (duplicate texts removed):

| Split | Command | Use it for |
|---|---|---|
| dev | `npm run eval -- --external --docs 300` | Reading individual mistakes and changing prompts or detectors. Includes the hand-written cases. |
| validation | `npm run eval -- --holdout --docs 252` | Comparing versions on totals only. Don't read its individual mistakes, or it turns into a second dev set. |
| test | `npm run eval -- --test --docs 252` | Locked: run once to confirm a version you've already chosen on validation. |

Reports give 95% confidence intervals; treat differences inside them as noise and re-run before believing them.
Public labels that a person reviewed and found wrong (URLs, protocol fields, amounts, placeholders) are listed in
`eval/label-review.json` and skipped; review only on dev. The runner retries unanswered emails once, like the
gateway.

### Public datasets

```bash
npm run eval:import       # downloads (cached) and builds eval/external/ (git-ignored)
npm run eval:redaction    # detector recall per sensitive item, Gretel label and language; no model, no AWS
npm run eval -- --external   # classifier benchmark on the public cases (needs aws login)
```

`eval:import` builds ~500 classifier cases from MTSamples (medical), Gretel synthetic finance documents in
7 languages (financial, health insurance claims), and two public email sets (everyday mail, newsletters, spam),
plus 3,000 Gretel texts with labelled sensitive values for the redaction benchmark. Review
`eval/external/spotcheck.md` before trusting the scores. Licences: Gretel and the email sets are Apache-2.0/MIT;
MTSamples' original terms are unclear, so it's for internal benchmarking only and is never committed.

## Deploy to AWS

### 1. AWS account and CLI

1. Create an AWS account. **Set up a budget alert first:** `npm run budget -- you@example.com 10` creates a
   $10/month cost budget that emails you at 80% and 100% of actual spend (it only warns; it never stops anything).
   It's a script rather than part of the stack because CloudFormation doesn't support budgets in every region.
2. Install the AWS CLI and sign in: `aws configure sso` (recommended) or `aws configure` with an IAM user's keys.
   The stack deploys to `region` in `cdk.json` (default `eu-north-1`, Stockholm). New free-plan accounts can
   only use the region they were created in.
3. One-time per account and region: `npx cdk bootstrap aws://<account-id>/eu-north-1`.
4. Bedrock: the default is Amazon Nova 2 Lite (classifier and value finder), called through EU cross-region inference profiles from `bedrockRegion` (default `eu-north-1`), so email stays
   in the EU. Claude Haiku 4.5 (`eu.anthropic.claude-haiku-4-5-20251001-v1:0`) scores higher on the benchmarks;
   switch with `classifierModel` in `cdk.json`. If Bedrock isn't available in your region yet, set `bedrockRegion`
   to `us-east-1` and use the `us.` model IDs.

### 2. WorkOS AuthKit (free up to 1M monthly users)

1. Create a WorkOS account and project, and turn on AuthKit.
2. Under Connect → Configuration, turn on **Dynamic Client Registration** (Claude) and
   **Client ID Metadata Documents** (ChatGPT; off by default). See https://workos.com/docs/authkit/mcp.
3. Turn on "Sign in with Google" and email codes; you don't need passwords.
4. Copy `deploy.example.json` to `deploy.local.json` (git-ignored) and fill in your AuthKit domain and client ID
   (`authkitDomain`, `workosClientId`) and the email addresses for alarms and the testers' contact.
5. After the first deploy, add the redirect URI `<GatewayUrl>auth/callback`.

### 3. Google Cloud (free; Testing mode allows up to 100 test users)

1. Create a project, then enable the **Gmail API**.
2. OAuth consent screen: External, **Testing**, add each tester's Google account as a test user,
   add the scope `.../auth/gmail.readonly`.
3. Credentials → Create OAuth client ID → **Web application**. After the first deploy, add the redirect URI
   `<GatewayUrl>gmail/callback`.

### 4. Secrets in SSM Parameter Store

```bash
aws ssm put-parameter --region eu-north-1 --type SecureString --name /agent-gateway/WORKOS_API_KEY --value 'sk_...'
aws ssm put-parameter --region eu-north-1 --type SecureString --name /agent-gateway/GOOGLE_CLIENT_ID --value '....apps.googleusercontent.com'
aws ssm put-parameter --region eu-north-1 --type SecureString --name /agent-gateway/GOOGLE_CLIENT_SECRET --value '...'
aws ssm put-parameter --region eu-north-1 --type SecureString --name /agent-gateway/SESSION_SECRET --value "$(openssl rand -base64 32)"
```

### 5. Deploy

```bash
npm run deploy                                   # alarms go to alarmEmail in deploy.local.json
```

The output shows `GatewayUrl` (the dashboard) and `McpUrl` (paste into assistants). Add the two redirect URIs above,
then sign in at `GatewayUrl`.

Optional: once you've confirmed AuthKit puts your MCP URL in the token's `aud` claim, deploy with
`-c mcpAudience=<McpUrl>` so tokens issued for other resources are refused. ChatGPT expects the audience to match.

To remove everything (including data): `npm run destroy`.

### Rough cost for a handful of testers

| Service | Expected |
|---|---|
| Lambda, DynamoDB | Within free-tier allowances at this scale |
| KMS key | About $1/month |
| Bedrock (Nova Micro/Lite) | Cents to a few dollars a month |
| CloudWatch logs (1-month retention) | Cents |

AWS's free-tier terms changed in 2025 (new accounts get credits). Check what your account has.

## Connect an assistant

The dashboard's Setup page shows the URL and these steps.

- **Claude:** Settings → Connectors → Add custom connector → paste the URL → sign in. Free plans allow one custom connector.
- **ChatGPT (Plus or higher, web):** Settings → Apps → Advanced → Developer Mode → Create → paste the URL, choose OAuth → sign in.
- **Both:** turn off the assistant's built-in Gmail, and remove it under Google Account → Security → Third-party
  connections. Otherwise it can read email without going through the filter.

## Known limits (MVP)

- Assistants get attachment names, never attachment contents (no `read_attachment` tool yet).
- "Background, likely" is a heuristic (same assistant, same query, whole-hour rhythm). `userAgent` and `headerNames`
  are stored on each run so chat and scheduled-task requests can be compared and the rule improved.
- Assistant labels come from the token's client ID and the User-Agent. OpenAI's mTLS client certificate isn't
  verified yet (needs a custom domain in front of Lambda).
- MCP: stateless Streamable HTTP with JSON responses, protocol versions 2025-03-26 to 2025-11-25.
- Email is processed in Lambda memory. Before a public launch: Google verification, the CASA assessment, and
  moving email handling into a Nitro Enclave.
