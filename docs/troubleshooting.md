# Troubleshooting

## AWS / Bedrock

### `request could not be signed with token`

Check for an empty bearer-token env var:

```bash
unset AWS_BEARER_TOKEN_BEDROCK
```

Then verify credentials:

```bash
aws sts get-caller-identity
```

If that fails, refresh credentials using your normal AWS workflow.

### `AccessDeniedException` on a model

The model is not enabled for the account. In the Bedrock console, navigate to
your configured Region (sample default: `us-west-2`), open Model access, and
enable the model IDs listed in `lib/bedrock/models.ts`.

### `ValidationException: model not supported in this region`

The configured Region does not support one of the required models. Set
`AWS_REGION` to a Region where both Nemotron 3 Nano and Claude Sonnet (or their
inference profiles) are available. Example using the sample default:

```bash
export AWS_REGION=us-west-2
```

### `ThrottlingException` During Bulk Triage

The endpoint is probably sending too many parallel Bedrock calls.

Fixes:

- Limit concurrency to roughly 8 parallel tickets.
- Retry throttling with exponential backoff and full jitter.
- Test with 10-20 tickets before using the full synthetic dataset.

## Next.js

### Missing AWS SDK Package

```bash
npm install
```

### Port 3000 In Use

```bash
PORT=3001 npm run dev
```

## Bake-Off

### `npm run bakeoff -- --all` Is Slow

Use:

```bash
npm run bakeoff -- --dry-run --all
```

Or reduce scope:

```bash
npm run bakeoff -- --all --limit=30
```

### Agreement Is `n/a`

Generate labels first:

```bash
npm run bakeoff -- --label --limit=30
```
