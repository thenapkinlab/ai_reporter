// CDK entry point. Settings come from cdk.json "context" or `-c key=value` on the command line.

import { App } from "aws-cdk-lib";
import { GatewayStack } from "../lib/gateway-stack";

const app = new App();
const ctx = (key: string, fallback?: string): string => {
  const v = app.node.tryGetContext(key) as string | undefined;
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing context "${key}". Set it in cdk.json or pass -c ${key}=...`);
  }
  return v;
};

new GatewayStack(app, "AgentGateway", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: ctx("region", process.env.CDK_DEFAULT_REGION ?? "eu-north-1") },
  authkitDomain: ctx("authkitDomain"),
  workosClientId: ctx("workosClientId"),
  ssmPrefix: ctx("ssmPrefix", "/agent-gateway"),
  bedrockRegion: ctx("bedrockRegion", "eu-north-1"),
  classifierModel: ctx("classifierModel", "eu.amazon.nova-2-lite-v1:0"),
  withholdThreshold: ctx("withholdThreshold", "0.6"),
  userEmailsPer10Min: ctx("userEmailsPer10Min", "100"),
  userEmailsPerDay: ctx("userEmailsPerDay", "500"),
  modelRequestsPerMinute: ctx("modelRequestsPerMinute", "18"),
  maxConcurrency: Number(ctx("maxConcurrency", "10")),
  mcpAudience: (app.node.tryGetContext("mcpAudience") as string | undefined) || undefined,
  budgetEmail: (app.node.tryGetContext("budgetEmail") as string | undefined) || undefined,
  alarmEmail: (app.node.tryGetContext("alarmEmail") as string | undefined) || undefined,
  inviteOnly: ctx("inviteOnly", "true") !== "false",
  contactEmail: (app.node.tryGetContext("contactEmail") as string | undefined) || undefined,
});
