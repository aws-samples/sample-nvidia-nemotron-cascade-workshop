import type { RoutingDecision } from "../triage/schema";

/**
 * Shared escalation logic for the triage cascade.
 *
 * The canonical workshop policy escalates on low confidence, P0/P1 priority,
 * or `needs_human`. Optional category and abuse rules are caller-supplied
 * extensions and must come from independent calibration evidence or domain
 * policy, never from the final evaluation set.
 */
export interface EscalationOptions {
  /** Escalate when self-reported confidence is below this. Default 0.7. */
  confidenceThreshold?: number;
  /** Escalate when the predicted category is in this set. Default: none. */
  highDisagreementCategories?: ReadonlySet<string>;
  /** Escalate on the abuse category. Default false. */
  escalateOnAbuse?: boolean;
}

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
