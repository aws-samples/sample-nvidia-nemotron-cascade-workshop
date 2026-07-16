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
  // Nemotron Nano 30B (Nano 3) — NVIDIA's small/cheap/fast tier. Native
  // tool calling, MoE throughput. The "easy 80%" workhorse.
  NEMOTRON_NANO: "nvidia.nemotron-nano-3-30b",
  // Nemotron Super 120B — NVIDIA's reasoning tier. The escalation target
  // when Nano returns low confidence.
  NEMOTRON_SUPER: "nvidia.nemotron-super-3-120b",
  // Opus 4.7 — judge for bake-off reference labels. Strong judge model on
  // Bedrock; we use it to grade Sonnet 4.6 and the Nemotron tiers.
  // Same vendor as Sonnet (Anthropic) so this isn't fully vendor-independent,
  // but using a stronger same-family model to grade a weaker one is a
  // defensible eval pattern. Documented in the README.
  OPUS_JUDGE: "us.anthropic.claude-opus-4-7",
  // Future: Nemotron 3 Ultra (550B / 55B-active MoE) — NVIDIA's frontier
  // reasoning tier, released June 2026. Slots in above Super as a third
  // cascade rung for agent-orchestration workloads (sustained multi-turn
  // planning, sub-agent delegation, deep reasoning). Pending Amazon Bedrock
  // availability — add as MODELS.NEMOTRON_ULTRA once a supported model ID
  // is available in the selected Region.
  // Reference: https://developer.nvidia.com/blog/nvidia-nemotron-3-ultra-powers-faster-more-efficient-reasoning-for-long-running-agents/
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/**
 * Approximate per-1k-token pricing in USD (input + output averaged).
 * Used only for the Phase 4 bake-off display — not authoritative.
 * Update before workshop with current Bedrock pricing.
 */
export const APPROX_COST_PER_1K_TOKENS: Record<ModelId, number> = {
  [MODELS.CLAUDE_SONNET]: 0.009,
  [MODELS.NEMOTRON_NANO]: 0.0008,
  [MODELS.NEMOTRON_SUPER]: 0.005,
  [MODELS.OPUS_JUDGE]: 0.045,
};
