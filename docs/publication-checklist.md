# Publication Checklist

Target repository name:

```text
sample-nvidia-nemotron-cascade-workshop
```

## Done In This Repo

- Partner-specific review workflow removed from workshop docs and UI copy.
- MIT-0 `LICENSE` added.
- `package.json` declares `MIT-0`.
- `NOTICE`, `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md` added.
- Node 20 pinned with `.nvmrc` and `package.json` `engines`.
- Build-time Google Font dependency removed.
- PCSR scan attachments generated locally:
  `security-scans/semgrep.json` and `security-scans/npm-audit.json`.
- `docs/phase2-change.md` added for the attendee implementation task.
- Tool-specific review and local-agent settings removed from tracked sample
  content.

## Needs Owner Action

- Complete OpenSourcerer self-certification.
- Submit PCSR and wait for approval before making the repository public.
- Confirm the final public name with stakeholders.
- Confirm model IDs and benchmark numbers are approved for publication.
- Re-run the bake-off in the approved AWS account and refresh `README.md`,
  `docs/bakeoff-results.md`, and the publication blog deliverables if the
  numbers change. Keep calibration data separate from the final test set.
- Confirm all sample tickets are synthetic and approved for public release.
- Decide whether to preserve git history or publish a clean initial commit.

## OpenSourcerer Summary

**Repo name:** `sample-nvidia-nemotron-cascade-workshop`

**Description:** Partner-agnostic workshop scaffold for two-tier LLM inference
on Amazon Bedrock. NVIDIA Nemotron 3 Nano 30B A3B handles the routine
support-ticket classification path and escalates uncertain or high-stakes
tickets to Anthropic Claude Sonnet.

**License:** MIT-0

**Datasets:** Synthetic sample tickets in `data/sample-tickets.json` and
deterministically generated synthetic tickets in `data/synthetic-1k.json`.

**Primary third-party dependencies:** AWS SDK for JavaScript, Next.js, React,
Zod, Tailwind CSS, TypeScript, Vitest.

**Models referenced:** NVIDIA Nemotron 3 Nano 30B A3B, optional NVIDIA
Nemotron Super, Anthropic Claude Sonnet, and Anthropic Claude Opus as the
offline separate judge model.
