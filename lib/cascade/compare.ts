import { shouldEscalate } from "./escalation";
import { nextAfterJev, requiresStrongReview, type TriageStage } from "./three-tier";
import type { RoutingDecision } from "../triage/schema";

export const STRATEGIES = ["sonnet", "nano", "jev", "nano-sonnet", "jev-sonnet", "jev-nano-sonnet"] as const;
export type Strategy = typeof STRATEGIES[number];

// Counterfactual replay only: no network calls and no feedback between models.
export function composeStrategy(
  strategy: Strategy,
  results: Record<"jev" | "nano" | "sonnet", TriageStage>,
) {
  let selected: TriageStage[];
  if (strategy === "sonnet" || strategy === "nano" || strategy === "jev") {
    selected = [results[strategy]];
  } else if (strategy === "nano-sonnet") {
    selected = shouldEscalate(results.nano.decision!) ? [results.nano, results.sonnet] : [results.nano];
  } else {
    const next = nextAfterJev(results.jev.decision!);
    selected = [results.jev];
    if (next === "sonnet" || (next === "nano" && strategy === "jev-sonnet")) {
      selected.push(results.sonnet);
    } else if (next === "nano") {
      selected.push(results.nano);
      if (shouldEscalate(results.nano.decision!)) selected.push(results.sonnet);
    }
  }
  if (selected.some((s) => s.status !== "completed" || !s.decision)) {
    throw new Error("Replay requires complete, valid model results.");
  }
  return {
    decision: selected.at(-1)!.decision as RoutingDecision,
    route: selected.map((s) => s.stage).join("→"),
    calls: selected.map((s) => s.stage),
    review_required: selected.some((s) => requiresStrongReview(s.decision!)),
    estimated_latency_ms: selected.reduce((sum, s) => sum + s.latency_ms, 0),
    estimated_market_cost_usd: selected.every((s) => s.estimated_market_cost_usd !== null && (s.attempts ?? 1) === 1)
      ? selected.reduce((sum, s) => sum + s.estimated_market_cost_usd!, 0)
      : null,
  };
}
