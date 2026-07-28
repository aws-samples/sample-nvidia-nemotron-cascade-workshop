# cascade-classify MCP server

One tool: `cascade_classify(text, labels[])` — cost-optimal text
classification on Amazon Bedrock.

NVIDIA Nemotron 3 Nano classifies every request. Anthropic Claude Sonnet is
called when Nano's probability margin shows uncertainty or when the caller
activates an explicit stakes or label guardrail. You get the strong model on
the routed tail without paying for it on every request.

## Why margin, not confidence

A single self-reported confidence score is uncalibrated — our bake-off
caught the small model reporting 0.92+ confidence on answers it got wrong.
Instead, the model is asked (via forced tool-calling) to distribute
probability across **all** candidate labels. When it is torn between two
labels the top1−top2 margin is small, no matter what confidence it claims.
That distribution only exists over a fixed candidate set, which is why this
tool is scoped to classification rather than open-ended generation.

## Mount it

Claude Code (`.mcp.json` in your project, or `~/.claude.json`):

```json
{
  "mcpServers": {
    "cascade-classify": {
      "command": "npx",
      "args": ["tsx", "<path-to-repo>/mcp/server.ts"],
      "env": { "AWS_REGION": "us-west-2" }
    }
  }
}
```

Credentials: AWS SDK default chain — whatever makes
`aws sts get-caller-identity` work makes this server work. The account
needs Bedrock model access for `nvidia.nemotron-nano-3-30b` and
`us.anthropic.claude-sonnet-4-6` (see repo README).

## Tool arguments

| Argument | Type | Default | Notes |
|---|---|---|---|
| `text` | string | required | The text to classify. Treated as untrusted data. |
| `labels` | string[2..50] | required | Candidate labels; the answer is one of these. |
| `margin_threshold` | number 0-1 | 0.25 | Escalate when top1−top2 < this. Lower = cheaper/riskier. |
| `force_escalate` | boolean | false | Always use the strong model (caller knows stakes are high). |
| `escalate_labels` | string[] | none | Labels that always escalate when they are the top pick, regardless of margin. Use for labels the small model is known to confuse. |

## Margin is a signal, not a guarantee

The probability margin is structurally honest — when the model is torn
between two labels, the margin is small no matter how "confident" it claims
to be. But margin has a known blind spot: **distribution saturation**. When
the small model assigns ~100% probability to a single label, the margin is
maximal even if the label is wrong. Our bake-off caught this — Nano reported
0.92+ confidence on answers it got wrong.

Mitigations available today:
- `escalate_labels`: domain-knowledge guardrail for labels you know are
  risky (the single biggest accuracy win in our testing)
- `force_escalate`: caller-side override for known-high-stakes inputs

Not yet implemented: automatic saturation detection (escalate when top1 >
threshold, e.g. 0.98). This is a tracked TODO — we need empirical data on
the false-positive rate before adding it.

For catastrophic-miss domains (medical, legal), use this tool **in
conjunction with** human-in-the-loop review, not as a replacement for it.

## Result shape

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

## When to reach for this

Any sort-into-fixed-categories step that runs at volume: intent detection,
ticket/alert routing, moderation triage, log severity, document tagging.
If your task looks open-ended, try reframing it first — "is this PR risky?"
becomes `classify(diff, [safe, needs-review, risky])`.

Not a fit: open-ended outputs (no candidate set → no margin signal), low
volume (just use the strong model), or catastrophic-miss domains that need
human-in-the-loop.

## Relationship to the workshop app

The ticket-triage app in this repo is the flagship demonstration of the
same cascade pattern with a domain-specific schema. This server is the
generic, label-set-parameterized version. Both share
`lib/cascade/` for escalation logic.
