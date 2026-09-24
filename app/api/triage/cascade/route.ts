import { NextResponse, type NextRequest } from "next/server";
import { triageTicketWithUsage, type TokenUsage } from "@/lib/bedrock/client";
import { MODELS, estimateModelCostUsd, type ModelId } from "@/lib/bedrock/models";
import { TicketSchema } from "@/lib/triage/schema";
import { shouldEscalate } from "@/lib/cascade/escalation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function costFromUsage(
  usage: TokenUsage | null,
  modelId: ModelId,
): number | null {
  return usage ? estimateModelCostUsd(modelId, usage) : null;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }
  const fields = body !== null && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  const parsed = TicketSchema.safeParse(fields && {
    id: fields.id || "cascade-" + Date.now(),
    subject: fields.subject,
    body: fields.body,
    customer_tier: fields.customer_tier || "pro",
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid ticket payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const ticket = parsed.data;

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
        const { decision: nanoDecision, usage: nanoUsage } =
          await triageTicketWithUsage(ticket, {
            modelId: MODELS.NEMOTRON_NANO,
          });
        const nanoLatencyMs = Math.round(performance.now() - nanoStart);
        const nanoCost = costFromUsage(nanoUsage, MODELS.NEMOTRON_NANO);
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
          const { decision: claudeDecision, usage: claudeUsage } =
            await triageTicketWithUsage(ticket, {
              modelId: MODELS.CLAUDE_SONNET,
            });
          const claudeLatencyMs = Math.round(performance.now() - claudeStart);
          const claudeCost = costFromUsage(claudeUsage, MODELS.CLAUDE_SONNET);

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
            totalCost:
              nanoCost === null || claudeCost === null
                ? null
                : nanoCost + claudeCost,
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
