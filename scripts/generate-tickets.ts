#!/usr/bin/env tsx
/**
 * Generate deterministic 1,000-ticket bake-off datasets.
 *
 * `production` is the safe default bake-off profile: repetitive routine
 * traffic with a small ambiguous and high-risk tail. `stress` preserves the
 * original synthetic-1k boundary-heavy profile for regression comparisons.
 *
 * Usage:
 *   npm run generate-tickets
 *   npm run generate-tickets -- --dataset=production
 *   npm run generate-tickets -- --dataset=stress
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  NEEDS_HUMAN_RUBRIC,
  NEEDS_HUMAN_RUBRIC_VERSION,
  type SourceIntentLabel,
  type Ticket,
  type TicketCategory,
  type TicketPriority,
} from "../lib/triage/schema";

export const DATASET_OUTPUTS = {
  production: "data/production-shaped-1k.json",
  stress: "data/synthetic-1k.json",
} as const;
export const PRODUCTION_SOURCE_INTENT_OUTPUT =
  "data/production-shaped-1k.source-intent.json";
export const PRODUCTION_METADATA_OUTPUT =
  "data/production-shaped-1k.metadata.json";
export const PRODUCTION_REVIEW_WORKSHEET_OUTPUT =
  "data/production-shaped-1k.test-review-worksheet.json";
export const PRODUCTION_HUMAN_REVIEW_OVERRIDE_PATH =
  "data/production-shaped-1k.human-review-overrides.json";
export const PRODUCTION_DATASET_VERSION = "production-shaped-v4";

export type GeneratedDatasetName = keyof typeof DATASET_OUTPUTS;

const COUNT = 1000;
const STRESS_SEED = 42;
const PRODUCTION_SEED = 20260811;
const TIERS: Ticket["customer_tier"][] = ["free", "pro", "enterprise"];

interface Template {
  weight: number;
  subjects: string[];
  bodies: string[];
}

interface ScenarioVariant {
  subject: string;
  body: string;
}

interface ScenarioFamily {
  family: string;
  split: SourceIntentLabel["split"];
  cohort: SourceIntentLabel["cohort"];
  intendedCategory: TicketCategory;
  intendedPriority: TicketPriority;
  intendedNeedsHuman: boolean;
  variants: readonly ScenarioVariant[];
}

interface GeneratedExample {
  ticket: Omit<Ticket, "id">;
  label: Omit<SourceIntentLabel, "ticket_id">;
}

export interface ProductionDatasetMetadata {
  dataset_version: string;
  seed: number;
  total_tickets: number;
  cohort_counts: Record<SourceIntentLabel["cohort"], number>;
  split_counts: Record<SourceIntentLabel["split"], number>;
  workshop_default_count: number;
  review_status: SourceIntentLabel["review_status"];
  source_intent_note: string;
  needs_human_rubric_version: string;
  review_worksheet_path: string;
  human_review_override_path: string;
  family_assignments: Array<{
    scenario_family: string;
    split: SourceIntentLabel["split"];
    cohort: SourceIntentLabel["cohort"];
    intended_category: TicketCategory;
    intended_priority: TicketPriority;
    intended_needs_human: boolean;
  }>;
}

export interface LockedTestReviewWorksheet {
  schema_version: "human-review-worksheet-v1";
  dataset_version: string;
  dataset_sha256: string;
  source_intent_sha256: string;
  locked_test_ticket_ids_sha256: string;
  needs_human_rubric_version: string;
  needs_human_rubric: string;
  instructions: string[];
  items: Array<{
    ticket: Ticket;
    review_template: {
      category: null;
      priority: null;
      needs_human: null;
      review_status: null;
      reviewer: null;
      reviewed_at: null;
      notes: null;
    };
  }>;
}

export interface GeneratedProductionDataset {
  tickets: Ticket[];
  sourceIntentLabels: SourceIntentLabel[];
  metadata: ProductionDatasetMetadata;
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value =
      (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function picker(random: () => number) {
  return <T>(values: readonly T[]): T =>
    values[Math.floor(random() * values.length)];
}

function fill(
  value: string,
  random: () => number,
  pick: <T>(values: readonly T[]) => T,
): string {
  return value
    .replace(/{{amount}}/g, `$${50 + Math.floor(random() * 950)}`)
    .replace(/{{date}}/g, `Nov ${1 + Math.floor(random() * 28)}`)
    .replace(/{{month}}/g, pick(["September", "October", "November"]))
    .replace(/{{inv}}/g, `INV-${10000 + Math.floor(random() * 89999)}`)
    .replace(/{{code}}/g, String(100 + Math.floor(random() * 899)))
    .replace(/{{count}}/g, String(2 + Math.floor(random() * 50)))
    .replace(/{{step}}/g, String(1 + Math.floor(random() * 8)))
    .replace(
      /{{time}}/g,
      `${Math.floor(random() * 24)}:${String(Math.floor(random() * 60)).padStart(2, "0")} UTC`,
    )
    .replace(/{{field}}/g, pick(["Region", "Owner", "Stage", "Source", "Plan"]))
    .replace(/{{seconds}}/g, String(2 + Math.floor(random() * 12)))
    .replace(/{{px}}/g, String(320 + Math.floor(random() * 480)));
}

const STRESS_TEMPLATES: Template[] = [
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

const PRODUCTION_SCENARIO_FAMILIES: readonly ScenarioFamily[] = [
  {
    family: "calibration_invoice_copy",
    split: "calibration",
    cohort: "routine",
    intendedCategory: "billing",
    intendedPriority: "P3",
    intendedNeedsHuman: false,
    variants: [
      { subject: "Invoice copy", body: "Please send invoice {{inv}} to our accounting team." },
      { subject: "Billing contact change", body: "Please update the billing contact before our {{month}} invoice." },
    ],
  },
  {
    family: "calibration_auth_enrollment",
    split: "calibration",
    cohort: "routine",
    intendedCategory: "auth",
    intendedPriority: "P2",
    intendedNeedsHuman: false,
    variants: [
      { subject: "MFA setup help", body: "Where do I enroll a new authenticator app for my account?" },
      { subject: "Invite a teammate", body: "How do I invite another user to our workspace?" },
    ],
  },
  {
    family: "calibration_webhook_setup",
    split: "calibration",
    cohort: "routine",
    intendedCategory: "integration",
    intendedPriority: "P3",
    intendedNeedsHuman: false,
    variants: [
      { subject: "Webhook setup question", body: "Which settings page is used to add a webhook endpoint?" },
      { subject: "Find API key", body: "Where can an admin create an API key for our integration?" },
    ],
  },
  {
    family: "calibration_feature_admin",
    split: "calibration",
    cohort: "routine",
    intendedCategory: "feature_request",
    intendedPriority: "P3",
    intendedNeedsHuman: false,
    variants: [
      { subject: "Dark mode request", body: "Please add dark mode to the dashboard." },
      { subject: "Custom field request", body: "Can admins define an additional custom field on tickets?" },
    ],
  },
  {
    family: "calibration_renewal_entitlement",
    split: "calibration",
    cohort: "ambiguous",
    intendedCategory: "billing",
    intendedPriority: "P2",
    intendedNeedsHuman: true,
    variants: [
      { subject: "Access changed after renewal", body: "A teammate lost export access immediately after our renewal, and we cannot tell whether the plan applied correctly." },
      { subject: "Plan change did not work", body: "We changed plans and the included export feature is still unavailable. Please verify the subscription state." },
    ],
  },
  {
    family: "calibration_intermittent_connector",
    split: "calibration",
    cohort: "ambiguous",
    intendedCategory: "integration",
    intendedPriority: "P2",
    intendedNeedsHuman: true,
    variants: [
      { subject: "Integration stops intermittently", body: "Our Salesforce sync occasionally stops without an error, but a manual retry usually completes." },
      { subject: "Connector records look stale", body: "Some Slack-linked records remain stale after sync and we cannot identify when the behavior began." },
    ],
  },
  {
    family: "calibration_cross_tenant_exposure",
    split: "calibration",
    cohort: "high_risk",
    intendedCategory: "abuse",
    intendedPriority: "P0",
    intendedNeedsHuman: true,
    variants: [
      { subject: "Customer data visible across accounts", body: "An agent can see another customer's ticket content. Please contain this cross-account data exposure." },
      { subject: "Wrong customer's records displayed", body: "Our dashboard is showing records that belong to a different company." },
    ],
  },
  {
    family: "test_payment_method",
    split: "test",
    cohort: "routine",
    intendedCategory: "billing",
    intendedPriority: "P3",
    intendedNeedsHuman: false,
    variants: [
      { subject: "Update payment method", body: "Where can I replace the card used for our subscription?" },
      { subject: "Card expires soon", body: "Our subscription card expires this month; where should an admin update it?" },
    ],
  },
  {
    family: "test_password_reset",
    split: "test",
    cohort: "routine",
    intendedCategory: "auth",
    intendedPriority: "P3",
    intendedNeedsHuman: false,
    variants: [
      { subject: "Password reset", body: "Where can I request a new password reset link after the previous link expired?" },
      { subject: "Expired reset link", body: "Which self-service page lets me generate a fresh password reset link?" },
    ],
  },
  {
    family: "test_export_guidance",
    split: "test",
    cohort: "routine",
    intendedCategory: "integration",
    intendedPriority: "P3",
    intendedNeedsHuman: false,
    variants: [
      { subject: "Export tickets", body: "Where is the CSV export in the current dashboard?" },
      { subject: "API pagination guide", body: "Which documentation explains how to paginate through the tickets API?" },
    ],
  },
  {
    family: "test_connector_mapping",
    split: "test",
    cohort: "routine",
    intendedCategory: "integration",
    intendedPriority: "P3",
    intendedNeedsHuman: false,
    variants: [
      { subject: "Salesforce field mapping", body: "Where can I map the Salesforce {{field}} field?" },
      { subject: "Reconnect Slack", body: "How do I reconnect our Slack workspace after an admin changed?" },
    ],
  },
  {
    family: "test_bulk_edit_feature",
    split: "test",
    cohort: "routine",
    intendedCategory: "feature_request",
    intendedPriority: "P3",
    intendedNeedsHuman: false,
    variants: [
      { subject: "Bulk edit request", body: "We would like to edit several tickets at once instead of opening each ticket." },
      { subject: "Read-only role request", body: "The product does not currently offer a read-only role for compliance reviewers. Please add this capability." },
    ],
  },
  {
    family: "test_report_performance",
    split: "test",
    cohort: "routine",
    intendedCategory: "performance",
    intendedPriority: "P2",
    intendedNeedsHuman: false,
    variants: [
      { subject: "Reports load slowly", body: "The weekly report takes about {{seconds}} seconds to open but eventually completes." },
      { subject: "Search is sluggish", body: "Ticket search is noticeably slower today, although results still load." },
    ],
  },
  {
    family: "test_api_contract_ambiguity",
    split: "test",
    cohort: "ambiguous",
    intendedCategory: "integration",
    intendedPriority: "P2",
    intendedNeedsHuman: true,
    variants: [
      { subject: "API behavior changed", body: "Our API workflow behaves differently today, but the documentation is also unclear about the expected response." },
      { subject: "Unexpected webhook response", body: "Webhook retries changed and we cannot determine whether this is a product issue or an undocumented contract." },
    ],
  },
  {
    family: "test_intermittent_product_behavior",
    split: "test",
    cohort: "ambiguous",
    intendedCategory: "bug_report",
    intendedPriority: "P2",
    intendedNeedsHuman: true,
    variants: [
      { subject: "Customer reports odd behavior", body: "A customer reports that ticket status sometimes changes back, but they did not include reliable reproduction steps." },
      { subject: "Dashboard changed unexpectedly", body: "The dashboard occasionally hides a saved filter and we are unsure whether the new behavior is intended." },
    ],
  },
  {
    family: "test_production_outage",
    split: "test",
    cohort: "high_risk",
    intendedCategory: "bug_report",
    intendedPriority: "P0",
    intendedNeedsHuman: true,
    variants: [
      { subject: "Production unavailable", body: "All production requests have returned 503 since {{time}} and customers cannot work." },
    ],
  },
  {
    family: "test_single_workspace_write_failure",
    split: "test",
    cohort: "high_risk",
    intendedCategory: "bug_report",
    intendedPriority: "P1",
    intendedNeedsHuman: true,
    variants: [
      { subject: "Writes failing in production", body: "Every write is failing for one production workspace with no available workaround." },
    ],
  },
  {
    family: "test_account_takeover",
    split: "test",
    cohort: "high_risk",
    intendedCategory: "abuse",
    intendedPriority: "P0",
    intendedNeedsHuman: true,
    variants: [
      { subject: "Possible account takeover", body: "We see an unrecognized administrator login and unexpected permission changes on the account." },
      { subject: "Suspicious administrator activity", body: "An unknown admin disabled MFA and created an API key. Please secure the account immediately." },
    ],
  },
  {
    family: "reserve_subscription_admin",
    split: "reserve",
    cohort: "routine",
    intendedCategory: "billing",
    intendedPriority: "P3",
    intendedNeedsHuman: false,
    variants: [
      { subject: "Subscription invoice question", body: "Can you explain the {{month}} invoice line item for our subscription?" },
      { subject: "Tax form request", body: "Please send the tax form our accounting team needs for vendor setup." },
    ],
  },
  {
    family: "reserve_workspace_access",
    split: "reserve",
    cohort: "routine",
    intendedCategory: "auth",
    intendedPriority: "P2",
    intendedNeedsHuman: false,
    variants: [
      { subject: "Workspace access help", body: "A new teammate needs a fresh invitation to our workspace." },
      { subject: "Authenticator replacement", body: "I replaced my phone and need instructions to enroll a new authenticator." },
    ],
  },
  {
    family: "reserve_integration_guidance",
    split: "reserve",
    cohort: "routine",
    intendedCategory: "integration",
    intendedPriority: "P3",
    intendedNeedsHuman: false,
    variants: [
      { subject: "Zapier connection guide", body: "Please point me to the guide for connecting a Zapier account." },
      { subject: "Webhook secret rotation", body: "What is the documented process for rotating a webhook secret?" },
    ],
  },
  {
    family: "reserve_product_request",
    split: "reserve",
    cohort: "routine",
    intendedCategory: "feature_request",
    intendedPriority: "P3",
    intendedNeedsHuman: false,
    variants: [
      { subject: "Audit export request", body: "Please add scheduled audit-log export to object storage." },
      { subject: "Saved view request", body: "We would like admins to publish a saved ticket view to the whole workspace." },
    ],
  },
  {
    family: "reserve_unclear_degradation",
    split: "reserve",
    cohort: "ambiguous",
    intendedCategory: "performance",
    intendedPriority: "P2",
    intendedNeedsHuman: true,
    variants: [
      { subject: "Something became slower", body: "The dashboard sometimes pauses during a customer demo, but refreshing provides a temporary workaround." },
      { subject: "Intermittent delay", body: "A few users report delays with no timestamp or repeatable steps." },
    ],
  },
  {
    family: "reserve_data_loss_incident",
    split: "reserve",
    cohort: "high_risk",
    intendedCategory: "bug_report",
    intendedPriority: "P0",
    intendedNeedsHuman: true,
    variants: [
      { subject: "Production records missing", body: "A large set of production records disappeared overnight and no backup is visible in the workspace." },
      { subject: "Critical data loss", body: "Recently saved customer records are gone across multiple projects." },
    ],
  },
];

const SPLIT_COHORT_TARGETS: Record<
  SourceIntentLabel["split"],
  Record<SourceIntentLabel["cohort"], number>
> = {
  calibration: { routine: 42, ambiguous: 5, high_risk: 3 },
  test: { routine: 128, ambiguous: 15, high_risk: 7 },
  reserve: { routine: 680, ambiguous: 80, high_risk: 40 },
};

const WORKSHOP_COHORT_TARGETS: Record<SourceIntentLabel["cohort"], number> = {
  routine: 25,
  ambiguous: 3,
  high_risk: 2,
};

export function generateStressTickets(): Ticket[] {
  const random = mulberry32(STRESS_SEED);
  const pick = picker(random);
  const totalWeight = STRESS_TEMPLATES.reduce(
    (sum, template) => sum + template.weight,
    0,
  );
  const pickTemplate = () => {
    let remaining = random() * totalWeight;
    for (const template of STRESS_TEMPLATES) {
      remaining -= template.weight;
      if (remaining <= 0) return template;
    }
    return STRESS_TEMPLATES[STRESS_TEMPLATES.length - 1];
  };

  return Array.from({ length: COUNT }, (_, index) => {
    const template = pickTemplate();
    return {
      id: `S-${(index + 1).toString().padStart(4, "0")}`,
      subject: fill(pick(template.subjects), random, pick),
      body: fill(pick(template.bodies), random, pick),
      customer_tier: pick(TIERS) ?? "pro",
    };
  });
}

function scenarioExample(
  family: ScenarioFamily,
  random: () => number,
  pick: <T>(values: readonly T[]) => T,
  workshopDefault: boolean,
): GeneratedExample {
  const variant = pick(family.variants);
  return {
    ticket: {
      subject: fill(variant.subject, random, pick),
      body: fill(variant.body, random, pick),
      customer_tier: pick(TIERS) ?? "pro",
    },
    label: {
      cohort: family.cohort,
      scenario_family: family.family,
      intended_category: family.intendedCategory,
      intended_priority: family.intendedPriority,
      intended_needs_human: family.intendedNeedsHuman,
      split: family.split,
      workshop_default: workshopDefault,
      review_status: "unreviewed",
    },
  };
}

function generateCohortBatch(
  split: SourceIntentLabel["split"],
  targets: Record<SourceIntentLabel["cohort"], number>,
  random: () => number,
  pick: <T>(values: readonly T[]) => T,
  workshopDefault: boolean,
): GeneratedExample[] {
  const examples: GeneratedExample[] = [];
  for (const cohort of ["routine", "ambiguous", "high_risk"] as const) {
    const families = PRODUCTION_SCENARIO_FAMILIES.filter(
      (family) => family.split === split && family.cohort === cohort,
    );
    if (families.length === 0) {
      throw new Error(`No scenario families for ${split}/${cohort}.`);
    }
    for (let index = 0; index < targets[cohort]; index++) {
      examples.push(
        scenarioExample(pick(families), random, pick, workshopDefault),
      );
    }
  }
  for (let index = examples.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [examples[index], examples[swapIndex]] = [
      examples[swapIndex],
      examples[index],
    ];
  }
  return examples;
}

export function generateProductionDataset(): GeneratedProductionDataset {
  const random = mulberry32(PRODUCTION_SEED);
  const pick = picker(random);
  const calibrationRemainder = {
    routine:
      SPLIT_COHORT_TARGETS.calibration.routine -
      WORKSHOP_COHORT_TARGETS.routine,
    ambiguous:
      SPLIT_COHORT_TARGETS.calibration.ambiguous -
      WORKSHOP_COHORT_TARGETS.ambiguous,
    high_risk:
      SPLIT_COHORT_TARGETS.calibration.high_risk -
      WORKSHOP_COHORT_TARGETS.high_risk,
  };
  const examples = [
    ...generateCohortBatch(
      "calibration",
      WORKSHOP_COHORT_TARGETS,
      random,
      pick,
      true,
    ),
    ...generateCohortBatch(
      "calibration",
      calibrationRemainder,
      random,
      pick,
      false,
    ),
    ...generateCohortBatch(
      "test",
      SPLIT_COHORT_TARGETS.test,
      random,
      pick,
      false,
    ),
    ...generateCohortBatch(
      "reserve",
      SPLIT_COHORT_TARGETS.reserve,
      random,
      pick,
      false,
    ),
  ];
  const tickets = examples.map((example, index) => ({
    id: `P-${(index + 1).toString().padStart(4, "0")}`,
    ...example.ticket,
  }));
  const sourceIntentLabels = examples.map((example, index) => ({
    ticket_id: tickets[index].id,
    ...example.label,
  }));
  const metadata: ProductionDatasetMetadata = {
    dataset_version: PRODUCTION_DATASET_VERSION,
    seed: PRODUCTION_SEED,
    total_tickets: tickets.length,
    cohort_counts: { routine: 850, ambiguous: 100, high_risk: 50 },
    split_counts: { calibration: 50, test: 150, reserve: 800 },
    workshop_default_count: 30,
    review_status: "unreviewed",
    source_intent_note:
      "Synthetic source intent is an evaluation reference, not human-adjudicated ground truth.",
    needs_human_rubric_version: NEEDS_HUMAN_RUBRIC_VERSION,
    review_worksheet_path: PRODUCTION_REVIEW_WORKSHEET_OUTPUT,
    human_review_override_path: PRODUCTION_HUMAN_REVIEW_OVERRIDE_PATH,
    family_assignments: PRODUCTION_SCENARIO_FAMILIES.map((family) => ({
      scenario_family: family.family,
      split: family.split,
      cohort: family.cohort,
      intended_category: family.intendedCategory,
      intended_priority: family.intendedPriority,
      intended_needs_human: family.intendedNeedsHuman,
    })),
  };

  return { tickets, sourceIntentLabels, metadata };
}

export function generateProductionTickets(): Ticket[] {
  return generateProductionDataset().tickets;
}

export function generateLockedTestReviewWorksheet(
  generated = generateProductionDataset(),
): LockedTestReviewWorksheet {
  const datasetJson = `${JSON.stringify(generated.tickets, null, 2)}\n`;
  const sourceIntentJson = `${JSON.stringify(
    generated.sourceIntentLabels,
    null,
    2,
  )}\n`;
  const ticketById = new Map(
    generated.tickets.map((ticket) => [ticket.id, ticket]),
  );
  const testLabels = generated.sourceIntentLabels.filter(
    (label) => label.split === "test",
  );
  return {
    schema_version: "human-review-worksheet-v1",
    dataset_version: PRODUCTION_DATASET_VERSION,
    dataset_sha256: sha256(datasetJson),
    source_intent_sha256: sha256(sourceIntentJson),
    locked_test_ticket_ids_sha256: sha256(
      JSON.stringify(testLabels.map((label) => label.ticket_id)),
    ),
    needs_human_rubric_version: NEEDS_HUMAN_RUBRIC_VERSION,
    needs_human_rubric: NEEDS_HUMAN_RUBRIC,
    instructions: [
      "Review every item independently without consulting the generated source-intent labels during the initial pass.",
      `Record final reviews in ${PRODUCTION_HUMAN_REVIEW_OVERRIDE_PATH}; do not edit the generated source-intent file.`,
      "Each override must include ticket_id, category, priority, needs_human, review_status, reviewer, and reviewed_at.",
      "Use review_status=human_reviewed for one completed review or adjudicated after disagreement resolution.",
      "A locked test live run or --claim-summary remains blocked until all 150 selected labels have overrides.",
    ],
    items: testLabels.map((label) => ({
      ticket: ticketById.get(label.ticket_id)!,
      review_template: {
        category: null,
        priority: null,
        needs_human: null,
        review_status: null,
        reviewer: null,
        reviewed_at: null,
        notes: null,
      },
    })),
  };
}

function parseDatasetArg(argv: string[]): GeneratedDatasetName | "all" {
  const raw =
    argv.find((arg) => arg.startsWith("--dataset="))?.split("=")[1] ??
    "production";
  if (raw === "production" || raw === "stress" || raw === "all") return raw;
  throw new Error(
    `Unknown dataset "${raw}". Use --dataset=production, --dataset=stress, or --dataset=all.`,
  );
}

function writeDataset(name: GeneratedDatasetName, tickets: Ticket[]) {
  const outputPath = DATASET_OUTPUTS[name];
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(tickets, null, 2)}\n`);
  console.log(`Wrote ${tickets.length} ${name} tickets → ${outputPath}`);
}

function writeProductionDataset() {
  const generated = generateProductionDataset();
  const worksheet = generateLockedTestReviewWorksheet(generated);
  writeDataset("production", generated.tickets);
  writeFileSync(
    PRODUCTION_SOURCE_INTENT_OUTPUT,
    `${JSON.stringify(generated.sourceIntentLabels, null, 2)}\n`,
  );
  writeFileSync(
    PRODUCTION_METADATA_OUTPUT,
    `${JSON.stringify(generated.metadata, null, 2)}\n`,
  );
  writeFileSync(
    PRODUCTION_REVIEW_WORKSHEET_OUTPUT,
    `${JSON.stringify(worksheet, null, 2)}\n`,
  );
  console.log(
    `Wrote ${generated.sourceIntentLabels.length} source-intent labels → ${PRODUCTION_SOURCE_INTENT_OUTPUT}`,
  );
  console.log(`Wrote production metadata → ${PRODUCTION_METADATA_OUTPUT}`);
  console.log(
    `Wrote locked-test review worksheet → ${PRODUCTION_REVIEW_WORKSHEET_OUTPUT}`,
  );
  console.log(
    `${existsSync(PRODUCTION_HUMAN_REVIEW_OVERRIDE_PATH) ? "Preserved" : "Did not create"} reviewer-authored overrides → ${PRODUCTION_HUMAN_REVIEW_OVERRIDE_PATH}`,
  );
}

export function main(argv = process.argv.slice(2)) {
  const dataset = parseDatasetArg(argv);
  if (dataset === "all" || dataset === "production") {
    writeProductionDataset();
  }
  if (dataset === "all" || dataset === "stress") {
    writeDataset("stress", generateStressTickets());
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
