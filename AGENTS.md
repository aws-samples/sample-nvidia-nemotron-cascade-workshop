# AGENTS.md - TicketTriage Workshop Project

This repository is a partner-agnostic workshop scaffold for building a
confidence-based LLM cascade on Amazon Bedrock.

Use [docs/phase2-change.md](docs/phase2-change.md) as the canonical manual
implementation contract. [CLAUDE.md](CLAUDE.md) is a compatibility copy for
tools that discover that filename.

- Use the existing Bedrock client and Zod schemas.
- Keep model IDs centralized in `lib/bedrock/models.ts`.
- Build `POST /api/triage/bulk` as a streaming NDJSON endpoint.
- Call Nemotron 3 Nano first and escalate to Claude Sonnet on low confidence,
  P0/P1 priority, or `needs_human`.
- Treat `customer_tier` as classifier context, never as an escalation rule by
  itself.
- Keep the workshop independent of any specific coding assistant or PR review
  vendor.
