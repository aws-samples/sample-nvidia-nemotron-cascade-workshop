# CLAUDE.md - TicketTriage Workshop Project

> This file describes the original two-tier bulk-endpoint exercise. For the
> current Jev → Nano → Sonnet MCP/source example, follow `AGENTS.md` and
> `docs/three-tier-example.md`. Do not apply the Nano-first workshop rule to
> `triage_three_tier`, or create a new repo/published package for the example.

You are helping an attendee extend this Next.js app with a new bulk-triage
endpoint backed by NVIDIA Nemotron and Anthropic Claude models on Amazon
Bedrock.

This file is a compatibility copy of the code-facing workshop brief for tools
that discover `CLAUDE.md`. The attendee workflow does not require Claude or any
other specific coding assistant; the canonical manual path is
`docs/phase2-change.md`.

## Auth Model

The app uses the AWS SDK default credential chain:

```ts
new BedrockRuntimeClient({ region })
```

Whatever makes `aws sts get-caller-identity` work makes the app work. Region is
`us-west-2` unless `AWS_REGION` is set.

## Repo Conventions

```text
app/
  api/triage/route.ts                 single-ticket Sonnet baseline
  api/triage/cascade/route.ts         one-ticket Nemotron 3 Nano to Claude cascade demo
  page.tsx                            interactive routing demo
  bulk/page.tsx                       streaming bulk comparison UI
lib/
  bedrock/client.ts                   Bedrock Converse API wrapper
  bedrock/models.ts                   pinned model IDs + comparative pricing
  triage/schema.ts                    Zod schemas
  triage/prompts.ts                   system prompt + user prompt builder
data/
  sample-tickets.json                 hand-written synthetic dev set
  production-shaped-1k.json           default synthetic 85/10/5 workload
  synthetic-1k.json                   legacy boundary-stress workload
scripts/
  generate-tickets.ts                 deterministic dataset generator
  bakeoff.ts                          strategy comparison harness
tests/
  triage.test.ts                      Vitest + mocked Bedrock pattern
```

Prefer existing helpers over new abstractions. Do not hardcode model IDs; use
`MODELS` from `lib/bedrock/models.ts`.

## Bulk Endpoint Task

Add `POST /api/triage/bulk`.

Request:

```json
{ "tickets": [<Ticket>, ...] }
```

Response: `application/x-ndjson`, one JSON object per line, emitted as each
ticket completes so `/bulk` can show progress.

Required behavior:

- Validate request body and every ticket with `TicketSchema`.
- Call `MODELS.NEMOTRON_NANO` first for each ticket.
- Escalate to `MODELS.CLAUDE_SONNET` when Nano returns `confidence < 0.7`,
  priority `P0` or `P1`, or `needs_human: true`.
- Treat `customer_tier` as classifier context only; never use it as an
  escalation rule by itself.
- Stream the Nano result first; if escalated, stream the Claude result second.
- Bound concurrency. Start with 8 parallel tickets.
- Retry `ThrottlingException`, `ServiceUnavailableException`, and transient
  5xx failures with exponential backoff, full jitter, and a cap of 3 retries.
- If `BEDROCK_GUARDRAIL_ID` and `BEDROCK_GUARDRAIL_VERSION` are present, attach
  them to every `ConverseCommandInput`.
- Validate every model output with `RoutingDecisionSchema` before streaming.

## NDJSON Contract

For a Nano-only ticket:

```json
{"ticket_id":"T-001","model":"nano","decision":{...},"escalated":false,"latencyMs":580,"cost":0.0003}
```

For an escalated ticket, emit two lines:

```json
{"ticket_id":"T-002","model":"nano","decision":{...},"escalated":true,"latencyMs":610,"cost":0.0003}
{"ticket_id":"T-002","model":"claude","decision":{...},"latencyMs":4180,"cost":0.0033}
```

The `/bulk` UI keys on `ticket_id` and `model`.

## Tests

Mirror `tests/triage.test.ts`. Cover:

- Nano-only success
- Nano to Claude escalation
- Validation failure returns 400
- Retry on a simulated throttle
- The response stream closes cleanly

## Review Checklist

Before calling the task done, check:

- No raw model output is trusted without Zod validation.
- Ticket bodies are treated as untrusted user input.
- Bedrock calls are concurrency-limited.
- Retry logic has jitter and a finite retry cap.
- Route handlers do not import AWS credential env vars directly.
- Tests cover the main success and failure paths.

## Useful Commands

The 10-ticket endpoint verification can make up to 20 paid Bedrock calls. A
live verification is paid; confirm the dated input/output pricing snapshot,
current Bedrock pricing, and your spend limit first. The 30-ticket bake-off
makes 30 Nano and 30 Sonnet calls. Run it live once before attempting cache
replay.

```bash
npm run dev
npm run typecheck
npm test
npm run bakeoff -- --dataset=production --split=workshop --limit=30 --all
npm run bakeoff -- --dataset=production --split=workshop --limit=30 --dry-run --all
```
