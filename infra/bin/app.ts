// CDK entry point. Settings come from `-c key=value`, cdk.json "context", or deploy.local.json
// (git-ignored: your own AuthKit domain, WorkOS client ID and email addresses; see deploy.example.json).

import { existsSync, readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { GatewayStack } from "../lib/gateway-stack";

const app = new App();
const localFile = new URL("../../deploy.local.json", import.meta.url);
const local = (existsSync(localFile) ? JSON.parse(readFileSync(localFile, "utf8")) : {}) as Record<string, string>;
const get = (key: string): string | undefined => (app.node.tryGetContext(key) as string | undefined) || local[key] || undefined;
const ctx = (key: string, fallback?: string): string => {
  const v = get(key);
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing setting "${key}". Put it in deploy.local.json (see deploy.example.json) or pass -c ${key}=...`);
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
  mcpAudience: get("mcpAudience"),
  budgetEmail: get("budgetEmail"),
  alarmEmail: get("alarmEmail"),
  inviteOnly: ctx("inviteOnly", "true") !== "false",
  contactEmail: get("contactEmail"),
  customDomain: get("customDomain"),
  certificateArn: get("certificateArn"),
});
