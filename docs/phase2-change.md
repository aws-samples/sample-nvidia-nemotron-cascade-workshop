# Phase 2: Bulk Streaming Change

Phase 2 is the instructor-led implementation exercise. It turns the
one-ticket cascade into a bounded-concurrency bulk endpoint while keeping the
repository independently runnable without a specific coding assistant.

The implementation and mocked tests do not require paid model calls. The
10-ticket live verification makes 10 Nano calls and up to 10 Sonnet calls. A
live verification is paid; confirm the dated input/output pricing snapshot,
current Bedrock pricing, and your spend limit before running it.

## Goal And Exact Path

Create exactly:

```text
app/api/triage/bulk/route.ts
```

That file must export `POST /api/triage/bulk`. The existing `/bulk` page is the
consumer. Do not place the handler in `app/api/triage/bulk.ts` or rename the
route.

## Request Contract

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

Validate the body shape and every array item with `TicketSchema`. Keep ticket
content untrusted. Return a `400` response for an invalid request before
starting a successful NDJSON stream.

`customer_tier` is optional classification context. It is not an escalation
condition by itself.

## NDJSON Response Contract

Return these headers:

```http
Content-Type: application/x-ndjson
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

NDJSON means one complete JSON object followed by `\n`. It is not a JSON array
and does not contain SSE fields such as `event:` or `data:`.

Nano-only ticket:

```json
{"ticket_id":"T-001","model":"nano","decision":{"ticket_id":"T-001","category":"performance","priority":"P2","confidence":0.91,"reasoning":"Slow dashboard report.","needs_human":false},"escalated":false,"latencyMs":580,"cost":0.0003}
```

Escalated ticket, emitted as two separate lines:

```json
{"ticket_id":"T-002","model":"nano","decision":{"ticket_id":"T-002","category":"auth","priority":"P1","confidence":0.88,"reasoning":"Many users are blocked.","needs_human":true},"escalated":true,"latencyMs":610,"cost":0.0003}
{"ticket_id":"T-002","model":"claude","decision":{"ticket_id":"T-002","category":"auth","priority":"P1","confidence":0.98,"reasoning":"SSO outage requires urgent action.","needs_human":true},"latencyMs":4180,"cost":0.0033}
```

Latencies, costs, confidence, and classifications are examples. With bounded
parallelism, ticket IDs may appear out of request order. For a single
escalated ticket, the `nano` line must always be emitted before its `claude`
line. The stream closes after all ticket tasks settle or when the client
disconnects.

The browser reader must not assume that one network chunk equals one line.
Decode chunks incrementally, append them to a text buffer, split complete
records on `\n`, preserve the unfinished tail, and call `JSON.parse` once per
complete line.

## Escalation Policy

Call `MODELS.NEMOTRON_NANO` first for every ticket. Call
`MODELS.CLAUDE_SONNET` only when the Nano decision meets at least one core
rule:

- `confidence < 0.7`
- `priority` is `P0` or `P1`
- `needs_human` is `true`

Do not escalate solely because `customer_tier` is `enterprise`, `pro`, or any
other value. Production teams can evaluate additional domain rules later, but
those rules are not part of this workshop contract.

## Manual Implementation Path

This is the primary reproducible path and does not require a coding agent.

1. Read `app/api/triage/cascade/route.ts` for the existing streaming and cost
   patterns, then read `lib/bedrock/client.ts`, `lib/bedrock/models.ts`, and
   `lib/triage/schema.ts`.
2. Create `app/api/triage/bulk/route.ts` with the Node.js runtime and a `POST`
   handler.
3. Parse and validate `{ tickets: [...] }` before constructing the successful
   response stream.
4. Create a `ReadableStream<Uint8Array>` and one `TextEncoder`. Enqueue every
   event as `JSON.stringify(event) + "\n"`.
5. Process at most eight tickets concurrently. Use a worker pool or limiter;
   do not call unbounded `Promise.all` over the input.
6. For each ticket, call Nemotron 3 Nano, validate the returned decision with
   `RoutingDecisionSchema`, decide whether to escalate, and immediately enqueue
   the Nano line.
7. If the core escalation rule fires, call Claude Sonnet, validate that
   decision, and enqueue the Claude line.
8. Retry only throttling, service-unavailable, and transient 5xx failures with
   exponential backoff, full jitter, and no more than three retries. Do not
   retry validation or other deterministic client errors.
9. If both `BEDROCK_GUARDRAIL_ID` and `BEDROCK_GUARDRAIL_VERSION` are set,
   attach them to every Bedrock request.
10. Stop scheduling work when the request is aborted, close the stream once,
    and avoid enqueueing after closure.
11. Add focused tests mirroring `tests/triage.test.ts`: Nano-only success,
    escalation, invalid request, retry after a simulated throttle, and clean
    stream closure.

Use the existing Bedrock client and schemas. Keep all model IDs centralized in
`lib/bedrock/models.ts`; never paste provider model IDs into the route.

## Optional Vendor-Neutral Coding-Agent Prompt

The manual path above is canonical. If the instructor chooses to demonstrate
an AI coding agent, the following prompt does not assume a vendor, pane, IDE,
or code-review product:

```text
Read AGENTS.md and docs/phase2-change.md first. Implement the workshop bulk endpoint at
exactly app/api/triage/bulk/route.ts and add focused tests using existing test
patterns. Reuse the existing Bedrock client, MODELS constants, TicketSchema,
and RoutingDecisionSchema. Accept {tickets: Ticket[]} and return streaming
application/x-ndjson. Run Nemotron 3 Nano first for every ticket; stream its
validated result immediately; escalate to Claude Sonnet only when confidence
is below 0.7, priority is P0/P1, or needs_human is true; then stream the
validated Claude result. Customer tier is context, not an escalation rule.
Bound concurrency at 8, retry only transient Bedrock failures with exponential
backoff plus full jitter and at most 3 retries, honor optional Guardrail env
vars, and close cleanly on completion or client abort. Do not edit UI, scripts,
model IDs, or unrelated files. Run focused tests and typecheck, then summarize
changed paths and verification.
```

Review generated code rather than accepting it as authoritative. The endpoint
contract and tests, not the choice of agent, define completion.

## Verification

Start the app, then send ten repository-owned synthetic tickets:

```bash
npm run dev
```

```bash
curl -N -sS -X POST http://localhost:3000/api/triage/bulk \
  -H 'Content-Type: application/json' \
  -d "{\"tickets\":$(jq -c '.[0:10]' data/sample-tickets.json)}"
```

Expected result:

- Lines appear while the request is still open; `curl -N` disables its output
  buffering.
- Every accepted ticket produces exactly one `model: "nano"` line.
- Only escalated tickets produce a later `model: "claude"` line.
- Every output line is independently valid JSON.
- The connection closes after the final result.

Validate each line mechanically:

```bash
curl -N -sS -X POST http://localhost:3000/api/triage/bulk \
  -H 'Content-Type: application/json' \
  -d "{\"tickets\":$(jq -c '.[0:10]' data/sample-tickets.json)}" \
  | while IFS= read -r line; do printf '%s\n' "$line" | jq -e . >/dev/null; done
```

Then open <http://localhost:3000/bulk>. Rows should populate incrementally.
For every escalated row, the routing-reason column must identify whether the
trigger was low confidence, P0/P1 priority, or `needs_human`; customer tier
must never appear as a trigger.
Finally run the focused tests and typecheck:

```bash
npm test
npm run typecheck
```

## Out Of Scope For The Core Exercise

- A full self-paced curriculum or Workshop Studio provisioning
- Fine-tuning either model
- Generating a new corpus with NVIDIA NeMo
- Adding Nemotron Super as a third live routing tier
- Designing a production deployment, learned router, or organization-wide
  safety policy

Those are useful follow-on activities after the core cascade is measured and
understood.

For a production starting point rather than a workshop implementation, see
[production.md](production.md).
