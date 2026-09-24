# cascade-classify MCP server

Two tools are available from the same server:

- `triage_three_tier(ticket)` — Jev → Nano → Sonnet ticket classification.
  See the [runnable example and comparison](../docs/three-tier-example.md).
- `cascade_classify(text, labels[])` — the existing generic classifier described below.

The new tool adds Jev ahead of the existing ticket-domain Nano/Sonnet cascade.
It returns category, priority, final-model `needs_human`, preserved
`review_required`, and every stage decision. Jev uses Vercel AI Gateway; Nano
and Sonnet use Bedrock. Read the [measured tradeoff](../docs/three-tier-results.md)
or run `npm run audit:three-tier` to recompute the public evidence without
credentials. The rest of this page documents the original generic tool.

NVIDIA Nemotron 3 Nano classifies every request. Anthropic Claude Sonnet is
called when Nano's probability margin shows uncertainty or when the caller
activates an explicit stakes or label guardrail. You get the strong model on
the routed tail without paying for it on every request.

## Why margin, not confidence

A single self-reported confidence score is uncalibrated — an intentionally
boundary-heavy 30-item stress demonstration caught the small model reporting
0.92+ confidence on answers that disagreed with a separate model reference.
That small run is routing-behavior evidence, not a production accuracy claim.
Instead, the model is asked (via forced tool-calling) to distribute
probability across **all** candidate labels. The top1−top2 gap provides another
routing feature. This generated distribution is also uncalibrated, and a
large gap can accompany an incorrect answer.
That distribution only exists over a fixed candidate set, which is why this
tool is scoped to classification rather than open-ended generation.

## Mount It

Run `npm ci` from the repository root, then configure the server in any MCP
client that supports a local stdio command. Use that client's documented
configuration location and replace the absolute repository paths below:

```json
{
  "mcpServers": {
    "cascade-classify": {
      "command": "/absolute/path/to/repo/node_modules/.bin/tsx",
      "args": [
        "--tsconfig",
        "/absolute/path/to/repo/tsconfig.json",
        "/absolute/path/to/repo/mcp/server.ts"
      ],
      "env": { "AWS_REGION": "us-west-2" }
    }
  }
}
```

The explicit `--tsconfig` lets the shared TypeScript imports resolve even when
the MCP client starts the server from a different working directory.

Credentials: AWS SDK default chain — whatever makes
`aws sts get-caller-identity` work makes this server work. The account
needs Bedrock model access for `nvidia.nemotron-nano-3-30b` and
`us.anthropic.claude-sonnet-4-6` (see repo README).

Every classification invokes a paid Nano call and an escalated request invokes
an additional paid Sonnet call. Review current Bedrock pricing, model access,
Region, and quotas before use. The repository's 30-ticket workshop estimates
do not predict this generic tool's token shape or cost.

## Tool arguments

| Argument | Type | Default | Notes |
|---|---|---|---|
| `text` | string | required | The text to classify. Treated as untrusted data. |
| `labels` | string[2..50] | required | Candidate labels; the answer is one of these. |
| `margin_threshold` | number 0-1 | 0.25 | Escalate when top1−top2 < this. Lower = cheaper/riskier. |
| `force_escalate` | boolean | false | Always use the strong model (caller knows stakes are high). |
| `escalate_labels` | string[] | none | Labels that always escalate when they are the top pick, regardless of margin. Use for labels the small model is known to confuse. |

## Margin is a signal, not a guarantee

The probability margin is computed from the model's generated distribution.
A narrow margin can be an uncertainty signal, but it is not a calibrated
correctness estimate. Margin has a known blind spot: **distribution saturation**. When
the small model assigns ~100% probability to a single label, the margin is
maximal even if the label is wrong. This is a generic limitation of
confidence-like routing signals, not a production error-rate claim.

Mitigations available today:
- `escalate_labels`: domain-knowledge guardrail for labels you know are
  risky; define this from independent calibration evidence or domain policy
- `force_escalate`: caller-side override for known-high-stakes inputs

Automatic saturation detection is not implemented because it requires
independent calibration and false-positive analysis.

For catastrophic-miss domains (medical, legal), use this tool **in
conjunction with** human-in-the-loop review, not as a replacement for it.

For production concerns including metrics, quotas, invocation logging,
Guardrails, and private connectivity, see `../docs/production.md`.

## Illustrative result shape

```json
{
  "label": "critical",
  "distribution": [{ "label": "critical", "probability": 0.95 }, ...],
  "escalated": false,
  "model_used": "nvidia.nemotron-nano-3-30b",
  "primary_margin": 0.92,
  "latency_ms": 1005,
  "approx_cost_usd": 0.00028
}
```

The numeric values above are illustrative. Actual latency, token usage, and
cost depend on the selected models, Region, response length, and current
pricing snapshot.

## When to reach for this

Any sort-into-fixed-categories step that runs at volume: intent detection,
ticket/alert routing, moderation triage, log severity, document tagging.
If your task looks open-ended, try reframing it first — "is this PR risky?"
becomes `classify(diff, [safe, needs-review, risky])`.

Not a fit: open-ended outputs (no candidate set → no margin signal), low
volume (just use the strong model), or catastrophic-miss domains that need
human-in-the-loop.

## Relationship to the workshop app

The ticket-triage app in this repo demonstrates the same two-tier pattern with
a domain-specific schema. This server is the generic,
label-set-parameterized version. They share the Bedrock client and model
constants, but use different routing signals and must be evaluated separately.
