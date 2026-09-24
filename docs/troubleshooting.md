# Troubleshooting

Use repository-owned synthetic tickets while diagnosing the examples. Do not
paste customer ticket data into commands, screenshots, logs, or issue reports.

## Jev And The Three-Tier Example

- `Set AI_GATEWAY_API_KEY for Jev`: supply the key to the CLI/MCP server process.
  Standalone commands do not automatically load `.env.local`.
- MCP startup fails with `Cannot find module '@/lib/triage/prompts'`: include
  `--tsconfig /absolute/path/to/repo/tsconfig.json` before the server path in the
  `tsx` arguments. See [the complete MCP configuration](three-tier-example.md#use-as-an-mcp-tool).
- HTTP 401/403: check the server's Gateway credential and model access.
  Authentication errors stop the request.
- HTTP 429 during collection: use `npm run compare:three-tier:collect`, wait for
  the account's quota window if throttling persists, and resume. Completed
  results are checkpointed. This limiter coordinates one process only.
- Missing baseline caches: `npm run audit:three-tier` audits the public result
  without caches. To create a new comparison, collect Nano and Sonnet first
  using the paid commands in [the example guide](three-tier-example.md).
- The web demo still shows Nano → Sonnet: the new three-tier entry points are
  `triage_three_tier` over MCP and `npm run triage:three-tier`.

## AWS Credentials And Bedrock

### `request could not be signed with token`

An empty or stale bearer-token variable can override the normal credential
chain:

```bash
unset AWS_BEARER_TOKEN_BEDROCK
aws sts get-caller-identity
```

If identity lookup fails, refresh the selected profile or temporary
credentials before restarting `npm run dev`.

### `AccessDeniedException` On A Model Or Inference Profile

Check all four items:

1. `AWS_REGION` is the Region used by the app.
2. The model or inference profile in `lib/bedrock/models.ts` is available to
   the account in that Region.
3. The runtime principal has `bedrock:InvokeModel` on the exact profile and
   required foundation-model resources.
4. If a Guardrail is configured, the principal can use that Guardrail and the
   ID/version pair exists in the same Region.

Do not fix this by granting `bedrock:*`. Use the least-privilege template and
official links in [production.md](production.md).

### `ValidationException: model not supported in this region`

Set a Region where both headline models or their inference profiles are
available, then restart the dev server:

```bash
export AWS_REGION=us-west-2
npm run dev
```

Confirm availability and model IDs rather than assuming the sample default is
valid for every account.

### `ThrottlingException` During Bulk Triage

- Start with 10 tickets, not the 1,000-ticket dataset.
- Keep the workshop concurrency bounded near eight.
- Retry only transient failures with exponential backoff, full jitter, and a
  finite cap.
- Avoid stacking large SDK and application retry budgets.
- Check model-specific quotas and request an increase before a workshop.

Safe smoke-test input:

```bash
jq -c '.[0:10]' data/sample-tickets.json
```

## Bulk Route And NDJSON

### `/api/triage/bulk` Returns `404`

The App Router path must be exactly:

```text
app/api/triage/bulk/route.ts
```

After creating it, restart the dev server if Next.js did not detect the new
directory.

### The Request Returns `400`

The request body must be an object with a `tickets` array. Each item must match
`TicketSchema`; `customer_tier` is optional, but when present it must be one of
the allowed schema values.

Inspect the generated body without sending it:

```bash
printf '{"tickets":%s}\n' "$(jq -c '.[0:2]' data/sample-tickets.json)" | jq
```

### No Lines Appear Until The Request Finishes

- Use `curl -N` to disable curl buffering.
- Enqueue `JSON.stringify(record) + "\n"` immediately after each model result.
- Return `Content-Type: application/x-ndjson`, `Cache-Control: no-cache,
  no-transform`, and `X-Accel-Buffering: no`.
- Check whether a local or deployed proxy buffers streaming responses.
- Do not collect all results before constructing the response.

### `JSON.parse` Fails In The Browser

Network chunks do not align with NDJSON records. One chunk can contain part of
a line or several lines. Keep a text remainder between reads, split only on
newline characters, and parse only complete non-empty lines. Do not parse each
raw `reader.read()` value as a complete JSON document.

### Results Are Out Of Ticket Order

That is expected with bounded parallelism. The invariant is per ticket: the
Nano line comes before the Claude line. The `/bulk` client keys records by
`ticket_id` and `model`; it should not depend on input order.

### A Nano Result Has No Claude Result

Claude runs only when Nano returns `confidence < 0.7`, priority `P0`/`P1`, or
`needs_human: true`. `customer_tier` alone must not trigger escalation. Inspect
the Nano decision before treating a one-line result as a failure.

### The Stream Never Closes

Ensure every worker resolves or rejects, retries have a finite cap, the abort
signal stops new work, and `controller.close()` runs exactly once after all
workers settle. Avoid enqueueing after abort or closure.

### Validate Every NDJSON Line

```bash
curl -N -sS -X POST http://localhost:3000/api/triage/bulk \
  -H 'Content-Type: application/json' \
  -d "{\"tickets\":$(jq -c '.[0:10]' data/sample-tickets.json)}" \
  | while IFS= read -r line; do printf '%s\n' "$line" | jq -e . >/dev/null; done
```

No output and exit status `0` means every received line parsed successfully.

## Bake-Off

### Dry-Run Says `No cache for ...`

Dry-run is a replay, not a substitute for the first live run. Run Nano and
Sonnet once; the script then composes the routed strategy offline from those
exact cached outputs:

```bash
npm run bakeoff -- --dataset=production --split=workshop --limit=30 --all

npm run bakeoff -- --dataset=production --split=workshop --limit=30 --dry-run --all
```

Do not reverse this order on a fresh checkout.

### Opus Reference Agreement Is `n/a`

Production source-intent metrics do not require an Opus call. `n/a` for the
optional Opus-reference columns means matching reference labels do not exist
in the provenance-v3 cache. Generate them only when a second-model reference
is useful:

```bash
npm run bakeoff -- --dataset=production --split=workshop --limit=30 --label
```

Judge labeling invokes a paid Bedrock model. It is a reference or adjudication
signal, not unquestioned ground truth.

### An Unexpected `super` Row Appears

The workshop headline is Sonnet-only, Nano-only, and the `routed`
Nano-to-Claude cascade. `--all` runs exactly those three. Nemotron Super is an
optional experimental benchmark and appears only when you add
`--experimental-super` or explicitly request `--config=super
--experimental-super`.

Use `--dataset=production` for the production-shaped profile and
`--dataset=stress` for the boundary-stress profile. Their caches are isolated.
`--split=workshop` selects 30 tickets, `--split=calibration` selects the fixed
50-ticket tuning set, and `--split=test` selects the locked 150-ticket test
set. All 1,000 require `--split=all --full-dataset`.

### The Live Run Is Slow Or Expensive

- Confirm the output says `Evaluation split: workshop` and 30 tickets.
- Confirm the command includes `--limit=30`; do not rely on an implicit sample
  size in workshop instructions.
- Prefer `--all`: it calls Nano and Sonnet once each and composes routed
  results offline rather than paying for a third set of model samples.
- Stop before retrying repeatedly; partial live runs still incur model usage.
- Check quotas and throttling before increasing concurrency.
- The first live run is paid. Confirm the dated input/output pricing snapshot
  in `lib/bedrock/models.ts`, review current Bedrock pricing, and set a spend
  limit. Optional Opus labeling is additional.
- After one successful live run, use `--dry-run` for demonstrations.

### A Live Run Fails Partway Through

The harness does not cache incomplete runs. Fix the underlying error and rerun
the failed model configuration. This prevents strategies from being compared
on different ticket subsets, although successful model calls before the error
still incur Bedrock usage.

### Human-Review Gate Blocks `--split=test` Or `--claim-summary`

This is intentional. Independently review all 150 entries in
`data/production-shaped-1k.test-review-worksheet.json`, then add the final
labels and review metadata to the `reviews` array in
`data/production-shaped-1k.human-review-overrides.json`. Each entry must be
marked `human_reviewed` or `adjudicated` and include the reviewer and timestamp.

Do not edit the generated source-intent file to bypass the gate. Regeneration
replaces generated inputs and labels but preserves the reviewer-owned override
file. Use `--claim-summary` for any number intended for a blog, presentation,
or external claim; development-only workshop output remains clearly labeled.

## Next.js And Local Tooling

### Missing Package Or Module

Install the lockfile-pinned dependencies:

```bash
npm ci
```

### Port 3000 Is In Use

```bash
PORT=3001 npm run dev
```

Update the curl URL to `http://localhost:3001` for that session.

### `jq: command not found`

Install `jq` with the package manager for the instructor machine, or construct
the small request body manually. `jq` is a workshop convenience, not an
application runtime dependency.

### Typecheck Or Tests Fail After An Agent Edit

Review the diff first. Confirm the change is limited to the requested route
and tests, uses the existing helpers and model constants, and did not edit UI
or bake-off behavior. Then run:

```bash
npm test
npm run typecheck
```

Do not hide unrelated failures or relax schemas merely to make generated code
pass.
