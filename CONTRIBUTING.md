# Contributing

Thank you for your interest in contributing.

This repository contains model-routing examples, including a Jev extension
to the original Nemotron/Claude cascade and an optional two-tier workshop.
Contributions should keep the examples focused, understandable and reproducible.

## Guidelines

- Keep the examples partner-agnostic. Do not require a specific coding
  assistant, IDE, PR review tool, or GitHub app.
- Do not commit credentials, account IDs, private service URLs, customer data, or
  screenshots containing private information.
- Keep synthetic datasets synthetic. If data is generated, document the
  generator and seed.
- Prefer small pull requests with tests.
- Run `npm test` and `npm run typecheck` before submitting changes.
- Run `npm run audit:three-tier` when editing results or public claims. Preserve
  historical measured artifacts; distinguish new model calls, replay and mocks.
- Describe costs as dated estimates and bound quality claims to the measured
  dataset. A changed policy requires new evaluation, not relabeling old results.

## Security

Do not open public issues for security findings. Follow [SECURITY.md](SECURITY.md).
