# Adding Jev: measured routing tradeoffs

This is the 2026-09-21 extension of the existing Nemotron/Claude ticket-triage
example. It preserves the earlier project's emphasis on model roles, observable
handoffs, and evaluation. The [2026-08-31 two-tier result](production-shaped-results.md)
remains a separate historical artifact.

## The question

What changes when Jev classifies before the existing Nano/Sonnet cascade?
In particular, can Nano handle some of the tickets Jev defers, reducing Sonnet
calls compared with sending every Jev deferral directly to Sonnet?

The reusable contribution is a runnable routing policy and the evidence needed
to examine that choice. The result is specific to this ticket taxonomy, rubric,
prompt formats and dataset.

## Solution overview

Jev runs through Vercel AI Gateway. Nemotron 3 Nano and Claude Sonnet run through
the existing Amazon Bedrock Converse client. All three receive the same ticket
and classification rubric, in provider-specific formats. They do not receive
earlier answers.

The policy selects paths; it does not run three models on every request:

- Routine Jev decisions with minimum field confidence at least 0.8 finish early.
- Jev's uncertain routine decisions go to Nano.
- Jev P0/P1 or human-review signals go directly to Sonnet.
- Nano escalates to Sonnet on confidence below 0.7, P0/P1 or `needs_human`.

The thresholds were selected before this Jev comparison in the local development
workflow, not externally preregistered or calibrated to correctness probabilities.
The selected test split had already been examined in prior work.

## Evaluation setup

| Item | Recorded evidence |
|---|---|
| Inputs | 150 deterministic synthetic support tickets, 11 scenario families |
| Cohorts | 128 routine, 15 ambiguous, 7 high-risk |
| References | Previously completed blind review by one human reviewer, using the published rubric |
| Nano / Sonnet | 150 successful outputs each, collected 2026-08-31 |
| Jev | 150 successful outputs collected 2026-09-21; collection encountered throttling and retries |
| Comparison | Counterfactual replay of six configurations over matching per-ticket outputs |
| Freshness | Reuse of a previously examined split; not a new untouched holdout |
| Price basis | Recorded successful-call token usage and dated market price snapshots |

The inputs are synthetic; the model outputs are from actual API calls.
“Human-reviewed” does not mean multiple reviewers agreed, a partner approved
the new architecture, or an independent organization validated the new results.

## Quality

| Configuration | Category agreement | Joint agreement | Final-model human recall | Preserved-review recall |
|---|---:|---:|---:|---:|
| Sonnet only | 141/150 (94.0%) | 125/150 (83.3%) | 9/22 | 9/22 |
| Nano only | 123/150 (82.0%) | 111/150 (74.0%) | 12/22 | 12/22 |
| Jev only | 142/150 (94.7%) | 135/150 (90.0%) | 17/22 | 17/22 |
| Original Nano → Sonnet | 126/150 (84.0%) | 109/150 (72.7%) | 7/22 | 12/22 |
| Jev → Sonnet | 150/150 (100.0%) | 135/150 (90.0%) | 9/22 | 17/22 |
| Jev → Nano → Sonnet | 150/150 (100.0%) | 135/150 (90.0%) | 9/22 | 17/22 |

Category agreement asks only whether the category matches the reference.
Joint agreement requires category, priority and the **final model's**
`needs_human` to all match.

Preserved-review recall is a separate operational signal: any earlier model's
P0/P1 or `needs_human` signal remains true in `review_required`. Applying the
same OR rule retrospectively to the old two-tier output gives 12/22, but the
original app's final human flag remains 7/22. This does not rewrite the original
policy or its published result.

All six configurations had zero preserved-review false positives among the 128
reference-negative tickets. Five expected human-review cases remained undetected
by the three-tier policy. These counts are descriptive; repeated scenario
templates mean the 150 tickets are not 150 independent real-world cases.
No new statistical-significance or production-generalization claim is made.

## Calls and estimated cost

| Configuration | Jev / Nano / Sonnet calls selected in replay | Successful-call market cost estimate, USD |
|---|---|---:|
| Sonnet only | 0 / 0 / 150 | $1.241988 |
| Nano only | 0 / 150 / 0 | $0.015726 |
| Jev only | 150 / 0 / 0 | $0.010859 |
| Original Nano → Sonnet | 0 / 150 / 12 | $0.118317 |
| Jev → Sonnet | 150 / 0 / 31 | $0.278990 |
| Jev → Nano → Sonnet | 150 / 14 / 17 | $0.161834 |

Adding Nano between Jev and Sonnet reduced selected Sonnet calls from 31 to 17
and the successful-call estimate by 42.0%, with the same observed category and
joint agreement. Against the original Nano → Sonnet strategy, the three-tier
estimate was **36.8% higher**, while category and joint agreement were higher.
The two comparisons answer different questions.

The price basis is $0.042 per million Jev input tokens and zero output-token
price, with the recorded 2026-08-31 Bedrock snapshot for Nano/Sonnet. These are
dated comparison inputs, not assertions about today's or another account's bill.
The Jev alias `typesafe-ai/jev` does not pin the provider's underlying version.

The cost table excludes unknown failed/retried attempt charges, hosting and
human review. The raw report intentionally marks incomplete total costs as null;
the table above sums only the known successful-call components. Gateway-reported
charges for the 150 successful Jev results totaled zero, while their market-cost
estimate was $0.010859. That does not establish that Jev is free.

Batch latency is not presented as a model-speed comparison. The first 59 Jev
records came from unpaced collection; the remaining 91 include collector
queueing. Combining those with historical Bedrock timings would be misleading
as a current end-to-end performance claim.

## What the middle layer did

Of 150 tickets, 119 finished at Jev, 14 at Nano, and 17 at Sonnet. No ticket
in this replay traversed Jev → Nano → Sonnet. That final escalation branch
exists and is covered with mocked unit tests, but was not observed in the
150-ticket replay or the three live MCP examples.

On the 14 tickets Jev sent to Nano, Nano and Sonnet each matched all three
reference labels on 9/14. There were no cases in that subset where one model
matched all three labels and the other did not. “Nano retained 14 tickets”
therefore does **not** mean Nano answered all 14 completely correctly.

- **P-0053, reconnecting Slack:** Jev chose `auth` with minimum field confidence
  0.43. Nano correctly chose `integration`, P3 and no human review, matching
  Sonnet and the reference. Nano avoided a Sonnet call on this ticket.
- **P-0075, a saved filter intermittently disappearing:** the reference calls
  for human review of ambiguous behavior. All three models missed that review
  requirement. The related misses were P-0099, P-0152, P-0155 and P-0192.

## Runtime verification

Three separate actual calls through the MCP client confirmed the following
paths. These are connectivity/routing examples, not a latency benchmark or
additional accuracy test set:

| Ticket | Observed path | Recorded end-to-end elapsed time |
|---|---|---:|
| P-0051 | Jev | 539 ms |
| P-0053 | Jev → Nano | 977 ms |
| P-0062 | Jev → Sonnet | 3,415 ms |

See [the recorded MCP outputs](research/three-tier-live-smoke.json). The
three-tier entry points are MCP and CLI; the web UI still demonstrates the
original two-tier app.

## Reproduce and inspect

```bash
npm ci
npm run audit:three-tier
```

This requires neither credentials nor private caches. The auditor reads every
public result, checks it against the existing reviewed labels and rubric/input
fingerprints, independently recalculates routing, verifies price estimates from
usage, and recomputes summaries and the middle-layer subset.

It is a consistency audit, not a signed provider attestation or a fresh human
review. It does not rerun models. Use [the live comparison instructions](three-tier-example.md)
for new inference; new model samples may differ.

| Claim | Evidence and calculation |
|---|---|
| 150/150 category, 135/150 joint | Every record's final decision compared with its reviewed reference; all six configurations retained |
| 31 → 17 Sonnet calls | Sum each configuration's selected calls; 14 Jev-deferred tickets stopped at Nano |
| 42.0% lower estimate vs Jev → Sonnet | `1 - 0.16183368 / 0.27899010` |
| 36.8% higher estimate vs original cascade | `0.16183368 / 0.11831652 - 1` |
| Five preserved-review misses | Reference `needs_human=true` and three-tier `review_required=false` |
| No full three-model replay paths | Count routes exactly equal to `jev→nano→sonnet` |

Sources: [public per-ticket records](research/three-tier-comparison.json),
[machine-readable audit](research/three-tier-evidence-audit.json),
[collection notes](research/three-tier-run-notes.json),
[reviewed dataset and methodology](production-shaped-results.md),
and [Chinese findings](research/three-tier-findings.zh-CN.md).

## What to validate next

Use a new, independently labeled workload to evaluate the selected policy,
including shared blind spots and human-review workload. Measure latency under
a controlled collection setup. The current example supports inspecting a useful
division of work, with a measured tradeoff on one reused synthetic dataset.
