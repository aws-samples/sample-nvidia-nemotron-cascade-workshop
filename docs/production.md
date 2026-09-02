# Production Starting Point

This document is an actionable starting point for adapting the workshop
pattern. It is **not a turnkey architecture, compliance claim, or production
routing policy**. The sample defaults to `us-west-2`, uses short synthetic
tickets, and intentionally leaves infrastructure choices to the adopting
team.

## Start With A Measured Rollout

1. Define the business error costs for each category and priority. A missed
   P0 and an unnecessary escalation should not have the same weight.
2. Build separate calibration and test sets from approved, representative
   data. Do not tune thresholds on the final test set.
3. Run Claude Sonnet-only, Nemotron 3 Nano-only, and the Nano-to-Claude
   cascade. Treat Nemotron Super as a separate experimental benchmark, not a
   hidden tier in the headline cascade.
4. Start in shadow mode: produce cascade decisions without changing customer
   workflows. Compare against the current system and human outcomes.
5. Roll out gradually with an immediate fallback to the existing path. Gate
   expansion on error, latency, cost, throttling, and override budgets.
6. Revisit thresholds when category mix, prompts, models, or downstream policy
   changes.

The core workshop escalation signals are low confidence, P0/P1 priority, and
`needs_human`. `customer_tier` is context for the model; tier alone is not an
escalation rule. Any additional production rule needs its own evaluation and
owner.

Fine-tuning and NVIDIA NeMo-generated synthetic data can become follow-on
experiments after the baseline exposes repeatable failure modes. They are not
required to productionize the initial observable cascade.

## Credentials And Runtime Identity

The app uses the AWS SDK default credential chain; it does not use model API
keys. Local development is ready when this succeeds:

```bash
aws sts get-caller-identity
```

For a deployed workload, attach an IAM role to the compute environment—for
example, a Lambda execution role, ECS task role, EC2 instance profile, App
Runner instance role, or EKS Pod Identity role. Do not copy long-lived access
keys into application settings.

AWS reference:
[Set credentials in Node.js](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).

## Least-Privilege Bedrock Access

The Converse API is authorized through `bedrock:InvokeModel`; streaming model
inference uses `bedrock:InvokeModelWithResponseStream`. The workshop's bulk
HTTP response is application-level NDJSON, so it does not by itself require
Bedrock streaming permissions. Grant the streaming action only if the
application actually uses `ConverseStream` or another Bedrock streaming API.

Use the exact model and inference-profile ARNs for the selected Region and
account. The following is a template, not copy-paste-ready policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeApprovedTriageModels",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:REGION::foundation-model/NEMOTRON_NANO_MODEL_ID",
        "arn:aws:bedrock:REGION:ACCOUNT_ID:inference-profile/SONNET_APPLICATION_PROFILE_ID",
        "arn:aws:bedrock:REGION::foundation-model/SONNET_FOUNDATION_MODEL_ID"
      ]
    },
    {
      "Sid": "UseApprovedGuardrail",
      "Effect": "Allow",
      "Action": "bedrock:ApplyGuardrail",
      "Resource": "arn:aws:bedrock:REGION:ACCOUNT_ID:guardrail/GUARDRAIL_ID"
    }
  ]
}
```

Notes:

- Remove the Guardrail statement when no Guardrail is configured.
- Add `bedrock:InvokeModelWithResponseStream` only when required.
- A cross-Region or application inference profile can require access to the
  profile and its destination foundation models. Confirm the ARNs generated
  for your profile rather than relying on wildcard resources.
- Do not grant model-management, training, Marketplace, or broad `bedrock:*`
  permissions to the runtime role.
- Use separate roles and application inference profiles for development,
  staging, and production.

AWS references:
[Amazon Bedrock identity-based policy examples](https://docs.aws.amazon.com/bedrock/latest/userguide/security_iam_id-based-policy-examples.html),
[Converse permissions](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-call.html),
and [cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html).

## Application Inference Profiles

Create an [application inference profile](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html)
for each application, environment, and model route where supported. Invoke the
profile rather than a shared raw model identifier. This gives operations and
finance teams a stable resource for usage attribution, CloudWatch metrics,
and cost-allocation tags while preserving the underlying model routing.

Keep profile identifiers centralized alongside the model configuration. Do
not embed environment-specific profile ARNs throughout route handlers. When a
profile uses cross-Region inference, review allowed destination Regions and
data-residency requirements before rollout.

## Application Metrics With CloudWatch EMF

Bedrock service metrics do not know whether an application retry, escalation,
or model disagreement occurred. Emit one low-cardinality application record
per completed ticket. In Lambda, ECS, or another runtime that ships stdout to
CloudWatch Logs, the
[CloudWatch Embedded Metric Format](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html)
can extract metrics from structured logs.

```ts
type TriageMetricInput = {
  stage: string;
  retries: number;
  escalated: boolean;
  nanoCategory: string;
  claudeCategory?: string;
  endToEndLatencyMs: number;
  nanoLatencyMs: number;
  claudeLatencyMs?: number;
  estimatedCostUsd: number;
};

export function emitTriageMetrics(input: TriageMetricInput) {
  const comparedModels = input.claudeCategory !== undefined;
  const disagreed = comparedModels &&
    input.nanoCategory !== input.claudeCategory;

  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "TicketTriage",
        Dimensions: [["Service", "Stage"]],
        Metrics: [
          { Name: "TicketCount", Unit: "Count" },
          { Name: "RetriedTicketCount", Unit: "Count" },
          { Name: "RetryAttemptCount", Unit: "Count" },
          { Name: "EscalationCount", Unit: "Count" },
          { Name: "ComparedModelCount", Unit: "Count" },
          { Name: "ModelDisagreementCount", Unit: "Count" },
          { Name: "EndToEndLatencyMs", Unit: "Milliseconds" },
          { Name: "NanoLatencyMs", Unit: "Milliseconds" },
          { Name: "ClaudeLatencyMs", Unit: "Milliseconds" },
          { Name: "EstimatedCostUsd", Unit: "None" }
        ]
      }]
    },
    Service: "ticket-triage",
    Stage: input.stage,
    TicketCount: 1,
    RetriedTicketCount: input.retries > 0 ? 1 : 0,
    RetryAttemptCount: input.retries,
    EscalationCount: input.escalated ? 1 : 0,
    ComparedModelCount: comparedModels ? 1 : 0,
    ModelDisagreementCount: disagreed ? 1 : 0,
    EndToEndLatencyMs: input.endToEndLatencyMs,
    NanoLatencyMs: input.nanoLatencyMs,
    ClaudeLatencyMs: input.claudeLatencyMs ?? 0,
    EstimatedCostUsd: input.estimatedCostUsd
  }));
}
```

Use CloudWatch metric math for these ratios:

- **Retried-ticket rate:** `RetriedTicketCount / TicketCount`
- **Retry attempts per ticket:** `RetryAttemptCount / TicketCount`
- **Escalation rate:** `EscalationCount / TicketCount`
- **Observed model disagreement:** `ModelDisagreementCount / ComparedModelCount`

Disagreement is observable only when both models run. It is not an overall
accuracy metric, and it is biased toward escalated tickets. Measure quality
against delayed labels or human outcomes separately.

Recommended operational metrics and alarms:

- ticket count, success count, validation failures, aborts, and Bedrock errors
- retries by exception class and exhausted-retry count
- escalation rate and sudden changes from its historical band
- p50, p95, and p99 Nano, Claude, and end-to-end latency
- model disagreement on escalated or shadow-sampled tickets
- output-schema validation failures per model
- estimated cost, input/output token count, and calls per model/profile
- human override rate, category drift, and labeled quality by release

Do not use ticket IDs, subjects, free-form categories, error messages, or
customer identifiers as CloudWatch dimensions. High-cardinality dimensions
increase cost and make metrics difficult to operate.

## Bedrock Model Invocation Logging

Enable [Amazon Bedrock model invocation logging](https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html)
in each workload account and Region where the data policy allows it. It can
deliver invocation records to CloudWatch Logs and larger payloads to Amazon
S3. Use it to investigate model IDs, token usage, latency, request IDs, and
Guardrail behavior; keep the application EMF metrics for cascade-specific
signals.

Invocation logs can contain model inputs and outputs. Ticket bodies may hold
confidential or personal data, so decide whether to log text, images, and
embeddings; set encryption, access controls, retention, and deletion policies;
and test that secrets and regulated data are not captured unexpectedly. Do
not enable full prompt logging merely to obtain aggregate metrics.

## Retry And Failure Policy

- Retry throttling, service-unavailable responses, timeouts, and transient 5xx
  failures with exponential backoff, full jitter, and a finite attempt budget.
- Do not retry authentication, authorization, malformed input, schema
  validation, or unsupported-model errors.
- Choose one retry owner. If SDK retries and application retries are both
  enabled, count the combined worst case and prevent multiplicative retries.
- Give each ticket an end-to-end deadline and each model call a smaller
  timeout. Stop retries when the remaining deadline cannot accommodate them.
- Record every retry and the terminal exception class without logging ticket
  text.
- Once an NDJSON response has started, HTTP status cannot be changed. Define a
  structured error record for per-ticket failures, let unaffected tickets
  finish, and close the stream deterministically.

## Quota And Capacity Planning

Amazon Bedrock quotas vary by model, Region, and inference type. Start with
the [Amazon Bedrock quotas](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html)
and the Service Quotas console; request increases before the event or launch.

Estimate at least:

```text
model calls/second ≈ peak tickets/second × (1 + expected escalation rate)
concurrent calls   ≈ arrival rate × p95 model latency in seconds
tokens/minute      ≈ tickets/minute × expected calls/ticket × p95 tokens/call
```

Calculate Nano and Claude separately because their quotas and latencies can
differ. Include retries, shadow traffic, deployment overlap, and a safety
margin. Bound application concurrency below the sustainable quota, then load
test with synthetic tickets. A concurrency value of eight is a workshop
starting point, not a universal production setting.

If the service supports cross-Region inference for the selected model, it can
increase available capacity, but it does not remove the need for quota,
residency, and failure-mode planning.

## Guardrails And Input Safety

Use [Amazon Bedrock Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html)
only after defining and testing the policy for the ticket domain. Pin an
approved Guardrail version in production rather than relying on an editable
draft. Apply the same Guardrail configuration to every model call in every
tier, including retries and shadow invocations.

Guardrails complement rather than replace:

- Zod input and output validation
- prompt-injection-resistant instruction design
- content-size limits and timeouts
- authorization and tenant isolation
- redaction and data-retention controls
- human review for high-impact decisions

Treat ticket subjects and bodies as untrusted data. Keep them inside a clearly
delimited user-data section, instruct the model not to follow instructions
found in ticket text, and never allow a model-produced category or priority to
directly authorize destructive downstream actions. Test prompt-injection cases
that attempt to override the routing rubric, suppress escalation, or fabricate
tool output.

Support tickets can contain names, email addresses, account identifiers,
payment details, logs, and other sensitive data. Define redaction, Bedrock
invocation-logging, CloudWatch retention, cache retention, reviewer access, and
deletion policies before using representative customer traffic. Keep the
public workshop and automated tests on synthetic data.

Monitor Guardrail interventions separately from model errors and route them to
a defined user experience or human queue.

## Private Networking With VPC Endpoints

For workloads without internet egress, create an interface VPC endpoint for
the Bedrock Runtime service (`com.amazonaws.REGION.bedrock-runtime`) and enable
private DNS. Permit inbound TCP 443 on the endpoint security group only from
the workload security groups. Restrict the endpoint policy to approved runtime
roles and Bedrock actions/resources where supported.

Add control-plane endpoints only if the runtime actually calls control-plane
APIs. Private subnets may also need endpoints or approved egress for
CloudWatch Logs, AWS STS, Amazon ECR, Amazon S3, and other services used by the
chosen compute platform.

AWS reference:
[Use interface VPC endpoints with Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html).

## Pre-Launch Checklist

- [ ] Calibration and untouched test sets exist and contain approved data.
- [ ] Headline configs and optional experiments are reported separately.
- [ ] Shadow results meet category-specific quality and latency budgets.
- [ ] `customer_tier` is not an accidental escalation shortcut.
- [ ] Runtime uses an IAM role and exact model/profile resources.
- [ ] Application inference profiles and cost-allocation tags are configured.
- [ ] EMF metrics, dashboards, alarms, and on-call runbooks are tested.
- [ ] Invocation logging is configured according to the data policy.
- [ ] Quota calculations include escalation, retries, shadows, and headroom.
- [ ] Guardrail version and intervention behavior are tested for both tiers.
- [ ] Private networking, DNS, security groups, and endpoint policies work.
- [ ] A gradual rollout and immediate fallback have named owners.
