# AGENTS.md - TicketTriage Workshop Project

This repository is a partner-agnostic workshop scaffold for building a
confidence-based LLM cascade on Amazon Bedrock.

Use the same implementation guidance as [CLAUDE.md](CLAUDE.md):

- Use the existing Bedrock client and Zod schemas.
- Keep model IDs centralized in `lib/bedrock/models.ts`.
- Build `POST /api/triage/bulk` as a streaming NDJSON endpoint.
- Call Nemotron 3 Nano first and escalate to Claude Sonnet on low confidence,
  P0/P1 priority, or `needs_human`.
- Keep the workshop independent of any specific coding assistant or PR review
  vendor.
