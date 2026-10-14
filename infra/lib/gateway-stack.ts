// Everything the gateway needs on AWS, as one CloudFormation stack:
// a DynamoDB table, a KMS key, the Lambda function with a public HTTPS URL,
// least-privilege permissions, a log group, and an optional monthly budget alert.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface GatewayStackProps extends StackProps {
  authkitDomain: string;
  workosClientId: string;
  /** SSM path holding the secrets, e.g. /agent-gateway */
  ssmPrefix: string;
  /** Region for Bedrock calls; can differ from the stack's region. */
  bedrockRegion: string;
  classifierModel: string;
  extractorModel: string;
  withholdThreshold: string;
  mcpAudience?: string;
  /** Per-user email limits and the shared classifier budget (requests per minute). */
  userEmailsPer10Min: string;
  userEmailsPerDay: string;
  modelRequestsPerMinute: string;
  /** Most Lambda instances at once: bounds cost and keeps one user from flooding the account. */
  maxConcurrency: number;
  /** If set, a $10/month budget emails this address at 80% and 100%. */
  budgetEmail?: string;
}

export class GatewayStack extends Stack {
  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    // One table, pay per request. TTL removes old audit records automatically.
    // DESTROY suits a test environment: `cdk destroy` removes the data too.
    const table = new dynamodb.TableV2(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Encrypts Gmail refresh tokens. Rotated yearly by AWS.
    const tokenKey = new kms.Key(this, "TokenKey", {
      description: "Encrypts Gmail refresh tokens for the agent gateway",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7),
    });

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new NodejsFunction(this, "Gateway", {
      entry: path.join(here, "../../src/platform/lambda.ts"),
      depsLockFilePath: path.join(here, "../../package-lock.json"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      reservedConcurrentExecutions: props.maxConcurrency,
      timeout: Duration.seconds(60),
      logGroup,
      environment: {
        TABLE_NAME: table.tableName,
        KMS_KEY_ID: tokenKey.keyId,
        SSM_PREFIX: props.ssmPrefix,
        AUTHKIT_DOMAIN: props.authkitDomain,
        WORKOS_CLIENT_ID: props.workosClientId,
        BEDROCK_REGION: props.bedrockRegion,
        CLASSIFIER_MODEL: props.classifierModel,
        EXTRACTOR_MODEL: props.extractorModel,
        WITHHOLD_THRESHOLD: props.withholdThreshold,
        USER_EMAILS_PER_10MIN: props.userEmailsPer10Min,
        USER_EMAILS_PER_DAY: props.userEmailsPerDay,
        MODEL_REQUESTS_PER_MINUTE: props.modelRequestsPerMinute,
        ...(props.mcpAudience ? { MCP_AUDIENCE: props.mcpAudience } : {}),
      },
      bundling: {
        format: OutputFormat.ESM,
        target: "node24",
        minify: true,
        sourceMap: true,
        // Lets bundled CommonJS dependencies call require() inside an ES module.
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });

    // Least privilege: this table, this key, these parameters, Bedrock model calls.
    table.grantReadWriteData(fn);
    tokenKey.grantEncryptDecrypt(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParametersByPath"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
        ],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        // Cross-region inference profiles route to foundation models in several regions.
        resources: [
          "arn:aws:bedrock:*::foundation-model/*",
          `arn:aws:bedrock:${props.bedrockRegion}:${this.account}:inference-profile/*`,
        ],
      }),
    );

    // Public HTTPS endpoint. Authentication happens in the app (AuthKit tokens and sessions).
    const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    if (props.budgetEmail) {
      new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetName: "agent-gateway-monthly",
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: 10, unit: "USD" },
        },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold, thresholdType: "PERCENTAGE" },
          subscribers: [{ subscriptionType: "EMAIL", address: props.budgetEmail! }],
        })),
      });
    }

    new CfnOutput(this, "GatewayUrl", { value: fnUrl.url, description: "Dashboard (sign in here)" });
    new CfnOutput(this, "McpUrl", { value: `${fnUrl.url}mcp`, description: "Paste into Claude or ChatGPT" });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}
