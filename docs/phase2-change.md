# Phase 2 Change Spec

Phase 2 turns the one-ticket cascade into a bulk streaming endpoint.

## Goal

Build `POST /api/triage/bulk` so the `/bulk` page can compare:

- Sonnet-only baseline
- Nemotron 3 Nano-only first pass
- Nano to Claude cascade

## Request

```json
{
  "tickets": [
    {
      "id": "T-001",
      "subject": "Reports are slow",
      "body": "The dashboard takes 15 seconds to load.",
      "customer_tier": "pro"
    }
  ]
}
```

## Response

Return `application/x-ndjson`.

Nemotron 3 Nano-only ticket:

```json
{"ticket_id":"T-001","model":"nano","decision":{...},"escalated":false,"latencyMs":580,"cost":0.0003}
```

Escalated ticket:

```json
{"ticket_id":"T-002","model":"nano","decision":{...},"escalated":true,"latencyMs":610,"cost":0.0003}
{"ticket_id":"T-002","model":"claude","decision":{...},"latencyMs":4180,"cost":0.0033}
```

## Escalation Policy

Escalate from Nemotron 3 Nano to Claude Sonnet when any condition is true:

- `confidence < 0.7`
- `priority` is `P0` or `P1`
- `needs_human` is `true`

## Implementation Requirements

- Use `getBedrockClient()` and the Converse API helper patterns already in
  `lib/bedrock/client.ts`.
- Use `MODELS.NEMOTRON_NANO` and `MODELS.CLAUDE_SONNET`; do not hardcode IDs.
- Validate request input with `TicketSchema`.
- Validate every model result with `RoutingDecisionSchema`.
- Bound concurrency to roughly 8 parallel tickets.
- Retry throttling and transient 5xx failures with exponential backoff and
  full jitter.
- Close the stream on normal completion and on client disconnect.
- Add tests for Nemotron 3 Nano-only, escalated, invalid input, and retry
  behavior.

## Done Signal

`curl` should stream at least one NDJSON line per ticket:

```bash
curl -N -X POST http://localhost:3000/api/triage/bulk \
  -H 'Content-Type: application/json' \
  -d "{\"tickets\":$(jq -c '.[0:10]' data/sample-tickets.json)}"
```

Then `/bulk` should populate rows as results arrive.
