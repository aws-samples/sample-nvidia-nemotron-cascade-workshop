# AGENTS.md - TicketTriage Examples

The current addition is a runnable Jev → Nano → Sonnet example in this existing
repository, exposed through a source CLI and MCP. Follow
[docs/three-tier-example.md](docs/three-tier-example.md). It does not require
a new repository, a published package, or a workshop.

The existing two-tier Next.js app and workshop remain as baselines.
[docs/phase2-change.md](docs/phase2-change.md) is the manual implementation
contract specifically for that legacy bulk-endpoint exercise.
[CLAUDE.md](CLAUDE.md) contains its compatibility brief.

- Use the existing Bedrock client and Zod schemas.
- Keep model IDs centralized in `lib/bedrock/models.ts`.
- For `triage_three_tier`, call Jev's evaluation API first. Jev P0/P1 or
  `needs_human` goes directly to Sonnet. Other uncertain results go to Nano;
  Nano escalates on confidence < 0.7, P0/P1, or `needs_human`.
- Preserve earlier review signals in `review_required`; report it separately
  from the final model's label.
- Preserve the original Nano-first policy in the existing app/bakeoff baseline.
- Implement `POST /api/triage/bulk` as streaming NDJSON only when working on
  the legacy bulk-endpoint exercise.
- Treat `customer_tier` as classifier context, never as an escalation rule by
  itself.
- Keep examples independent of any specific coding assistant or PR review vendor.
- Use reviewed synthetic labels for comparisons. Historical-cache replay and
  summed latency are not new holdout results or live end-to-end measurements.
- Run `npm run audit:three-tier` for external numeric claims. Its default path
  uses public records, not private paid-run caches. Keep the original dated
  result, the exploratory Jev comparison, and new inference runs distinct.
