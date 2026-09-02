# Production-Shaped Locked-Test Results

This document is the canonical result artifact for the current
production-shaped evaluation. `docs/bakeoff-results.md` records only the
methodological lesson from the discarded early run.

## Headline

On this 150-ticket synthetic, production-shaped locked test, the predeclared
Nano-to-Sonnet cascade created a useful cost and median-latency operating point,
but it did **not** recover Sonnet-only quality.

The cascade escalated 12 of 150 tickets (8.0%). In this run, compared with
Sonnet on every ticket, its estimated cost was 90.5% lower and its P50 latency
was 79.7% lower. Category agreement was 84.0% for the cascade versus 94.0% for
Sonnet-only and 82.0% for Nano-only. These are descriptive observations from
150 tickets across 11 scenario families.

This is not a “best of both worlds” result. It is evidence that a cascade can
offer a measurable operating point, while confidence-only routing can miss
systematic, high-confidence errors.

## Locked-Test Results

| Strategy | Category agreement | Joint agreement | P0/P1 recall | Human-review recall | Escalation | P50 / P95 latency | Estimated comparative cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| Sonnet-only | 94.0% `[81.4%, 100.0%]` | 83.3% `[63.2%, 97.5%]` | 100.0% `(7/7)` | 40.9% `(9/22)` | 0% | 3,362 / 5,036 ms | $1.2420 |
| Nano-only | 82.0% `[60.8%, 98.7%]` | 74.0% `[50.9%, 91.5%]` | 100.0% `(7/7)` | 54.5% `(12/22)` | 0% | 674 / 875 ms | $0.0157 |
| Nano-to-Sonnet cascade | 84.0% `[63.9%, 100.0%]` | 72.7% `[48.3%, 92.6%]` | 100.0% `(7/7)` | 31.8% `(7/22)` | 8.0% `(12/150)` | 684 / 4,427 ms | $0.1183 |

Bracketed values are deterministic scenario-family cluster-bootstrap 95%
intervals. The 150 tickets belong to 11 scenario families, so these intervals
account for repeated template structure instead of treating every ticket as an
independent observation. Wide intervals are a limitation of this synthetic
evaluation.

`Joint agreement` requires category, priority, and `needs_human` to all match
the independently reviewed label. `Human-review recall` measures how often a
strategy preserved `needs_human=true`; it is not a complete safety metric and
must be considered with false-positive rates and domain-specific harms.

## Evaluation Contract

- **Dataset:** `production-shaped-v4`, 1,000 deterministic synthetic tickets
  with an 85/10/5 routine/ambiguous/high-risk profile.
- **Locked test:** 150 tickets: 128 routine, 15 ambiguous, and 7 high-risk,
  separated by scenario family from the 50-ticket calibration set.
- **Human review:** Riley Lin independently reviewed all 150 blind worksheet items.
  This is a single-reviewer assessment using the published rubric, not a
  multi-rater agreement study.
- **Policy:** escalate when Nano confidence is below 0.7, priority is P0/P1, or
  Nano sets `needs_human=true`. Customer tier is context only.
- **Calls:** 150 Nano calls and 150 Sonnet calls. The routed result was composed
  offline from those same outputs and used 150 Nano decisions plus 12 Sonnet
  decisions.
- **Models:** `nvidia.nemotron-nano-3-30b` and
  `us.anthropic.claude-sonnet-4-6` in `us-west-2`.
- **Pricing snapshot:** `bedrock-on-demand-2026-08-31`, standard on-demand in
  `us-west-2`, sourced from `https://aws.amazon.com/bedrock/pricing/`; costs use
  separately reported input/output token usage and are not billing data.
- **Failures:** zero across both 150-call model runs.
- **Evaluation fingerprint:**
  `1f8f7cc285a660b11658ea34f693542a1a66f7852b6a320da83b6ac4bff7dcda`.
- **Human-review override hash:**
  `0170f61dab496954f194d3fb36b01640db882d384cca37ddc8ed30c131008855`.

## What Failed

Nano's largest category errors were systematic:

- 14 integration tickets were predicted as `other`.
- 10 feature-request tickets were predicted as `other`.
- 3 bug reports were predicted as `performance`.

Many of these decisions had high reported confidence. The predeclared policy
therefore did not escalate them. This is why raising a confidence threshold is
not a general fix for model blind spots.

The routed strategy also preserved only 7 of 22 human-review flags. Preserving
a primary model's safety signal after escalation is one possible production
design, but it may add false-positive review work. We did not predeclare or
score that alternative as a headline policy. Any policy change must be
selected on calibration data and evaluated on a new untouched, independently
reviewed holdout.

## Fair Interpretation

The current implementation supports four defensible conclusions:

1. A small routed tail can substantially reduce estimated cost and median
   latency relative to using the stronger model on every ticket.
2. A cascade does not automatically recover strong-model quality.
3. Confidence-only routing can miss high-confidence, systematic errors.
4. Representative data, blind human review, failure analysis, calibration,
   and a fresh holdout are required before production use.

The result does not support a universal savings claim, an SLA, a production
accuracy claim, or a claim that the workshop produces a production-ready
system.

## Replay The Recorded Result

In the evaluated working copy, the matching provenance-v3 cache can be replayed
without paid Bedrock calls:

```bash
npm run bakeoff -- \
  --dataset=production \
  --split=test \
  --dry-run \
  --all \
  --claim-summary
```

The cache directory is intentionally gitignored and is not part of a fresh
public clone. A new clone must first run the paid evaluation or restore an
approved matching cache artifact. The command rejects incompatible caches
instead of silently combining results from a different dataset, label set,
prompt, policy, model, or pricing snapshot.
