import { z } from "zod";

/**
 * Categories the triage model is allowed to assign.
 * Kept short and finite — every B2B SaaS support stack reduces to a small set.
 */
export const TICKET_CATEGORIES = [
  "billing",
  "auth",
  "integration",
  "performance",
  "bug_report",
  "feature_request",
  "abuse",
  "other",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TRIAGE_TAXONOMY_VERSION = "triage-taxonomy-v4";
export const NEEDS_HUMAN_RUBRIC_VERSION = "needs-human-rubric-v1";

export const TICKET_CATEGORY_DEFINITIONS: Readonly<
  Record<TicketCategory, string>
> = {
  billing: "Invoices, charges, refunds, subscriptions, and payment methods.",
  auth: "Routine login, password, MFA, SSO, permissions, and account access issues without evidence of compromise.",
  integration: "APIs, webhooks, third-party connectors, imports, exports, and synchronization behavior.",
  performance: "Slow, timing out, freezing, or degraded behavior when the product remains available.",
  bug_report: "Broken or incorrect product behavior, including outages and data-loss symptoms, that is not better classified elsewhere.",
  feature_request: "Requests for new capabilities or intentional product changes.",
  abuse: "Trust-and-safety or security incidents, including suspected compromise, data exposure, malicious activity, spam, or harassment.",
  other: "Requests that do not fit another category, including general feedback and compliance paperwork.",
};

export const TICKET_CATEGORY_PRECEDENCE: readonly TicketCategory[] = [
  "abuse",
  "billing",
  "auth",
  "integration",
  "performance",
  "bug_report",
  "feature_request",
  "other",
];

export const TICKET_PRIORITY_DEFINITIONS: Readonly<
  Record<TicketPriority, string>
> = {
  P0: "Critical active incident: broad outage, data loss/exposure, or suspected account compromise; human review is required.",
  P1: "Urgent material impact with no acceptable workaround, but below P0 scope.",
  P2: "Normal support issue with limited impact or an available workaround.",
  P3: "Low-impact question, administrative request, feedback, or feature request.",
};

export const NEEDS_HUMAN_RUBRIC = [
  `Rubric version: ${NEEDS_HUMAN_RUBRIC_VERSION}`,
  "Set needs_human=true when any of these conditions applies:",
  "1. Priority is P0 or P1. Every P0/P1 decision requires a human.",
  "2. Material ambiguity could change the category, priority, responsible team, entitlement, or safe next action.",
  "3. The requester asks support to execute, reverse, approve, or authorize a consequential account, billing, permission, credential, or production-data action.",
  "4. The requester asks for an exception to policy, contract, compliance, privacy, retention, or security controls.",
  "5. The ticket reports suspected compromise, abuse, data exposure, or data loss.",
  "Set needs_human=false for clear P2/P3 routine requests that can be answered safely without judgment or a consequential action, including how-to questions, documentation links, status questions, invoice-download guidance, admin self-service instructions, and ordinary feature feedback.",
  "A routine request does not become needs_human=true merely because it mentions an account, API key, export, invoice, MFA, or administrator. Distinguish instructions from asking support to perform or approve the action.",
].join("\n");

export const TRIAGE_CLASSIFICATION_GUIDANCE = [
  `Taxonomy version: ${TRIAGE_TAXONOMY_VERSION}`,
  "Category meanings:",
  ...TICKET_CATEGORY_PRECEDENCE.map(
    (category, index) =>
      `${index + 1}. ${category}: ${TICKET_CATEGORY_DEFINITIONS[category]}`,
  ),
  "When multiple categories apply, use the first matching category in that precedence list.",
  "Security incidents map to abuse; routine authentication or access help maps to auth.",
  "Customer tier is context only. Never change category, priority, confidence, or needs_human solely because of customer tier.",
  "Priority meanings:",
  ...TICKET_PRIORITIES.map(
    (priority) => `${priority}: ${TICKET_PRIORITY_DEFINITIONS[priority]}`,
  ),
  "Use P3 for a clear informational or self-service question that can be resolved through routine guidance and reports no failed product behavior or urgent impact. Use P2 when a limited-impact issue remains unresolved after standard guidance, product behavior is failing, or support must troubleshoot beyond routine instructions.",
  "Human-review rubric:",
  NEEDS_HUMAN_RUBRIC,
].join("\n");

export const TicketSchema = z.object({
  id: z.string(),
  subject: z.string(),
  body: z.string(),
  customer_tier: z.enum(["free", "pro", "enterprise"]).optional(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const RoutingDecisionSchema = z.object({
  ticket_id: z.string(),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(2000),
  needs_human: z.boolean(),
});
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

export const SOURCE_INTENT_COHORTS = [
  "routine",
  "ambiguous",
  "high_risk",
] as const;
export const EVALUATION_SPLITS = ["calibration", "test", "reserve"] as const;
export const LABEL_REVIEW_STATUSES = [
  "unreviewed",
  "human_reviewed",
  "adjudicated",
] as const;

export const SourceIntentLabelSchema = z.object({
  ticket_id: z.string(),
  cohort: z.enum(SOURCE_INTENT_COHORTS),
  scenario_family: z.string().min(1),
  intended_category: z.enum(TICKET_CATEGORIES),
  intended_priority: z.enum(TICKET_PRIORITIES),
  intended_needs_human: z.boolean(),
  split: z.enum(EVALUATION_SPLITS),
  workshop_default: z.boolean(),
  review_status: z.enum(LABEL_REVIEW_STATUSES),
});
export type SourceIntentLabel = z.infer<typeof SourceIntentLabelSchema>;

export const REVIEWED_LABEL_STATUSES = [
  "human_reviewed",
  "adjudicated",
] as const;

export const HumanReviewOverrideSchema = z.object({
  ticket_id: z.string(),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES),
  needs_human: z.boolean(),
  review_status: z.enum(REVIEWED_LABEL_STATUSES),
  reviewer: z.string().min(1),
  reviewed_at: z.string().datetime({ offset: true }),
  notes: z.string().optional(),
}).superRefine((review, context) => {
  if (
    (review.priority === "P0" || review.priority === "P1") &&
    !review.needs_human
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["needs_human"],
      message: "P0/P1 reviews must set needs_human=true.",
    });
  }
});
export type HumanReviewOverride = z.infer<typeof HumanReviewOverrideSchema>;

export const HumanReviewOverrideFileSchema = z.object({
  schema_version: z.literal("human-review-overrides-v1"),
  dataset_version: z.string().min(1),
  dataset_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_intent_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  locked_test_ticket_ids_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  reviews: z.array(HumanReviewOverrideSchema),
});
export type HumanReviewOverrideFile = z.infer<
  typeof HumanReviewOverrideFileSchema
>;

export const HumanReviewWorksheetSchema = z.object({
  schema_version: z.literal("human-review-worksheet-v1"),
  dataset_version: z.string().min(1),
  dataset_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_intent_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  locked_test_ticket_ids_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  needs_human_rubric_version: z.string().min(1),
  needs_human_rubric: z.string().min(1),
  instructions: z.array(z.string().min(1)),
  items: z.array(
    z.object({
      ticket: TicketSchema,
      review_template: z.object({
        category: z.null(),
        priority: z.null(),
        needs_human: z.null(),
        review_status: z.null(),
        reviewer: z.null(),
        reviewed_at: z.null(),
        notes: z.null(),
      }),
    }),
  ),
});
export type HumanReviewWorksheet = z.infer<
  typeof HumanReviewWorksheetSchema
>;
