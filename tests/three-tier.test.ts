import { describe, expect, it, vi } from "vitest";
import { evaluateChoices, JevRequestError } from "../lib/jev/client";
import { decisionFromJev, JEV_QUESTIONS, type JevTriageResult } from "../lib/jev/triage";
import { GATEWAY_MODELS, MODELS } from "../lib/bedrock/models";
import { nextAfterJev, triageThreeTier, type TriageStage } from "../lib/cascade/three-tier";
import { composeStrategy } from "../lib/cascade/compare";
import type { RoutingDecision, Ticket } from "../lib/triage/schema";

const ticket: Ticket = { id: "example-1", subject: "Invoice copy", body: "Where can I download an invoice?", customer_tier: "enterprise" };
const decision = (changes: Partial<RoutingDecision> = {}): RoutingDecision => ({
  ticket_id: ticket.id, category: "billing", priority: "P3", confidence: 0.95,
  reasoning: "Invoice download instructions.", needs_human: false, ...changes,
});
const questions = { route: { type: "choice" as const, instructions: "Choose", criteria: { billing: "Billing", other: "Other" } } };
function payload() {
  return {
    model: GATEWAY_MODELS.JEV,
    answers: { route: { type: "choice", choice: "billing", probabilities: { billing: 0.9, other: 0.1 } } },
    usage: { inputTokens: 100, outputTokens: 4 },
    providerMetadata: { typesafe: { confidence: { route: 0.8 } }, gateway: { cost: "0", marketCost: "0.0000042" } },
  };
}
function jevResult(changes: Partial<RoutingDecision> = {}): JevTriageResult {
  const d = decision(changes);
  const choices = { category: d.category, priority: d.priority, needs_human: d.needs_human ? "yes" : "no" };
  const response = {
    model: GATEWAY_MODELS.JEV,
    answers: Object.fromEntries(Object.entries(JEV_QUESTIONS).map(([name, question]) => [name, {
      type: "choice" as const, choice: choices[name as keyof typeof choices],
      probabilities: Object.fromEntries(Object.keys(question.criteria).map((label) => [label, label === choices[name as keyof typeof choices] ? 1 : 0])),
      confidence: d.confidence,
    }])),
    usage: { inputTokens: 500, outputTokens: 50 },
  };
  return { response, latencyMs: 100, attempts: 1, gatewayReportedCostUsd: 0, gatewayMarketCostUsd: 0.000021,
    ...decisionFromJev(ticket.id, { response, latencyMs: 100, attempts: 1, gatewayReportedCostUsd: 0, gatewayMarketCostUsd: 0.000021 }) };
}
const usage = { inputTokens: 100, outputTokens: 30 };
function stage(name: "jev" | "nano" | "sonnet", changes: Partial<RoutingDecision> = {}): TriageStage {
  return { stage: name, model: name, status: "completed", decision: decision(changes), latency_ms: 10, usage, estimated_market_cost_usd: 0.01 };
}

describe("Jev gateway transport", () => {
  it("uses the evaluation endpoint, accepts metadata confidence, and preserves zero cost", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload())));
    const result = await evaluateChoices({}, questions, { apiKey: "test-secret", fetchImpl: request });
    expect(request.mock.calls[0][0]).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
    expect(request.mock.calls[0][1].redirect).toBe("error");
    expect(JSON.parse(request.mock.calls[0][1].body).model).toBe(GATEWAY_MODELS.JEV);
    expect(result.response.answers.route.confidence).toBe(0.8);
    expect(result.gatewayReportedCostUsd).toBe(0);
    expect(result.gatewayMarketCostUsd).toBe(0.0000042);
  });
  it.each(["missing-label", "unknown-winner", "bad-mass", "wrong-winner", "missing-confidence"])("rejects %s", async (kind) => {
    const body = payload();
    if (kind === "missing-label") delete (body.answers.route.probabilities as Partial<typeof body.answers.route.probabilities>).other;
    if (kind === "unknown-winner") body.answers.route.choice = "invented";
    if (kind === "bad-mass") body.answers.route.probabilities.billing = 0.5;
    if (kind === "wrong-winner") body.answers.route.choice = "other";
    if (kind === "missing-confidence") body.providerMetadata.typesafe.confidence = {} as { route: number };
    await expect(evaluateChoices({}, questions, { apiKey: "test", fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify(body))) }))
      .rejects.toMatchObject({ retryable: false, message: "Jev returned an invalid or incomplete evaluation." });
  });
  it("does not retry authentication failures or expose a response body", async () => {
    const request = vi.fn().mockResolvedValue(new Response("private-secret-body", { status: 401 }));
    await expect(evaluateChoices({}, questions, { apiKey: "test-secret", fetchImpl: request }))
      .rejects.toMatchObject({ message: "Jev gateway returned HTTP 401.", retryable: false, attempts: 1 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("bounds HTTP retries and records retry uncertainty", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("retry", { status: 429, headers: { "Retry-After": "0.001" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload())));
    const result = await evaluateChoices({}, questions, { apiKey: "test", fetchImpl: request });
    expect(result.attempts).toBe(2);
  });
  it("propagates caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    const request = vi.fn();
    await expect(evaluateChoices({}, questions, { apiKey: "test", signal: controller.signal, fetchImpl: request })).rejects.toThrow("caller cancelled");
    expect(request).not.toHaveBeenCalled();
  });
  it("stops after two transient HTTP failures", async () => {
    const request = vi.fn().mockImplementation(() => Promise.resolve(
      new Response("unavailable", { status: 503, headers: { "Retry-After": "0.001" } }),
    ));
    await expect(evaluateChoices({}, questions, { apiKey: "test", fetchImpl: request }))
      .rejects.toMatchObject({ retryable: true, attempts: 2, message: "Jev gateway returned HTTP 503." });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("treats a deadline during retry backoff as a transient failure", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response("unavailable", { status: 503, headers: { "Retry-After": "2" } }),
    );
    await expect(evaluateChoices({}, questions, { apiKey: "test", fetchImpl: request, timeoutMs: 10 }))
      .rejects.toMatchObject({ retryable: true, message: "Jev request deadline exceeded." });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("three-tier routing and replay", () => {
  it("accepts a confident routine enterprise ticket without Bedrock", async () => {
    const bedrock = vi.fn();
    const result = await triageThreeTier(ticket, { jev: vi.fn().mockResolvedValue(jevResult()), bedrock });
    expect(result.route).toBe("jev");
    expect(result.review_required).toBe(false);
    expect(bedrock).not.toHaveBeenCalled();
  });
  it("uses Nano for uncertain routine work, then stops if Nano is confident", async () => {
    const bedrock = vi.fn().mockResolvedValue({ decision: decision(), usage });
    const result = await triageThreeTier(ticket, { jev: vi.fn().mockResolvedValue(jevResult({ confidence: 0.79 })), bedrock });
    expect(result.route).toBe("jev→nano");
    expect(bedrock.mock.calls[0][1].modelId).toBe(MODELS.NEMOTRON_NANO);
    expect(bedrock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(bedrock).toHaveBeenCalledTimes(1);
  });
  it("calls all three when both small models are uncertain", async () => {
    const bedrock = vi.fn()
      .mockResolvedValueOnce({ decision: decision({ confidence: 0.69 }), usage })
      .mockResolvedValueOnce({ decision: decision({ category: "other" }), usage });
    const result = await triageThreeTier(ticket, { jev: vi.fn().mockResolvedValue(jevResult({ confidence: 0.5 })), bedrock });
    expect(result.route).toBe("jev→nano→sonnet");
    expect(result.decision.category).toBe("other");
    expect(bedrock.mock.calls[1][1].modelId).toBe(MODELS.CLAUDE_SONNET);
  });
  it.each([{ priority: "P0" as const }, { priority: "P1" as const }, { needs_human: true }])("bypasses Nano for high-stakes signals and retains the review flag: %o", async (changes) => {
    const bedrock = vi.fn().mockResolvedValue({ decision: decision(), usage });
    const result = await triageThreeTier(ticket, { jev: vi.fn().mockResolvedValue(jevResult(changes)), bedrock });
    expect(result.route).toBe("jev→sonnet");
    expect(result.decision.needs_human).toBe(false);
    expect(result.review_required).toBe(true);
    expect(bedrock).toHaveBeenCalledTimes(1);
    expect(bedrock.mock.calls[0][1].modelId).toBe(MODELS.CLAUDE_SONNET);
  });
  it("falls back on transient Jev failure with incomplete cost", async () => {
    const result = await triageThreeTier(ticket, {
      jev: vi.fn().mockRejectedValue(new JevRequestError("Jev network request failed.", true, 500, 1)),
      bedrock: vi.fn().mockResolvedValue({ decision: decision(), usage }),
    });
    expect(result.route).toBe("jev→nano");
    expect(result.stages[0].status).toBe("unavailable");
    expect(result.cost_complete).toBe(false);
    expect(result.estimated_market_cost_usd).toBeNull();
  });
  it("does not hide configuration/schema errors through fallback", async () => {
    const bedrock = vi.fn();
    await expect(triageThreeTier(ticket, {
      jev: vi.fn().mockRejectedValue(new JevRequestError("Invalid schema.", false, 1, 1)), bedrock,
    })).rejects.toThrow("Invalid schema");
    expect(bedrock).not.toHaveBeenCalled();
  });
  it("rejects a mismatched Bedrock ticket ID", async () => {
    await expect(triageThreeTier(ticket, {
      jev: vi.fn().mockResolvedValue(jevResult({ confidence: 0.5 })),
      bedrock: vi.fn().mockResolvedValue({ decision: decision({ ticket_id: "someone-else" }), usage }),
    })).rejects.toThrow("mismatched ticket ID");
  });
  it("does not call Nano if the caller cancels after Jev", async () => {
    const controller = new AbortController();
    const bedrock = vi.fn();
    await expect(triageThreeTier(ticket, {
      signal: controller.signal,
      jev: vi.fn().mockImplementation(async () => {
        controller.abort(new Error("cancelled after Jev"));
        return jevResult({ confidence: 0.5 });
      }),
      bedrock,
    })).rejects.toThrow("cancelled after Jev");
    expect(bedrock).not.toHaveBeenCalled();
  });
  it("marks costs incomplete when a Jev call needed a retry", async () => {
    const result = await triageThreeTier(ticket, {
      jev: vi.fn().mockResolvedValue({ ...jevResult(), attempts: 2 }),
    });
    expect(result.estimated_market_cost_usd).toBeNull();
    expect(result.known_market_cost_usd).toBeGreaterThan(0);
  });
  it("routes on minimum field confidence and enforces P0 human review", () => {
    const result = jevResult({ priority: "P0" });
    result.response.answers.category.confidence = 1;
    result.response.answers.priority.confidence = 0.1;
    result.response.answers.needs_human.choice = "no";
    const parsed = decisionFromJev(ticket.id, result);
    expect(parsed.decision.confidence).toBe(0.1);
    expect(parsed.decision.needs_human).toBe(true);
    expect(nextAfterJev(parsed.decision)).toBe("sonnet");
    expect(nextAfterJev(decision({ confidence: 0.8 }))).toBe("accept");
  });
  it("compares two- and three-tier paths with cumulative cost", () => {
    const stages = { jev: stage("jev", { confidence: 0.5 }), nano: stage("nano"), sonnet: stage("sonnet") };
    expect(composeStrategy("jev-sonnet", stages).route).toBe("jev→sonnet");
    expect(composeStrategy("jev-nano-sonnet", stages).route).toBe("jev→nano");
    stages.nano.decision!.needs_human = true;
    const result = composeStrategy("jev-nano-sonnet", stages);
    expect(result.route).toBe("jev→nano→sonnet");
    expect(result.estimated_market_cost_usd).toBeCloseTo(0.03);
    expect(result.review_required).toBe(true);
  });
});
