/**
 * Centralized model IDs.
 *
 * These are pinned in one place so the attendee implementation task and the
 * bake-off reference the same canonical names. Replace the Nemotron IDs with
 * the exact day-of values once confirmed for the selected Bedrock Region.
 */
export const MODELS = {
  // Sonnet 4.6 — current Anthropic SOTA on Bedrock. Uses the cross-region
  // inference profile because foundation-model IDs alone don't support
  // on-demand throughput for this family ("us." prefix routes to a
  // multi-region pool).
  CLAUDE_SONNET: "us.anthropic.claude-sonnet-4-6",
  // Nemotron Nano 30B (Nano 3) — NVIDIA's small/cheap/fast first-pass tier.
  // Its retained-volume share must be measured on the target workload.
  NEMOTRON_NANO: "nvidia.nemotron-nano-3-30b",
  // Nemotron Super 120B — optional experimental comparison model. The
  // canonical workshop escalation target is Claude Sonnet, not Super.
  NEMOTRON_SUPER: "nvidia.nemotron-super-3-120b",
  // Opus 4.7 — judge for bake-off reference labels. Strong judge model on
  // Bedrock; we use it to grade Sonnet 4.6 and the Nemotron tiers.
  // Same vendor as Sonnet (Anthropic) so this isn't fully vendor-independent,
  // but using a stronger same-family model to grade a weaker one is a
  // defensible eval pattern. Documented in the README.
  OPUS_JUDGE: "us.anthropic.claude-opus-4-7",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

export interface ModelTokenPricing {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export const PRICING_SNAPSHOT = {
  version: "bedrock-on-demand-2026-08-31",
  source: "https://aws.amazon.com/bedrock/pricing/",
  region: "us-west-2",
  serviceTier: "standard on-demand",
} as const;

export const MODEL_TOKEN_PRICING: Record<ModelId, ModelTokenPricing> = {
  [MODELS.CLAUDE_SONNET]: {
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
  },
  [MODELS.NEMOTRON_NANO]: {
    inputUsdPerMillionTokens: 0.06,
    outputUsdPerMillionTokens: 0.24,
  },
  [MODELS.NEMOTRON_SUPER]: {
    inputUsdPerMillionTokens: 0.15,
    outputUsdPerMillionTokens: 0.65,
  },
  [MODELS.OPUS_JUDGE]: {
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 25,
  },
};

export function estimateModelCostUsd(
  modelId: ModelId,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const pricing = MODEL_TOKEN_PRICING[modelId];
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens +
    (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens
  );
}
