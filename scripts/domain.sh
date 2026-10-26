#!/usr/bin/env bash
# Custom domain, step 1: request an HTTPS certificate for it and print the DNS record that proves
# you own the domain. Step 2 is `npm run deploy` with customDomain and certificateArn in
# deploy.local.json; step 3 is pointing the domain at the CustomDomainTarget output.
#
#   scripts/domain.sh request aireporter.dev     # prints the validation record to add at your DNS host
#   scripts/domain.sh status  aireporter.dev     # PENDING_VALIDATION until the record is seen, then ISSUED
set -euo pipefail
CMD="${1:?request|status}"; DOMAIN="${2:?domain}"
REGION=$(node -e 'console.log(require("./cdk.json").context.region)')
arn() {
  aws acm list-certificates --region "$REGION" --certificate-statuses PENDING_VALIDATION ISSUED \
    --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text
}
if [ "$CMD" = request ]; then
  A=$(arn)
  if [ "$A" = "None" ] || [ -z "$A" ]; then
    A=$(aws acm request-certificate --region "$REGION" --domain-name "$DOMAIN" --validation-method DNS --query CertificateArn --output text)
    sleep 5
  fi
  echo "certificateArn: $A"
fi
A=$(arn)
aws acm describe-certificate --region "$REGION" --certificate-arn "$A" \
  --query "Certificate.{status:Status,record:DomainValidationOptions[0].ResourceRecord}" --output json
echo "Add the record above at your DNS host as a CNAME (name -> value). With Cloudflare, set it to 'DNS only' (grey cloud)."
