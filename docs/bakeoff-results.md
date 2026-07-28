# Bake-Off Detail (30-ticket live run)

Reference judge: **Claude Opus 4.7** (`us.anthropic.claude-opus-4-7`), used as a **separate judge model**.

Costs use actual token usage returned by the Bedrock Converse API and the comparative pricing constants in `lib/bedrock/models.ts`; they are sample comparisons, not billing quotes. The high-disagreement category list was derived from this same workshop sample, so these results describe sample behavior rather than expected production performance. Calibrate on separate data and report final results on an independent test set.

## Summary

| Strategy | Total cost | Avg latency | Category agreement with judge | Escalation rate |
|---|---:|---:|---:|---:|
| Sonnet 4.6 only | $0.3230 | 4,476ms | 96.7% (29/30) | n/a |
| Nemotron 3 Nano only | $0.0184 | 680ms | 83.3% (25/30) | n/a |
| Cascade (Nano + Claude) | $0.2774 | 4,326ms | 93.3% (28/30) | 80.0% (24/30) |

## Per-ticket results

| ID | Subject | Body preview | Opus answer key | Sonnet 4.6 | Nemotron 3 Nano | Cascade |
|---|---|---|---|---|---|---|
| S-0001 | Page freezes | Reports tab takes 8-15s to render. Was instant last week. | performance/P1 | ✓ performance/P1 | ✓ performance/P1 | ✓ performance/P1 [→Claude] |
| S-0002 | Slack integration broken | Salesforce sync logs show 'INVALID_FIELD' on Account.Source__… | integration/P2 | ✓ integration/P2 | ✓ integration/P2 | ✓ integration/P2 [→Claude] |
| S-0003 | Critical: writes failing | Saw a login from an IP I don't recognize. Need to lock accoun… | auth/P0 | ✓ auth/P0 | ✓ auth/P0 | ✓ auth/P0 [→Claude] |
| S-0004 | Forgot password link expired | Reset link says expired even though I just clicked it. | auth/P3 | ✓ auth/P2 | ✓ auth/P3 | ✓ auth/P3 [Nano] |
| S-0005 | Mobile app laggy | Mobile app is unusably slow on iPhone 14, latest iOS. | performance/P2 | ✓ performance/P1 | ✓ performance/P2 | ✓ performance/P1 [→Claude] |
| S-0006 | Charged twice this month | Can you explain the line item 'overage' on my latest invoice? | billing/P3 | ✓ billing/P2 | ✓ billing/P2 | ✓ billing/P2 [Nano] |
| S-0007 | Reports take forever to load | Reports tab takes 8-15s to render. Was instant last week. | performance/P2 | ✓ performance/P2 | ✓ performance/P2 | ✓ performance/P2 [→Claude] |
| S-0008 | Hubspot fields missing | Native Notion integration ETA? | feature_request/P3 | ✓ feature_request/P2 | ✗ integration/P3 | ✓ feature_request/P2 [→Claude] |
| S-0009 | Refund for cancelled plan | Can you explain the line item 'overage' on my latest invoice? | billing/P3 | ✓ billing/P3 | ✓ billing/P3 | ✓ billing/P3 [Nano] |
| S-0010 | Update payment method | Need a W-9 / tax form for our finance team. Can you send one … | billing/P3 | ✓ billing/P2 | ✓ billing/P3 | ✓ billing/P3 [Nano] |
| S-0011 | Mobile app laggy | API p99 latency for /v1/search has tripled per our own metric… | performance/P1 | ✓ performance/P1 | ✓ performance/P1 | ✓ performance/P1 [→Claude] |
| S-0012 | MFA code never arrives | Got 'account locked' email with no obvious cause. Need this b… | auth/P1 | ✓ auth/P1 | ✓ auth/P0 | ✓ auth/P1 [→Claude] |
| S-0013 | Slack integration broken | Salesforce sync logs show 'INVALID_FIELD' on Account.Source__… | integration/P2 | ✓ integration/P1 | ✓ integration/P1 | ✓ integration/P1 [→Claude] |
| S-0014 | Why was I billed? | I see two charges of $105 on Nov 1. Please refund the duplica… | billing/P2 | ✓ billing/P1 | ✓ billing/P1 | ✓ billing/P1 [→Claude] |
| S-0015 | Where is the API key? | Tried to add a custom domain but DNS verification keeps faili… | integration/P3 | ✓ integration/P3 | ✓ integration/P2 | ✓ integration/P3 [→Claude] |
| S-0016 | Critical: writes failing | When I log in I'm seeing another customer's tickets. This is … | auth/P0 | ✓ auth/P0 | ✓ auth/P0 | ✗ bug_report/P0 [→Claude] |
| S-0017 | Forgot password link expired | Got 'account locked' email with no obvious cause. Need this b… | auth/P2 | ✓ auth/P1 | ✓ auth/P1 | ✓ auth/P1 [→Claude] |
| S-0018 | Why was I billed? | Can you explain the line item 'overage' on my latest invoice? | billing/P3 | ✓ billing/P2 | ✓ billing/P3 | ✓ billing/P3 [Nano] |
| S-0019 | Hubspot fields missing | Native Notion integration ETA? | feature_request/P3 | ✓ feature_request/P3 | ✗ integration/P3 | ✓ feature_request/P3 [→Claude] |
| S-0020 | Feature request: dark mode | We need bulk edit on the tickets list — clicking one by one i… | feature_request/P3 | ✓ feature_request/P3 | ✓ feature_request/P3 | ✓ feature_request/P3 [→Claude] |
| S-0021 | Visual glitch in modal | Modal close button overlaps with the X icon at <624px width. | bug_report/P3 | ✓ bug_report/P3 | ✗ performance/P3 | ✓ bug_report/P3 [→Claude] |
| S-0022 | Custom domain setup | Tried to add a custom domain but DNS verification keeps faili… | integration/P2 | ✓ integration/P2 | ✓ integration/P2 | ✓ integration/P2 [→Claude] |
| S-0023 | BUG: button does nothing | Pricing page shows USD but my account is set to EUR. | billing/P3 | ✗ bug_report/P2 | ✗ bug_report/P2 | ✗ bug_report/P2 [→Claude] |
| S-0024 | Setting up webhooks | Inviting 12 teammates — is there a bulk option? | feature_request/P3 | ✓ feature_request/P3 | ✗ integration/P3 | ✓ feature_request/P3 [→Claude] |
| S-0025 | BUG: wrong data in filter | Pricing page shows USD but my account is set to EUR. | bug_report/P2 | ✓ bug_report/P2 | ✓ bug_report/P2 | ✓ bug_report/P2 [→Claude] |
| S-0026 | Charged twice this month | Cancelled in November but still got charged. Invoice #INV-582… | billing/P1 | ✓ billing/P1 | ✓ billing/P0 | ✓ billing/P1 [→Claude] |
| S-0027 | Zapier zap stopped firing | Zap that pushes new tickets to our spreadsheet hasn't run sin… | integration/P2 | ✓ integration/P1 | ✓ integration/P2 | ✓ integration/P2 [→Claude] |
| S-0028 | Update payment method | I see two charges of $425 on Nov 2. Please refund the duplica… | billing/P2 | ✓ billing/P1 | ✓ billing/P1 | ✓ billing/P1 [→Claude] |
| S-0029 | Excited for v3 | Just wanted to say the team is excited. Keep up the great wor… | other/P3 | ✓ other/P3 | ✓ other/P3 | ✓ other/P3 [Nano] |
| S-0030 | Account locked | Okta SSO redirects in a loop. Worked yesterday. | auth/P1 | ✓ auth/P1 | ✓ auth/P0 | ✓ auth/P1 [→Claude] |

## Disagreements with the answer key

**Sonnet 4.6 (1 miss, 96.7% agreement):**
- S-0023: "BUG: button does nothing" — Opus said *billing*, Sonnet said *bug_report*

**Nemotron 3 Nano (5 misses, 83.3% agreement):**
- S-0008: "Hubspot fields missing" — Opus said *feature_request*, Nemotron said *integration*
- S-0019: "Hubspot fields missing" — Opus said *feature_request*, Nemotron said *integration*
- S-0021: "Visual glitch in modal" — Opus said *bug_report*, Nemotron said *performance*
- S-0023: "BUG: button does nothing" — Opus said *billing*, Nemotron said *bug_report*
- S-0024: "Setting up webhooks" — Opus said *feature_request*, Nemotron said *integration*

**Cascade (2 misses, 93.3% agreement):**
- S-0016: "Critical: writes failing" — Opus said *auth*, Cascade said *bug_report* (escalated to Claude)
- S-0023: "BUG: button does nothing" — Opus said *billing*, Cascade said *bug_report* (escalated to Claude)

## What the cascade catches (and what it doesn't)

**Caught by escalation (4):** Nano was wrong, escalation fired, and Claude matched the judge.
- S-0008: "Hubspot fields missing"
- S-0019: "Hubspot fields missing"
- S-0021: "Visual glitch in modal"
- S-0024: "Setting up webhooks"

**Missed by the cascade (1):** Nano was wrong and either escalation did not fire or Claude also disagreed with the judge.
- S-0023: "BUG: button does nothing" — judge: *billing*, Nano: *bug_report*, cascade: *bug_report* (escalated to Claude)
