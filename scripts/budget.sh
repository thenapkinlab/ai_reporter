#!/usr/bin/env bash
# Creates (or updates) a monthly AWS cost budget that emails you at 80% and 100% of actual spend.
# AWS Budgets is global; CloudFormation doesn't support it in every region, so it lives here.
# Usage: scripts/budget.sh you@example.com [amount-usd, default 10]
set -euo pipefail
EMAIL="${1:?email address}"
AMOUNT="${2:-10}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
NAME=agent-gateway-monthly
BUDGET="{\"BudgetName\":\"$NAME\",\"BudgetType\":\"COST\",\"TimeUnit\":\"MONTHLY\",\"BudgetLimit\":{\"Amount\":\"$AMOUNT\",\"Unit\":\"USD\"}}"
if aws budgets describe-budget --account-id "$ACCOUNT" --budget-name "$NAME" >/dev/null 2>&1; then
  aws budgets update-budget --account-id "$ACCOUNT" --new-budget "$BUDGET"
  echo "Updated budget $NAME to \$$AMOUNT/month."
  exit 0
fi
NOTIFS=""
for t in 80 100; do
  NOTIFS="$NOTIFS{\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":$t,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]},"
done
aws budgets create-budget --account-id "$ACCOUNT" --budget "$BUDGET" --notifications-with-subscribers "[${NOTIFS%,}]"
echo "Created budget $NAME: \$$AMOUNT/month, emails $EMAIL at 80% and 100% of actual spend."
