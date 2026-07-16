import type { RoutingDecision } from "../triage/schema";

/**
 * Shared escalation logic for the triage cascade.
 *
 * Three layers, ordered cheapest-first:
 *
 * 1. Confidence-based: the primary model explicitly says it's unsure.
 * 2. Stakes-based: the answer matters too much to take the primary model's
 *    word for it (P0/P1 outage, needs_human flag, or abuse category).
 * 3. Category-based (domain-tuned, optional): the primary model picked a
 *    category that historical disagreements with the judge showed it
 *    confuses with adjacent categories. Production teams replace this
 *    hardcoded list with a learned router trained on their own
 *    historical disagreements.
 */
export interface EscalationOptions {
  /** Escalate when self-reported confidence is below this. Default 0.7. */
  confidenceThreshold?: number;
  /** Escalate when the predicted category is in this set. Default: none. */
  highDisagreementCategories?: ReadonlySet<string>;
  /** Escalate on the abuse category. Default false. */
  escalateOnAbuse?: boolean;
}

/**
 * High-disagreement set for B2B support triage, derived from bake-off
 * disagreements with the Opus judge:
 *   - integration ↔ feature_request ("When will Notion sync land?")
 *   - bug_report ↔ billing/performance ("double-charged" vs "wrong
 *     amount in invoice")
 */
export const TRIAGE_HIGH_DISAGREEMENT_CATEGORIES: ReadonlySet<string> =
  new Set(["integration", "feature_request", "bug_report", "performance"]);

export function shouldEscalate(
  decision: RoutingDecision,
  opts: EscalationOptions = {},
): boolean {
  const threshold = opts.confidenceThreshold ?? 0.7;
  return (
    decision.confidence < threshold ||
    decision.priority === "P0" ||
    decision.priority === "P1" ||
    decision.needs_human === true ||
    (opts.escalateOnAbuse === true && decision.category === "abuse") ||
    (opts.highDisagreementCategories?.has(decision.category) ?? false)
  );
}
