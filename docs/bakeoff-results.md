# Bake-off per-ticket detail (30 tickets)

Ground truth: **Claude Opus 4.7** (`us.anthropic.claude-opus-4-7`).

Use this for hand-verifying which tickets the cascade catches and which it doesn't. Disagreements with the Opus answer key are flagged with ✗.

The **Cascade** column shows the model that produced the final answer, in brackets — `[Nano]` if Nano's answer was kept, `[→Claude]` if Nano's output triggered escalation and Claude's answer replaced it.

| ID | Subject | Body excerpt | Truth | Sonnet 4.6 | Nano 30B | Cascade (Nano + Claude) |
|---|---|---|---|---|---|---|
| S-0001 | Page freezes | Reports tab takes 8-15s to render. Was instant last week. | performance/P1 | ✓ performance/P1 | ✓ performance/P1 | ✓ performance/P1 [→Claude] |
| S-0002 | Slack integration broken | Salesforce sync logs show 'INVALID_FIELD' on Account.Source_ | integration/P2 | ✓ integration/P2 | ✓ integration/P2 | ✓ integration/P2 [→Claude] |
| S-0003 | Critical: writes failing | Saw a login from an IP I don't recognize. Need to lock accou | auth/P0 | ✓ auth/P0 | ✓ auth/P0 | ✓ auth/P0 [→Claude] |
| S-0004 | Forgot password link expired | Reset link says expired even though I just clicked it. | auth/P3 | ✓ auth/P2 | ✓ auth/P2 | ✓ auth/P3 [Nano] |
| S-0005 | Mobile app laggy | Mobile app is unusably slow on iPhone 14, latest iOS. | performance/P2 | ✓ performance/P1 | ✓ performance/P1 | ✓ performance/P1 [→Claude] |
| S-0006 | Charged twice this month | Can you explain the line item 'overage' on my latest invoice | billing/P3 | ✓ billing/P2 | ✓ billing/P2 | ✓ billing/P2 [Nano] |
| S-0007 | Reports take forever to load | Reports tab takes 8-15s to render. Was instant last week. | performance/P2 | ✓ performance/P2 | ✓ performance/P2 | ✓ performance/P2 [→Claude] |
| S-0008 | Hubspot fields missing | Native Notion integration ETA? | feature_request/P3 | ✓ feature_request/P2 | ✗ integration/P3 | ✓ feature_request/P2 [→Claude] |
| S-0009 | Refund for cancelled plan | Can you explain the line item 'overage' on my latest invoice | billing/P3 | ✓ billing/P3 | ✓ billing/P3 | ✓ billing/P3 [Nano] |
| S-0010 | Update payment method | Need a W-9 / tax form for our finance team. Can you send one | billing/P3 | ✓ billing/P2 | ✓ billing/P3 | ✓ billing/P3 [Nano] |
| S-0011 | Mobile app laggy | API p99 latency for /v1/search has tripled per our own metri | performance/P1 | ✓ performance/P1 | ✓ performance/P1 | ✓ performance/P1 [→Claude] |
| S-0012 | MFA code never arrives | Got 'account locked' email with no obvious cause. Need this  | auth/P1 | ✓ auth/P1 | ✓ auth/P0 | ✓ auth/P1 [→Claude] |
| S-0013 | Slack integration broken | Salesforce sync logs show 'INVALID_FIELD' on Account.Source_ | integration/P2 | ✓ integration/P1 | ✓ integration/P1 | ✓ integration/P1 [→Claude] |
| S-0014 | Why was I billed? | I see two charges of $105 on Nov 1. Please refund the duplic | billing/P2 | ✓ billing/P1 | ✓ billing/P1 | ✓ billing/P1 [→Claude] |
| S-0015 | Where is the API key? | Tried to add a custom domain but DNS verification keeps fail | integration/P3 | ✓ integration/P3 | ✓ integration/P2 | ✓ integration/P3 [→Claude] |
| S-0016 | Critical: writes failing | When I log in I'm seeing another customer's tickets. This is | auth/P0 | ✗ bug_report/P0 | ✓ auth/P0 | ✓ auth/P0 [→Claude] |
| S-0017 | Forgot password link expired | Got 'account locked' email with no obvious cause. Need this  | auth/P2 | ✓ auth/P1 | ✓ auth/P1 | ✓ auth/P1 [→Claude] |
| S-0018 | Why was I billed? | Can you explain the line item 'overage' on my latest invoice | billing/P3 | ✓ billing/P2 | ✓ billing/P3 | ✓ billing/P3 [Nano] |
| S-0019 | Hubspot fields missing | Native Notion integration ETA? | feature_request/P3 | ✓ feature_request/P3 | ✗ integration/P3 | ✓ feature_request/P3 [→Claude] |
| S-0020 | Feature request: dark mode | We need bulk edit on the tickets list — clicking one by one  | feature_request/P3 | ✓ feature_request/P3 | ✓ feature_request/P3 | ✓ feature_request/P3 [→Claude] |
| S-0021 | Visual glitch in modal | Modal close button overlaps with the X icon at <624px width. | bug_report/P3 | ✓ bug_report/P3 | ✗ performance/P3 | ✓ bug_report/P3 [→Claude] |
| S-0022 | Custom domain setup | Tried to add a custom domain but DNS verification keeps fail | integration/P2 | ✓ integration/P2 | ✓ integration/P2 | ✓ integration/P2 [→Claude] |
| S-0023 | BUG: button does nothing | Pricing page shows USD but my account is set to EUR. | billing/P3 | ✗ bug_report/P2 | ✗ bug_report/P2 | ✗ bug_report/P2 [→Claude] |
| S-0024 | Setting up webhooks | Inviting 12 teammates — is there a bulk option? | feature_request/P3 | ✓ feature_request/P3 | ✗ integration/P3 | ✗ other/P3 [Nano] |
| S-0025 | BUG: wrong data in filter | Pricing page shows USD but my account is set to EUR. | bug_report/P2 | ✓ bug_report/P2 | ✓ bug_report/P2 | ✓ bug_report/P2 [→Claude] |
| S-0026 | Charged twice this month | Cancelled in November but still got charged. Invoice #INV-58 | billing/P1 | ✓ billing/P1 | ✓ billing/P1 | ✓ billing/P1 [→Claude] |
| S-0027 | Zapier zap stopped firing | Zap that pushes new tickets to our spreadsheet hasn't run si | integration/P2 | ✓ integration/P1 | ✓ integration/P2 | ✓ integration/P2 [→Claude] |
| S-0028 | Update payment method | I see two charges of $425 on Nov 2. Please refund the duplic | billing/P2 | ✓ billing/P1 | ✓ billing/P1 | ✓ billing/P1 [→Claude] |
| S-0029 | Excited for v3 | Just wanted to say the team is excited. Keep up the great wo | other/P3 | ✓ other/P3 | ✓ other/P3 | ✓ other/P3 [Nano] |
| S-0030 | Account locked | Okta SSO redirects in a loop. Worked yesterday. | auth/P1 | ✓ auth/P1 | ✓ auth/P0 | ✓ auth/P1 [→Claude] |

## Disagreements with the answer key

**Sonnet 4.6 (2 misses, 93.3% agreement):**
- S-0016: "Critical: writes failing" — Opus said *auth*, Sonnet said *bug_report*
- S-0023: "BUG: button does nothing" — Opus said *billing*, Sonnet said *bug_report*

**Nano 30B (5 misses, 83.3% agreement):**
- S-0008: "Hubspot fields missing" — Opus said *feature_request*, Nano said *integration*
- S-0019: "Hubspot fields missing" — Opus said *feature_request*, Nano said *integration*
- S-0021: "Visual glitch in modal" — Opus said *bug_report*, Nano said *performance*
- S-0023: "BUG: button does nothing" — Opus said *billing*, Nano said *bug_report*
- S-0024: "Setting up webhooks" — Opus said *feature_request*, Nano said *integration*

**Cascade (Nano + Claude) (2 misses, 93.3% agreement, 76.7% escalation rate):**
- S-0023: "BUG: button does nothing" — Opus said *billing*, Cascade said *bug_report* (→ Claude (escalated))
- S-0024: "Setting up webhooks" — Opus said *feature_request*, Cascade said *other* (Nano kept its answer)

## What the cascade catches (and what it doesn't)

**Caught by escalation (3):** Nano was wrong, escalation fired, Claude got it right.
- S-0008: "Hubspot fields missing"
- S-0019: "Hubspot fields missing"
- S-0021: "Visual glitch in modal"

**Missed by escalation (2):** Nano was wrong, escalation did not fire (or fired but Claude also missed). These are the cases that justify domain-tuned escalation.
- S-0023: "BUG: button does nothing" — truth: *billing*, Nano: *bug_report*, cascade: *bug_report* (escalated to Claude (still wrong))
- S-0024: "Setting up webhooks" — truth: *feature_request*, Nano: *integration*, cascade: *other* (did not escalate)
