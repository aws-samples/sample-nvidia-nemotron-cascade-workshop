import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../app/api/triage/cascade/route";
import { triageTicketWithUsage } from "../lib/bedrock/client";
import { MODELS } from "../lib/bedrock/models";

vi.mock("../lib/bedrock/client", () => ({
  triageTicketWithUsage: vi.fn(),
}));

const classify = vi.mocked(triageTicketWithUsage);
const request = (body: string) => new NextRequest("http://localhost/api/triage/cascade", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
});

beforeEach(() => vi.resetAllMocks());

describe("cascade HTTP request validation", () => {
  it.each([
    ["malformed JSON", "{"],
    ["null", "null"],
    ["array", "[]"],
    ["scalar", '"not a ticket"'],
    ["missing ticket fields", "{}"],
    ["invalid customer tier", JSON.stringify({ subject: "Invoice", body: "Where is my invoice?", customer_tier: "vip" })],
  ])("returns JSON 400 for %s without calling a model", async (_name, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toHaveProperty("error");
    expect(classify).not.toHaveBeenCalled();
  });

  it("preserves optional defaults and the Nano-first SSE response for valid input", async () => {
    classify.mockImplementation(async (ticket) => ({
      decision: {
        ticket_id: ticket.id,
        category: "billing",
        priority: "P3",
        confidence: 0.95,
        needs_human: false,
        reasoning: "Routine invoice-download guidance.",
      },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    }));
    const response = await POST(request(JSON.stringify({
      subject: "Invoice",
      body: "Where can I download an invoice?",
    })));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const events = await response.text();
    expect(classify).toHaveBeenCalledExactlyOnceWith({
      id: expect.stringMatching(/^cascade-\d+$/),
      subject: "Invoice",
      body: "Where can I download an invoice?",
      customer_tier: "pro",
    }, { modelId: MODELS.NEMOTRON_NANO });
    expect(events).toContain("event: nano-result");
    expect(events).toContain("event: done");
    expect(events).not.toContain("event: claude-start");
    expect(events).not.toContain("event: error");
  });
});
