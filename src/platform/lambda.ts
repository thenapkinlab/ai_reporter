// AWS Lambda entry point, invoked through a Lambda Function URL.
// Cold start: read secrets from SSM once, build the app, reuse it for later requests.

import type { APIGatewayProxyStructuredResultV2 as FunctionUrlResult, LambdaFunctionURLEvent } from "aws-lambda";
import { createApp } from "../app";
import { parseThreshold, type Config } from "../config";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { bedrockExtractor, BedrockClassifier } from "../aws/bedrock";
import { DynamoTable } from "../aws/dynamo-table";
import { KmsCipher } from "../aws/kms";
import { loadParameters } from "../aws/ssm";
import { TableAccounts } from "../store/single-table";

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

async function build() {
  const env = process.env;
  const secrets = await loadParameters(required("SSM_PREFIX", env.SSM_PREFIX));
  const config: Config = {
    authkitDomain: required("AUTHKIT_DOMAIN", env.AUTHKIT_DOMAIN),
    workosClientId: required("WORKOS_CLIENT_ID", env.WORKOS_CLIENT_ID),
    workosApiKey: required("WORKOS_API_KEY (SSM)", secrets.WORKOS_API_KEY),
    googleClientId: required("GOOGLE_CLIENT_ID (SSM)", secrets.GOOGLE_CLIENT_ID),
    googleClientSecret: required("GOOGLE_CLIENT_SECRET (SSM)", secrets.GOOGLE_CLIENT_SECRET),
    sessionSecret: required("SESSION_SECRET (SSM)", secrets.SESSION_SECRET),
    withholdThreshold: parseThreshold(env.WITHHOLD_THRESHOLD),
    mcpAudience: env.MCP_AUDIENCE || undefined,
    dev: false, // never on Lambda
  };
  // Bedrock can run in a different region from the rest of the stack.
  // Extra retries with backoff absorb short bursts over the per-minute request limit.
  const bedrock = new BedrockRuntimeClient({ region: env.BEDROCK_REGION || env.AWS_REGION, maxAttempts: 5 });
  return createApp({
    config,
    accounts: new TableAccounts(new DynamoTable(required("TABLE_NAME", env.TABLE_NAME))),
    cipher: new KmsCipher(required("KMS_KEY_ID", env.KMS_KEY_ID)),
    classifier: new BedrockClassifier(required("CLASSIFIER_MODEL", env.CLASSIFIER_MODEL), bedrock),
    extractText: bedrockExtractor(required("EXTRACTOR_MODEL", env.EXTRACTOR_MODEL), bedrock),
  });
}

let app: ReturnType<typeof createApp> | undefined;

export function toRequest(event: LambdaFunctionURLEvent): Request {
  const host = event.headers["x-forwarded-host"] ?? event.requestContext.domainName;
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers.set(k, v);
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
  const method = event.requestContext.http.method;
  const body =
    event.body === undefined || method === "GET" || method === "HEAD"
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body;
  return new Request(`https://${host}${event.rawPath}${qs}`, { method, headers, body });
}

export async function toResult(res: Response): Promise<FunctionUrlResult> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  // Function URLs return cookies through a separate field, one entry per Set-Cookie.
  const cookies = res.headers.getSetCookie();
  return { statusCode: res.status, headers, cookies, body: await res.text(), isBase64Encoded: false };
}

export async function handler(event: LambdaFunctionURLEvent): Promise<FunctionUrlResult> {
  app ??= await build();
  return toResult(await app.handle(toRequest(event)));
}
