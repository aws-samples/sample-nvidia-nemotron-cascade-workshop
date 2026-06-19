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

export const TICKET_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

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
