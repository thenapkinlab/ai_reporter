// Manages the tester allow list for the invite-only beta, directly in the deployed table.
//
//   npm run testers -- list
//   npm run testers -- add someone@example.com [another@example.com ...]
//   npm run testers -- remove someone@example.com
//
// Testers also need to be added as Google "test users" for the Gmail address they'll connect
// (Google Cloud console → OAuth consent screen → Audience → Test users).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoTable } from "../src/aws/dynamo-table";
import { TableAccounts } from "../src/store/single-table";

const region = (JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")) as { context: { region: string } }).context.region;

function tableName(): string {
  if (process.env.TABLE_NAME) return process.env.TABLE_NAME;
  const out = execFileSync("aws", ["cloudformation", "describe-stacks", "--region", region, "--stack-name", "AgentGateway", "--query", "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue", "--output", "text"], { encoding: "utf8" });
  return out.trim();
}

const [cmd, ...emails] = process.argv.slice(2);
// The cache secret isn't needed for the allow list.
const accounts = new TableAccounts(new DynamoTable(tableName(), new DynamoDBClient({ region })), "");
const valid = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

if (cmd === "list") {
  const all = await accounts.allowed();
  console.log(all.length ? all.join("\n") : "(no testers yet)");
} else if ((cmd === "add" || cmd === "remove") && emails.length) {
  for (const e of emails) {
    if (!valid(e)) throw new Error(`Not an email address: ${e}`);
    if (cmd === "add") await accounts.allow(e);
    else await accounts.disallow(e);
    console.log(`${cmd === "add" ? "added" : "removed"} ${e.toLowerCase()}`);
  }
  if (cmd === "add") console.log("Remember: add their Gmail address as a Google test user too.");
} else {
  console.log("Usage: npm run testers -- list | add <email>... | remove <email>...");
  process.exit(1);
}
