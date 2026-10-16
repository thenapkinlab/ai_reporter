// Everything the gateway needs on AWS, as one CloudFormation stack:
// a DynamoDB table, a KMS key, the Lambda function with a public HTTPS URL,
// least-privilege permissions, a log group, CloudWatch alarms and a dashboard for the operator,
// and the nightly totals job. The budget alert is set up separately (scripts/budget.sh).

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
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
  withholdThreshold: string;
  mcpAudience?: string;
  /** Per-user email limits and the shared classifier budget (requests per minute). */
  userEmailsPer10Min: string;
  userEmailsPerDay: string;
  modelRequestsPerMinute: string;
  /** Most Lambda instances at once: bounds cost and keeps one user from flooding the account. */
  maxConcurrency: number;
  /** Used as the alarm address when alarmEmail isn't set (the budget itself: scripts/budget.sh). */
  budgetEmail?: string;
  /** Where CloudWatch alarms are emailed (the operator, never users). Falls back to budgetEmail. */
  alarmEmail?: string;
}

export class GatewayStack extends Stack {
  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    // One table, pay per request. TTL removes old audit records automatically.
    const table = new dynamodb.TableV2(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: "expiresAt",
      // Beta users' accounts, settings and Gmail connections live here: keep the table if the
      // stack is deleted, and allow restoring to any second in the last 35 days.
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
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

    // Nightly product totals (funnel, activity, feedback) at 02:00 UTC: counts only, see src/stats.ts.
    const statsFn = new NodejsFunction(this, "DailyStats", {
      entry: path.join(here, "../../src/platform/stats.ts"),
      depsLockFilePath: path.join(here, "../../package-lock.json"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(2),
      logGroup: new logs.LogGroup(this, "StatsLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      environment: { TABLE_NAME: table.tableName },
      bundling: { format: OutputFormat.ESM, target: "node24", minify: true, sourceMap: true, banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    });
    // Least privilege: read everything to add it up, write only its own STATS totals.
    statsFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["dynamodb:Scan"], resources: [table.tableArn] }));
    statsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem"],
        resources: [table.tableArn],
        conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["STATS"] } },
      }),
    );
    new events.Rule(this, "DailyStatsSchedule", {
      schedule: events.Schedule.cron({ minute: "0", hour: "2" }),
      targets: [new targets.LambdaFunction(statsFn)],
    });

    // Alarms go to the operator by email (SNS asks you to confirm the subscription once).
    // Users never see these; they get the tool's own "busy" or "limit reached" messages.
    const alarmTopic = new sns.Topic(this, "AlarmTopic", { displayName: "Agent gateway alarms" });
    const alarmEmail = props.alarmEmail ?? props.budgetEmail;
    if (alarmEmail) alarmTopic.addSubscription(new subs.EmailSubscription(alarmEmail));
    const custom = (metricName: string, period: Duration) =>
      new cloudwatch.Metric({ namespace: "AgentGateway", metricName, statistic: "Sum", period });
    const alarms: [string, cloudwatch.IMetric, number, string][] = [
      ["ModelBusy", custom("ModelBusy", Duration.minutes(5)), 1, "Requests refused because the shared Bedrock budget was full. Ask AWS for a higher quota or lower usage."],
      ["ModelUnavailable", custom("ModelUnavailable", Duration.minutes(5)), 1, "Emails withheld because the classifier didn't answer (errors or throttling)."],
      ["UserLimits", custom("UserLimitReached", Duration.hours(1)), 10, "Users hitting their email limits often: check for loops or raise the limits."],
      ["LambdaErrors", fn.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }), 3, "Gateway Lambda errors."],
      ["LambdaThrottles", fn.metricThrottles({ period: Duration.minutes(5), statistic: "Sum" }), 1, "Lambda refused requests: the concurrency cap was reached."],
      ["DailyStatsErrors", statsFn.metricErrors({ period: Duration.hours(24), statistic: "Sum" }), 1, "The nightly totals job failed."],
    ];
    const allAlarms: cloudwatch.Alarm[] = [];
    for (const [id, metric, threshold, description] of alarms) {
      const alarm = new cloudwatch.Alarm(this, `${id}Alarm`, {
        alarmName: `agent-gateway-${id}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
      alarm.addOkAction(new cwActions.SnsAction(alarmTopic));
      allAlarms.push(alarm);
    }

    // Slow searches: p95 above 8 s for 15 minutes in a row.
    const searchLatency = new cloudwatch.Metric({
      namespace: "AgentGateway", metricName: "TotalMs", dimensionsMap: { Tool: "search_email" }, statistic: "p95", period: Duration.minutes(5),
    });
    const latencyAlarm = new cloudwatch.Alarm(this, "SearchLatencyAlarm", {
      alarmName: "agent-gateway-SearchLatency",
      alarmDescription: "search_email p95 latency above 8 s for 15 minutes.",
      metric: searchLatency,
      threshold: 8000,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    latencyAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
    latencyAlarm.addOkAction(new cwActions.SnsAction(alarmTopic));

    // One CloudWatch dashboard for reliability, filter quality and usage. Counts and timings only.
    const search = (expr: string, stat: string, period: number, label: string) =>
      new cloudwatch.MathExpression({ expression: `SEARCH('${expr}', '${stat}', ${period})`, label, usingMetrics: {}, period: Duration.seconds(period) });
    const ns = (metricName: string, dims: Record<string, string>, statistic: string, period: Duration, label: string) =>
      new cloudwatch.Metric({ namespace: "AgentGateway", metricName, dimensionsMap: dims, statistic, period, label });
    const daily = (stat: string) => ns("Daily", { Stat: stat }, "Maximum", Duration.days(1), stat);
    const lat = (tool: string, stat: string) => ns("TotalMs", { Tool: tool }, stat, Duration.minutes(5), `${tool} ${stat}`);
    const part = (name: string) => ns(name, { Tool: "search_email" }, "p95", Duration.minutes(5), `${name} p95`);
    new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: "agent-gateway",
      defaultInterval: Duration.days(7),
      widgets: [
        [new cloudwatch.TextWidget({ markdown: "## Reliability and performance", width: 24, height: 1 })],
        [
          new cloudwatch.GraphWidget({ title: "Tool calls by outcome", left: [search('{AgentGateway,Outcome,Tool} MetricName="ToolCalls"', "Sum", 300, "")], width: 8, stacked: true }),
          new cloudwatch.GraphWidget({ title: "Latency (ms)", left: [lat("search_email", "p50"), lat("search_email", "p95"), lat("read_email", "p95")], leftAnnotations: [{ value: 8000, label: "alarm" }], width: 8 }),
          new cloudwatch.GraphWidget({ title: "search_email time split, p95 (ms)", left: [part("GmailMs"), part("FilterMs")], width: 8 }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: "Model and limits",
            left: [
              ns("ModelBusy", {}, "Sum", Duration.minutes(5), "busy (refused)"),
              ns("ModelUnavailable", {}, "Sum", Duration.minutes(5), "emails withheld: model unavailable"),
              ns("UserLimitReached", {}, "Sum", Duration.minutes(5), "user limit reached"),
            ],
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: "Lambda",
            left: [fn.metricErrors({ period: Duration.minutes(5) }), fn.metricThrottles({ period: Duration.minutes(5) })],
            right: [fn.metricDuration({ period: Duration.minutes(5), statistic: "p95" })],
            width: 8,
          }),
          new cloudwatch.AlarmStatusWidget({ title: "Alarms", alarms: [...allAlarms, latencyAlarm], width: 8 }),
        ],
        [new cloudwatch.TextWidget({ markdown: "## Filter quality", width: 24, height: 1 })],
        [
          new cloudwatch.GraphWidget({ title: "Emails by decision and prompt version", left: [search('{AgentGateway,Action,PromptVersion} MetricName="Emails"', "Sum", 3600, "")], width: 8, stacked: true }),
          new cloudwatch.GraphWidget({ title: "Reasons (withheld or values removed)", left: [search('{AgentGateway,Reason} MetricName="Reasons"', "Sum", 3600, "")], width: 8, stacked: true }),
          new cloudwatch.GraphWidget({ title: "User feedback (release / keep / leak by type)", left: [search('{AgentGateway,Item,Kind} MetricName="Feedback"', "Sum", 86400, "")], width: 8, stacked: true }),
        ],
        [new cloudwatch.TextWidget({ markdown: "## Usage (nightly totals)", width: 24, height: 1 })],
        [
          new cloudwatch.GraphWidget({ title: "Funnel", left: ["users_total", "gmail_connected", "used_from_assistant", "active_7d", "active_1d"].map(daily), width: 8 }),
          new cloudwatch.GraphWidget({ title: "Emails per day", left: ["emails_1d", "shared_1d", "redacted_1d", "withheld_1d"].map(daily), width: 8 }),
          new cloudwatch.GraphWidget({ title: "Requests per day", left: ["searches_1d", "reads_1d", "claude_runs_1d", "chatgpt_runs_1d", "background_runs_1d"].map(daily), width: 8 }),
        ],
        [
          new cloudwatch.GraphWidget({ title: "Sign-in and Gmail connection steps", left: [search('{AgentGateway,Step} MetricName="Funnel"', "Sum", 86400, "")], width: 12 }),
          new cloudwatch.GraphWidget({ title: "Week-2 retention (cohort / retained) and new users", left: ["week2_cohort", "week2_retained", "users_new_1d"].map(daily), width: 12 }),
        ],
      ],
    });

    // The $10/month budget alert is created outside this stack (`npm run budget`): CloudFormation
    // doesn't support AWS::Budgets::Budget in every region (eu-north-1 included).

    new CfnOutput(this, "GatewayUrl", { value: fnUrl.url, description: "Dashboard (sign in here)" });
    new CfnOutput(this, "McpUrl", { value: `${fnUrl.url}mcp`, description: "Paste into Claude or ChatGPT" });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}
