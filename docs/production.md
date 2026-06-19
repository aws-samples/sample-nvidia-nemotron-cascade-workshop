# Production Notes

This sample uses the AWS SDK default credential chain. There are no model API
keys in the application.

```ts
new BedrockRuntimeClient({ region: "us-west-2" })
```

## Local Development

Any AWS credential flow is acceptable if this succeeds:

```bash
aws sts get-caller-identity
```

Common options:

- `aws configure`
- IAM Identity Center with `aws sso login --profile <name>`
- Temporary STS credentials exported in the shell or `.env.local`

## Runtime IAM Policy

Attach an IAM role to the runtime with the minimum Bedrock permissions needed
for the selected models.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:Converse",
      "bedrock:ConverseStream"
    ],
    "Resource": [
      "arn:aws:bedrock:us-west-2:*:inference-profile/us.anthropic.claude-sonnet-4-6",
      "arn:aws:bedrock:us-west-2::foundation-model/nvidia.nemotron-nano-3-30b",
      "arn:aws:bedrock:us-west-2::foundation-model/nvidia.nemotron-super-3-120b"
    ]
  }]
}
```

Where to attach it depends on the runtime:

- App Runner: instance role
- Lambda: execution role
- ECS Fargate: task role
- EC2: instance profile
- EKS: IRSA or Pod Identity

## Production Readiness Checklist

- Run a domain-specific evaluation before choosing thresholds.
- Shadow the cascade beside the current production model.
- Add CloudWatch metrics for retry rate, escalation rate, per-ticket cost, and
  model disagreement.
- Configure Bedrock Guardrails if ticket bodies contain untrusted user input.
- Set service quotas for expected peak traffic.
- Add alerting for Bedrock throttling and elevated escalation rate.

