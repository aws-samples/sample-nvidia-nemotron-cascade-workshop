import { NextRequest } from "next/server";
import { triageTicket } from "@/lib/bedrock/client";
import { MODELS, APPROX_COST_PER_1K_TOKENS } from "@/lib/bedrock/models";
import { TicketSchema, type RoutingDecision } from "@/lib/triage/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKENS_PER_CALL = 0.35; // approximate 0.35K tokens per call

function estimateCost(modelId: keyof typeof APPROX_COST_PER_1K_TOKENS): number {
  return TOKENS_PER_CALL * APPROX_COST_PER_1K_TOKENS[modelId];
}

function shouldEscalate(decision: RoutingDecision): boolean {
  return (
    decision.confidence < 0.7 ||
    decision.priority === "P0" ||
    decision.priority === "P1" ||
    decision.needs_human
  );
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const ticket = TicketSchema.parse({
    id: body.id || "cascade-" + Date.now(),
    subject: body.subject,
    body: body.body,
    customer_tier: body.customer_tier || "pro",
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        // Step 1: Nano classification
        sendEvent("nano-start", {});
        const nanoStart = performance.now();
        const nanoDecision = await triageTicket(ticket, {
          modelId: MODELS.NEMOTRON_NANO,
        });
        const nanoLatencyMs = Math.round(performance.now() - nanoStart);
        const nanoCost = estimateCost(MODELS.NEMOTRON_NANO);
        const escalating = shouldEscalate(nanoDecision);

        sendEvent("nano-result", {
          decision: nanoDecision,
          escalating,
          latencyMs: nanoLatencyMs,
          cost: nanoCost,
        });

        if (escalating) {
          // Step 2: Escalate to Claude Sonnet
          sendEvent("claude-start", {});
          const claudeStart = performance.now();
          const claudeDecision = await triageTicket(ticket, {
            modelId: MODELS.CLAUDE_SONNET,
          });
          const claudeLatencyMs = Math.round(performance.now() - claudeStart);
          const claudeCost = estimateCost(MODELS.CLAUDE_SONNET);

          sendEvent("claude-result", {
            decision: claudeDecision,
            latencyMs: claudeLatencyMs,
            cost: claudeCost,
          });

          sendEvent("done", {
            finalDecision: claudeDecision,
            modelUsed: "claude-sonnet",
            escalated: true,
            totalLatencyMs: nanoLatencyMs + claudeLatencyMs,
            totalCost: nanoCost + claudeCost,
          });
        } else {
          // Nano was confident — done
          sendEvent("done", {
            finalDecision: nanoDecision,
            modelUsed: "nemotron-nano",
            escalated: false,
            totalLatencyMs: nanoLatencyMs,
            totalCost: nanoCost,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendEvent("error", { message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
