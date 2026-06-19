import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Existing test that sets the pattern for the new bulk endpoint:
 *  - mock @aws-sdk/client-bedrock-runtime
 *  - assert ConverseCommand inputs
 *  - assert the parsed RoutingDecision shape
 */

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class ConverseCommand {
    constructor(public input: unknown) {}
  }
  class BedrockRuntimeClient {
    send = sendMock;
  }
  return { BedrockRuntimeClient, ConverseCommand };
});

beforeEach(() => {
  sendMock.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

function fakeToolUseResponse() {
  return {
    output: {
      message: {
        content: [
          {
            toolUse: {
              name: "route_ticket",
              input: {
                ticket_id: "T-001",
                category: "billing",
                priority: "P1",
                confidence: 0.92,
                reasoning: "Customer reports duplicate charge.",
                needs_human: false,
              },
            },
          },
        ],
      },
    },
  };
}

describe("triageTicket", () => {
  it("returns a validated RoutingDecision when Bedrock emits a toolUse", async () => {
    sendMock.mockResolvedValueOnce(fakeToolUseResponse());
    const { triageTicket } = await import("@/lib/bedrock/client");

    const decision = await triageTicket({
      id: "T-001",
      subject: "Charged twice",
      body: "Refund please.",
      customer_tier: "pro",
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(decision.category).toBe("billing");
    expect(decision.priority).toBe("P1");
    expect(decision.confidence).toBeGreaterThan(0);
  });

  it("falls back to text-block JSON when toolUse is missing (Nemotron Nano case)", async () => {
    sendMock.mockResolvedValueOnce({
      output: {
        message: {
          content: [
            {
              text: 'Here is the routing:\n{"ticket_id":"T-002","category":"billing","priority":"P2","confidence":0.81,"reasoning":"r","needs_human":false}',
            },
          ],
        },
      },
    });
    const { triageTicket } = await import("@/lib/bedrock/client");

    const decision = await triageTicket({
      id: "T-002",
      subject: "x",
      body: "y",
    });

    expect(decision.category).toBe("billing");
    expect(decision.priority).toBe("P2");
  });

  it("throws when Bedrock returns neither toolUse nor parseable text", async () => {
    sendMock.mockResolvedValueOnce({
      output: { message: { content: [{ text: "I refuse" }] } },
    });
    const { triageTicket } = await import("@/lib/bedrock/client");

    await expect(
      triageTicket({ id: "T-003", subject: "x", body: "y" }),
    ).rejects.toThrow(/parseable routing decision/);
  });
});
