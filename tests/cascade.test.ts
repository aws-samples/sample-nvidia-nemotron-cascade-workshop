import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the generic cascade classifier (lib/cascade/classify.ts),
 * mirroring the Bedrock-mocking pattern in triage.test.ts.
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

import { cascadeClassify } from "../lib/cascade/classify";
import { shouldEscalate } from "../lib/cascade/escalation";
import { MODELS } from "../lib/bedrock/models";

function toolResponse(distribution: Array<{ label: string; probability: number }>) {
  return {
    output: {
      message: {
        role: "assistant",
        content: [{ toolUse: { name: "classify", input: { distribution } } }],
      },
    },
  };
}

const LABELS = ["billing", "bug_report", "other"];

afterEach(() => {
  sendMock.mockReset();
});

describe("cascadeClassify", () => {
  it("keeps the primary answer when the margin is wide", async () => {
    sendMock.mockResolvedValueOnce(
      toolResponse([
        { label: "billing", probability: 0.9 },
        { label: "bug_report", probability: 0.07 },
        { label: "other", probability: 0.03 },
      ]),
    );

    const r = await cascadeClassify("charged twice", LABELS);

    expect(r.label).toBe("billing");
    expect(r.escalated).toBe(false);
    expect(r.modelUsed).toBe(MODELS.NEMOTRON_NANO);
    expect(r.primaryMargin).toBeCloseTo(0.83, 2);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("escalates to the strong model when the margin is narrow", async () => {
    sendMock
      .mockResolvedValueOnce(
        toolResponse([
          { label: "billing", probability: 0.45 },
          { label: "bug_report", probability: 0.42 },
          { label: "other", probability: 0.13 },
        ]),
      )
      .mockResolvedValueOnce(
        toolResponse([
          { label: "bug_report", probability: 0.8 },
          { label: "billing", probability: 0.15 },
          { label: "other", probability: 0.05 },
        ]),
      );

    const r = await cascadeClassify("pricing shows USD not EUR", LABELS);

    expect(r.escalated).toBe(true);
    expect(r.label).toBe("bug_report"); // escalation model's answer wins
    expect(r.modelUsed).toBe(MODELS.CLAUDE_SONNET);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("honors force_escalate regardless of margin", async () => {
    sendMock
      .mockResolvedValueOnce(
        toolResponse([
          { label: "billing", probability: 0.95 },
          { label: "bug_report", probability: 0.03 },
          { label: "other", probability: 0.02 },
        ]),
      )
      .mockResolvedValueOnce(
        toolResponse([
          { label: "billing", probability: 0.9 },
          { label: "bug_report", probability: 0.08 },
          { label: "other", probability: 0.02 },
        ]),
      );

    const r = await cascadeClassify("charged twice", LABELS, {
      forceEscalate: true,
    });

    expect(r.escalated).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("rejects fewer than 2 labels", async () => {
    await expect(cascadeClassify("text", ["only-one"])).rejects.toThrow(
      /at least 2/,
    );
  });

  it("escalates when top label is in escalate_labels despite wide margin", async () => {
    sendMock
      .mockResolvedValueOnce(
        toolResponse([
          { label: "billing", probability: 0.92 },
          { label: "bug_report", probability: 0.05 },
          { label: "other", probability: 0.03 },
        ]),
      )
      .mockResolvedValueOnce(
        toolResponse([
          { label: "bug_report", probability: 0.7 },
          { label: "billing", probability: 0.2 },
          { label: "other", probability: 0.1 },
        ]),
      );

    const r = await cascadeClassify("charged twice", LABELS, {
      escalateLabels: ["billing"], // billing is the top pick → triggers escalation
    });

    expect(r.escalated).toBe(true);
    expect(r.label).toBe("bug_report"); // strong model's answer
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT escalate when top label is NOT in escalate_labels", async () => {
    sendMock.mockResolvedValueOnce(
      toolResponse([
        { label: "other", probability: 0.8 },
        { label: "billing", probability: 0.15 },
        { label: "bug_report", probability: 0.05 },
      ]),
    );

    const r = await cascadeClassify("hello world", LABELS, {
      escalateLabels: ["billing"], // billing is NOT top pick → no trigger
    });

    expect(r.escalated).toBe(false);
    expect(r.label).toBe("other");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes and filters unknown labels from the distribution", async () => {
    sendMock.mockResolvedValueOnce(
      toolResponse([
        { label: "billing", probability: 0.6 },
        { label: "made_up_label", probability: 0.3 },
        { label: "other", probability: 0.1 },
      ]),
    );

    const r = await cascadeClassify("charged twice", LABELS, {
      marginThreshold: 0,
    });

    expect(r.distribution.every((d) => LABELS.includes(d.label))).toBe(true);
    const sum = r.distribution.reduce((s, d) => s + d.probability, 0);
    expect(sum).toBeCloseTo(1, 5);
  });
});

describe("shouldEscalate (shared triage escalation)", () => {
  const base = {
    ticket_id: "T-1",
    category: "billing",
    priority: "P3",
    confidence: 0.95,
    reasoning: "",
    needs_human: false,
  } as const;

  it("escalates on low confidence", () => {
    expect(shouldEscalate({ ...base, confidence: 0.5 })).toBe(true);
  });

  it("escalates on P0/P1 stakes", () => {
    expect(shouldEscalate({ ...base, priority: "P0" })).toBe(true);
    expect(shouldEscalate({ ...base, priority: "P1" })).toBe(true);
  });

  it("escalates on high-disagreement categories when configured", () => {
    const opts = { highDisagreementCategories: new Set(["integration"]) };
    expect(
      shouldEscalate({ ...base, category: "integration" }, opts),
    ).toBe(true);
    expect(shouldEscalate({ ...base, category: "integration" })).toBe(false);
  });

  it("does not escalate a confident low-stakes decision", () => {
    expect(shouldEscalate(base)).toBe(false);
  });
});
