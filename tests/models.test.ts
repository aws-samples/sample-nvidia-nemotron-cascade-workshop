import { describe, expect, it } from "vitest";
import {
  MODELS,
  estimateModelCostUsd,
} from "../lib/bedrock/models";

describe("model pricing", () => {
  it("prices input and output tokens separately", () => {
    expect(
      estimateModelCostUsd(MODELS.NEMOTRON_NANO, {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(0.3);
    expect(
      estimateModelCostUsd(MODELS.CLAUDE_SONNET, {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(18);
  });
});
