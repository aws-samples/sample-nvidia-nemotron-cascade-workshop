#!/usr/bin/env bash
# Issue a 1-day STS session credential for a workshop attendee.
#
# Run by a captain on a laptop with admin AWS creds. Output is the four
# lines an attendee needs to paste into their shell.
#
# Usage: ./scripts/issue-creds.sh <attendee-handle>

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <attendee-handle>" >&2
  exit 1
fi

HANDLE=$1
DURATION=${DURATION:-86400}   # 24h

ROLE_ARN=${WORKSHOP_ROLE_ARN:-}
if [ -z "$ROLE_ARN" ]; then
  echo "WORKSHOP_ROLE_ARN env var must be set to the IAM role attendees assume." >&2
  echo "Example: arn:aws:iam::123456789012:role/WorkshopAttendee" >&2
  exit 1
fi

CREDS=$(aws sts assume-role \
  --role-arn "$ROLE_ARN" \
  --role-session-name "ws-${HANDLE}" \
  --duration-seconds "$DURATION" \
  --output json)

ACCESS_KEY=$(echo "$CREDS" | jq -r .Credentials.AccessKeyId)
SECRET_KEY=$(echo "$CREDS" | jq -r .Credentials.SecretAccessKey)
SESSION=$(echo "$CREDS" | jq -r .Credentials.SessionToken)
EXPIRES=$(echo "$CREDS" | jq -r .Credentials.Expiration)

cat <<EOF
# Workshop credentials for ${HANDLE}
# Expires: ${EXPIRES}

export AWS_REGION=us-west-2
export AWS_ACCESS_KEY_ID=${ACCESS_KEY}
export AWS_SECRET_ACCESS_KEY=${SECRET_KEY}
export AWS_SESSION_TOKEN=${SESSION}
export CLAUDE_CODE_USE_BEDROCK=1
EOF
