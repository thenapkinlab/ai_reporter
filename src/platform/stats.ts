// AWS Lambda entry point for the nightly totals job (EventBridge schedule).

import { DynamoTable } from "../aws/dynamo-table";
import { runDailyStats } from "../stats";

export async function handler(): Promise<void> {
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error("Missing configuration: TABLE_NAME");
  const stats = await runDailyStats(new DynamoTable(table));
  console.log(`daily totals: ${stats.users_total} users, ${stats.active_1d} active, ${stats.emails_1d} emails`);
}
