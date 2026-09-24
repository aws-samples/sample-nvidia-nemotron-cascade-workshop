import { triageTicketWithUsage } from "../bedrock/client";
import { GATEWAY_MODELS, JEV_PRICING_SNAPSHOT, MODELS, estimateModelCostUsd } from "../bedrock/models";
import { RoutingDecisionSchema, TicketSchema, type RoutingDecision, type Ticket } from "../triage/schema";
import { JevRequestError } from "../jev/client";
import { triageWithJev, type JevTriageResult } from "../jev/triage";
import { shouldEscalate } from "./escalation";

// Frozen before the first comparative run; demonstration policy, not tuned.
export const THREE_TIER_POLICY = {
  version: "jev-nano-sonnet-v1",
  jevMinimumFieldConfidence: 0.8,
  nanoConfidenceThreshold: 0.7,
  highRisk: "P0/P1 or needs_human skips directly to Sonnet",
  finalDecision: "last model wins; review_required separately preserves earlier human-review signals",
} as const;

export function requiresStrongReview(decision: RoutingDecision): boolean {
  return decision.priority === "P0" || decision.priority === "P1" || decision.needs_human;
}

export function nextAfterJev(decision: RoutingDecision): "accept" | "nano" | "sonnet" {
  if (requiresStrongReview(decision)) return "sonnet";
  return decision.confidence < THREE_TIER_POLICY.jevMinimumFieldConfidence ? "nano" : "accept";
}

export interface TriageStage {
  stage: "jev" | "nano" | "sonnet";
  model: string;
  status: "completed" | "unavailable";
  decision: RoutingDecision | null;
  latency_ms: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  estimated_market_cost_usd: number | null;
  gateway_reported_cost_usd?: number | null;
  confidence_by_field?: JevTriageResult["confidenceByField"];
  attempts?: number;
  error?: string;
}

export function jevStage(result: JevTriageResult): TriageStage {
  return {
    stage: "jev",
    model: result.response.model,
    status: "completed",
    decision: result.decision,
    latency_ms: result.latencyMs,
    usage: result.response.usage,
    estimated_market_cost_usd: result.gatewayMarketCostUsd ??
      (result.response.usage.inputTokens / 1_000_000) * JEV_PRICING_SNAPSHOT.inputUsdPerMillionTokens,
    gateway_reported_cost_usd: result.gatewayReportedCostUsd,
    confidence_by_field: result.confidenceByField,
    attempts: result.attempts,
  };
}

export function finishThreeTier(stages: TriageStage[], totalLatencyMs: number) {
  const final = stages.at(-1);
  if (!final?.decision) throw new Error("No valid final triage decision.");
  const completeCost = stages.every((s) => s.estimated_market_cost_usd !== null && (s.attempts ?? 1) === 1);
  return {
    schema_version: "three-tier-triage-v1",
    policy: THREE_TIER_POLICY,
    decision: final.decision,
    final_model: final.model,
    route: stages.map((s) => s.stage).join("→"),
    review_required: stages.some((s) => s.decision && requiresStrongReview(s.decision)),
    escalated: stages.length > 1,
    total_latency_ms: totalLatencyMs,
    estimated_market_cost_usd: completeCost
      ? stages.reduce((sum, s) => sum + s.estimated_market_cost_usd!, 0)
      : null,
    known_market_cost_usd: stages.reduce((sum, s) => sum + (s.estimated_market_cost_usd ?? 0), 0),
    cost_complete: completeCost,
    stages,
  };
}

export async function triageThreeTier(
  input: Ticket,
  options: {
    apiKey?: string;
    signal?: AbortSignal;
    onStage?: (stage: TriageStage) => void;
    jev?: typeof triageWithJev;
    bedrock?: typeof triageTicketWithUsage;
  } = {},
) {
  const ticket = TicketSchema.parse(input);
  if (ticket.subject.length + ticket.body.length > 30_000) {
    throw new Error("Ticket subject and body must total at most 30000 characters.");
  }
  const started = performance.now();
  const deadline = AbortSignal.timeout(60_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const stages: TriageStage[] = [];
  const emit = (stage: TriageStage) => {
    stages.push(stage);
    options.onStage?.(stage);
  };
  const runBedrock = async (stage: "nano" | "sonnet") => {
    signal.throwIfAborted();
    const model = stage === "nano" ? MODELS.NEMOTRON_NANO : MODELS.CLAUDE_SONNET;
    const start = performance.now();
    const result = await (options.bedrock ?? triageTicketWithUsage)(ticket, { modelId: model, signal });
    const decision = RoutingDecisionSchema.parse(result.decision);
    if (decision.ticket_id !== ticket.id) throw new Error("Model returned a mismatched ticket ID.");
    emit({
      stage, model, status: "completed", decision,
      latency_ms: Math.round(performance.now() - start),
      usage: result.usage,
      estimated_market_cost_usd: result.usage ? estimateModelCostUsd(model, result.usage) : null,
    });
    return decision;
  };
  let next: "accept" | "nano" | "sonnet";
  try {
    signal.throwIfAborted();
    const result = await (options.jev ?? triageWithJev)(ticket, { apiKey: options.apiKey, signal });
    emit(jevStage(result));
    next = nextAfterJev(result.decision);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (!(error instanceof JevRequestError) || !error.retryable) throw error;
    emit({
      stage: "jev", model: GATEWAY_MODELS.JEV, status: "unavailable", decision: null,
      latency_ms: error.latencyMs, attempts: error.attempts, usage: null,
      estimated_market_cost_usd: null, error: error.message,
    });
    next = "nano";
  }
  if (next === "nano") {
    const nano = await runBedrock("nano");
    if (shouldEscalate(nano)) await runBedrock("sonnet");
  } else if (next === "sonnet") {
    await runBedrock("sonnet");
  }
  return finishThreeTier(stages, Math.round(performance.now() - started));
}
