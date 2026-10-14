# Private Gmail gateway

A remote MCP server that sits between AI assistants (Claude, ChatGPT) and a user's Gmail.
It withholds medical and financial emails, redacts sensitive values (card numbers, ID numbers,
API keys, passwords, one-time codes), and shows each user what their assistant read on a
per-user dashboard.

Runs on AWS: Lambda (Function URL), DynamoDB, KMS, Bedrock, SSM Parameter Store, deployed with
the AWS CDK. Sign-in is WorkOS AuthKit.

Design doc: https://claude.ai/artifact/ANNBxu1zW94YqFW6ThmRMX

## How it works

```
Claude / ChatGPT ──MCP + AuthKit token──► Lambda Function URL /mcp ──► Gmail API (read-only)
                                                │
                    detectors → signals → classifier (Bedrock) → policy
                                                │
                    filtered result + filter note ◄── audit log in DynamoDB (labels only)
```

- **Tools:** `search_email(query, max_results)` and `read_email(message_id)`, both read-only with explicit annotations.
- **Filter:** values are redacted everywhere (subject, snippet, body, attachments). Emails labelled medical or
  financial at ≥ `withholdThreshold` are withheld. PDFs and images are transcribed by a Bedrock model for scanning.
- **Stored:** message IDs, labels, masked hints (`••••1111`), the assistant's query. **Not stored:** email bodies,
  subjects, snippets or attachments. Audit records expire after 90 days (DynamoDB TTL).
- **Gmail tokens:** encrypted with a KMS key, with the user ID as encryption context.

## Code layout

| Path | What |
|---|---|
| `src/app.ts` | The whole app as `Request → Response`: MCP endpoint, sign-in, dashboard. No cloud code. |
| `src/mcp.ts` | Stateless MCP over HTTP (JSON-RPC), tools and annotations |
| `src/filter/` | Detectors, signals, classifier rules, policy engine |
| `src/store/` | Single-table data model (`single-table.ts`) on a small `Table` interface; `MemoryTable` for dev/tests |
| `src/aws/` | DynamoDB table, KMS cipher, Bedrock classifier/extractor, SSM secrets |
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
npm run eval                                  # rules-only baseline + Nova Micro + Nova Lite
npm run eval -- --models eu.amazon.nova-micro-v1:0,<another-model-id> --tags adversarial
```

The report (`eval/results/<timestamp>.md`) shows, per model: recall (sensitive emails withheld), precision,
accuracy by case type, a threshold sweep, the confusion matrix, every miss and false alarm, latency and tokens.
Each model is scored twice: as the pipeline works today (rules can declare an email "other" without the model)
and with the model consulted on every email.

### Public datasets

```bash
npm run eval:import       # downloads (cached) and builds eval/external/ (git-ignored)
npm run eval:redaction    # detector recall per value type and language, no model, no AWS
npm run eval -- --external   # classifier benchmark on the public cases (needs aws login)
```

`eval:import` builds ~500 classifier cases from MTSamples (medical), Gretel synthetic finance documents in
7 languages (financial, health insurance claims), and two public email sets (everyday mail, newsletters, spam),
plus 3,000 Gretel texts with labelled sensitive values for the redaction benchmark. Review
`eval/external/spotcheck.md` before trusting the scores. Licences: Gretel and the email sets are Apache-2.0/MIT;
MTSamples' original terms are unclear, so it's for internal benchmarking only and is never committed.

## Deploy to AWS

### 1. AWS account and CLI

1. Create an AWS account. **Set up a budget alert first** (Billing → Budgets), or pass `-c budgetEmail=you@example.com`
   on deploy and the stack creates a $10/month alert.
2. Install the AWS CLI and sign in: `aws configure sso` (recommended) or `aws configure` with an IAM user's keys.
   The stack deploys to `region` in `cdk.json` (default `eu-north-1`, Stockholm). New free-plan accounts can
   only use the region they were created in.
3. One-time per account and region: `npx cdk bootstrap aws://<account-id>/eu-north-1`.
4. Bedrock: the defaults are Amazon Nova Micro (classifier) and Nova Lite (PDF/image text), called through
   EU cross-region inference profiles from `bedrockRegion` (default `eu-north-1`), so email stays in the EU.
   If Bedrock isn't available there yet, set `bedrockRegion` to `us-east-1` and the models to
   `us.amazon.nova-micro-v1:0` / `us.amazon.nova-lite-v1:0`.

### 2. WorkOS AuthKit (free up to 1M monthly users)

1. Create a WorkOS account and project, and turn on AuthKit.
2. Under Connect → Configuration, turn on **Dynamic Client Registration** (Claude) and
   **Client ID Metadata Documents** (ChatGPT; off by default). See https://workos.com/docs/authkit/mcp.
3. Turn on "Sign in with Google" and email codes; you don't need passwords.
4. Put your AuthKit domain and client ID in `cdk.json` (`authkitDomain`, `workosClientId`).
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
npm run deploy                                   # or: npx cdk deploy -c budgetEmail=you@example.com
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

- Assistants get attachment names, never attachment contents.
- "Background, likely" is a heuristic (same assistant, same query, whole-hour rhythm). `userAgent` and `headerNames`
  are stored on each run so chat and scheduled-task requests can be compared and the rule improved.
- Assistant labels come from the token's client ID and the User-Agent. OpenAI's mTLS client certificate isn't
  verified yet (needs a custom domain in front of Lambda).
- MCP: stateless Streamable HTTP with JSON responses, protocol versions 2025-03-26 to 2025-11-25.
- Email is processed in Lambda memory. Before a public launch: Google verification, the CASA assessment, and
  moving email handling into a Nitro Enclave.
