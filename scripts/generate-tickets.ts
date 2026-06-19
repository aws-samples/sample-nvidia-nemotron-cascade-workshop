#!/usr/bin/env tsx
/**
 * Generate the synthetic 1k-ticket dataset used by the Phase 4 bake-off.
 * Deterministic via mulberry32 — running this twice produces identical output.
 *
 * Usage: npm run generate-tickets
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Ticket } from "../lib/triage/schema";

const OUT_PATH = "data/synthetic-1k.json";
const COUNT = 1000;
const SEED = 42;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

const TIERS: Ticket["customer_tier"][] = ["free", "pro", "enterprise"];

interface Template {
  weight: number;
  subjects: string[];
  bodies: string[];
}

// Weight distribution roughly mirrors a real B2B SaaS support inbox:
// lots of billing/auth/how-to, smaller volume of bug + outage.
const TEMPLATES: Template[] = [
  {
    weight: 18,
    subjects: [
      "Charged twice this month",
      "Refund for cancelled plan",
      "Invoice question",
      "Why was I billed?",
      "Update payment method",
    ],
    bodies: [
      "I see two charges of {{amount}} on {{date}}. Please refund the duplicate.",
      "Cancelled in {{month}} but still got charged. Invoice #{{inv}}.",
      "Can you explain the line item 'overage' on my latest invoice?",
      "Tried to update my card and it kept failing — error code BIL-{{code}}.",
      "Need a W-9 / tax form for our finance team. Can you send one over?",
    ],
  },
  {
    weight: 14,
    subjects: [
      "Can't log in",
      "SSO not working",
      "Forgot password link expired",
      "MFA code never arrives",
      "Account locked",
    ],
    bodies: [
      "Reset link says expired even though I just clicked it.",
      "Okta SSO redirects in a loop. Worked yesterday.",
      "MFA SMS never delivered. Tried 3 times, ${{count}} users affected.",
      "Got 'account locked' email with no obvious cause. Need this back today.",
      "After Google login I land on a 500 page.",
    ],
  },
  {
    weight: 12,
    subjects: [
      "How do I export data?",
      "Where is the API key?",
      "Setting up webhooks",
      "Inviting teammates",
      "Custom domain setup",
    ],
    bodies: [
      "Can't find the CSV export button — is this a Pro-only feature?",
      "Following your docs but step {{step}} doesn't match what I see.",
      "Tried to add a custom domain but DNS verification keeps failing.",
      "Inviting 12 teammates — is there a bulk option?",
      "Webhook secret rotation — what's the recommended process?",
    ],
  },
  {
    weight: 10,
    subjects: [
      "Slack integration broken",
      "Salesforce sync errors",
      "Zapier zap stopped firing",
      "Hubspot fields missing",
      "Notion connection",
    ],
    bodies: [
      "Slack messages stopped posting at {{time}}. Channel webhook still active in our settings.",
      "Salesforce sync logs show 'INVALID_FIELD' on Account.{{field}}__c.",
      "Zap that pushes new tickets to our spreadsheet hasn't run since {{date}}.",
      "Hubspot integration only pulls 5 fields, we need 12.",
      "Native Notion integration ETA?",
    ],
  },
  {
    weight: 9,
    subjects: [
      "Dashboard slow",
      "Reports take forever to load",
      "Page freezes",
      "Search is sluggish",
      "Mobile app laggy",
    ],
    bodies: [
      "Reports tab takes 8-15s to render. Was instant last week.",
      "Whole tab freezes when I scroll fast in the activity view.",
      "Search returns results in {{seconds}}s — used to be subsecond.",
      "Mobile app is unusably slow on iPhone 14, latest iOS.",
      "API p99 latency for /v1/search has tripled per our own metrics.",
    ],
  },
  {
    weight: 9,
    subjects: [
      "BUG: wrong data in filter",
      "BUG: button does nothing",
      "BUG: typo in onboarding email",
      "Visual glitch in modal",
      "Wrong currency shown",
    ],
    bodies: [
      "Assignee filter shows users from another workspace. Repro on staging.",
      "Clicking 'Resend invite' does nothing in Firefox. Console error attached.",
      "Onboarding email says 'Welcom' (sic). Embarrassing for new signups.",
      "Modal close button overlaps with the X icon at <{{px}}px width.",
      "Pricing page shows USD but my account is set to EUR.",
    ],
  },
  {
    weight: 8,
    subjects: [
      "Feature request: dark mode",
      "Bulk edit support",
      "Read-only role",
      "Custom fields on tickets",
      "Audit log export",
    ],
    bodies: [
      "Please add dark mode 🙏",
      "We need bulk edit on the tickets list — clicking one by one is brutal at scale.",
      "Need a read-only role for compliance auditors.",
      "Can we add custom fields per workspace?",
      "Audit log export to S3 would be great for SOC2.",
    ],
  },
  {
    weight: 7,
    subjects: [
      "Webhook signature mismatch",
      "API rate limit unclear",
      "Schema change broke our integration",
      "Pagination cursor invalid",
      "OpenAPI spec out of date",
    ],
    bodies: [
      "Computing HMAC SHA256 of raw body — never matches your X-Signature.",
      "Docs say 100 req/min, but we're seeing 429s at 60 req/min.",
      "The 'status' field changed from string to enum and broke our parser.",
      "Cursor returned by /v1/items?cursor=... yields 'invalid_cursor' on next page.",
      "OpenAPI spec missing the new /v2/exports endpoint.",
    ],
  },
  {
    weight: 6,
    subjects: [
      "GDPR data request",
      "SOC2 report request",
      "DPA signature",
      "Data residency question",
      "Subprocessor list",
    ],
    bodies: [
      "Article 15 GDPR — please export all personal data tied to my account.",
      "Need your latest SOC2 Type 2 report for our security review.",
      "Where can I sign your DPA?",
      "Can data be pinned to EU region only?",
      "Can you share the current subprocessor list?",
    ],
  },
  {
    weight: 4,
    subjects: [
      "P0: production outage",
      "URGENT: data missing",
      "Critical: writes failing",
      "Security: suspected breach",
      "P0: dashboard showing wrong customer's data",
    ],
    bodies: [
      "All POST /v1/items returning 503 since {{time}}. Customer-facing impact.",
      "~40% of our records disappeared overnight. Last good sync at {{time}}.",
      "Every write is failing with 'workspace not found' — auth checks out.",
      "Saw a login from an IP I don't recognize. Need to lock account immediately.",
      "When I log in I'm seeing another customer's tickets. This is a data leak.",
    ],
  },
  {
    weight: 3,
    subjects: [
      "Thanks!",
      "Loving the product",
      "Quick compliment",
      "Feedback after demo",
      "Excited for v3",
    ],
    bodies: [
      "Just wanted to say the team is excited. Keep up the great work!",
      "Onboarding was the smoothest I've seen for a B2B tool.",
      "Tell your engineers the new dashboard is gorgeous.",
      "Demo went well — we're moving forward with procurement.",
      "Looking forward to the v3 release!",
    ],
  },
];

const totalWeight = TEMPLATES.reduce((s, t) => s + t.weight, 0);

function pickTemplate(): Template {
  let r = rand() * totalWeight;
  for (const t of TEMPLATES) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return TEMPLATES[TEMPLATES.length - 1];
}

function fill(s: string): string {
  return s
    .replace(/{{amount}}/g, `$${(50 + Math.floor(rand() * 950)).toString()}`)
    .replace(/{{date}}/g, `Nov ${1 + Math.floor(rand() * 28)}`)
    .replace(/{{month}}/g, pick(["September", "October", "November"]))
    .replace(/{{inv}}/g, `INV-${10000 + Math.floor(rand() * 89999)}`)
    .replace(/{{code}}/g, String(100 + Math.floor(rand() * 899)))
    .replace(/{{count}}/g, String(2 + Math.floor(rand() * 50)))
    .replace(/{{step}}/g, String(1 + Math.floor(rand() * 8)))
    .replace(/{{time}}/g, `${Math.floor(rand() * 24)}:${String(Math.floor(rand() * 60)).padStart(2, "0")} UTC`)
    .replace(/{{field}}/g, pick(["Region", "Owner", "Stage", "Source", "Plan"]))
    .replace(/{{seconds}}/g, String(2 + Math.floor(rand() * 12)))
    .replace(/{{px}}/g, String(320 + Math.floor(rand() * 480)));
}

const tickets: Ticket[] = [];
for (let i = 0; i < COUNT; i++) {
  const tpl = pickTemplate();
  const subject = fill(pick(tpl.subjects));
  const body = fill(pick(tpl.bodies));
  const tier = pick(TIERS) ?? "pro";
  tickets.push({
    id: `S-${(i + 1).toString().padStart(4, "0")}`,
    subject,
    body,
    customer_tier: tier,
  });
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(tickets, null, 2) + "\n");
console.log(`Wrote ${tickets.length} tickets → ${OUT_PATH}`);
