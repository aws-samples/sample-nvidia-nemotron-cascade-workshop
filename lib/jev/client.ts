import { z } from "zod";
import { GATEWAY_MODELS } from "../bedrock/models";

export const JEV_ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

const Probability = z.number().finite().min(0).max(1);
const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), Probability),
  confidence: Probability.optional(),
});

export const GatewayResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), ChoiceAnswerSchema),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  providerMetadata: z.object({
    typesafe: z.object({
      confidence: z.record(z.string(), Probability).optional(),
    }).passthrough().optional(),
    gateway: z.object({
      cost: z.union([z.string(), z.number()]).optional(),
      marketCost: z.union([z.string(), z.number()]).optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
});

export type GatewayResponse = z.infer<typeof GatewayResponseSchema>;
export interface JevEvaluation {
  response: GatewayResponse;
  latencyMs: number;
  attempts: number;
  gatewayReportedCostUsd: number | null;
  gatewayMarketCostUsd: number | null;
}

export class JevRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly latencyMs: number,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "JevRequestError";
  }
}

function cost(value: string | number | undefined): number | null {
  if (value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function validateAnswers(
  response: GatewayResponse,
  questions: Record<string, ChoiceQuestion>,
): GatewayResponse {
  if (response.model !== GATEWAY_MODELS.JEV) throw new Error("Unexpected Jev response model.");
  for (const [name, question] of Object.entries(questions)) {
    const answer = response.answers[name];
    const labels = Object.keys(question.criteria);
    if (!answer || !labels.includes(answer.choice)) {
      throw new Error(`Missing or invalid Jev choice for ${name}.`);
    }
    const returned = Object.keys(answer.probabilities);
    const mass = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
    if (
      returned.length !== labels.length ||
      labels.some((label) => answer.probabilities[label] === undefined) ||
      Math.abs(mass - 1) > 0.01 ||
      answer.probabilities[answer.choice] <
        Math.max(...Object.values(answer.probabilities)) - 1e-8
    ) {
      throw new Error(`Invalid Jev probability distribution for ${name}.`);
    }
    const confidence =
      answer.confidence ?? response.providerMetadata?.typesafe?.confidence?.[name];
    if (confidence === undefined) {
      throw new Error(`Missing Jev confidence for ${name}.`);
    }
    answer.confidence = confidence;
  }
  return response;
}

export async function evaluateChoices(
  state: unknown,
  questions: Record<string, ChoiceQuestion>,
  options: {
    apiKey?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<JevEvaluation> {
  const apiKey = options.apiKey ?? process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) throw new JevRequestError("Set AI_GATEWAY_API_KEY for Jev.", false, 0, 0);
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error("Jev timeout must be between 1 and 60000 ms.");
  }
  const request = options.fetchImpl ?? fetch;
  const started = performance.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let attempts = 0;
  // One retry, sharing the same total deadline. No key, body or headers in errors.
  for (; attempts < 2;) {
    signal.throwIfAborted();
    attempts++;
    let response: Response;
    try {
      response = await request(JEV_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: GATEWAY_MODELS.JEV, state, questions }),
      });
    } catch {
      if (options.signal?.aborted) throw options.signal.reason;
      throw new JevRequestError(
        signal.aborted ? "Jev request deadline exceeded." : "Jev network request failed.",
        true, Math.round(performance.now() - started), attempts,
      );
    }
    if (!response.ok) {
      const retryable = [429, 500, 502, 503, 504].includes(response.status);
      await response.body?.cancel();
      if (retryable && attempts < 2) {
        const header = Number(response.headers.get("retry-after"));
        const backoff = Number.isFinite(header) && header > 0
          ? Math.min(header * 1000, 2000)
          : 250 + Math.random() * 250;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, backoff);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }).catch(() => {
          if (options.signal?.aborted) throw options.signal.reason;
          throw new JevRequestError("Jev request deadline exceeded.", true,
            Math.round(performance.now() - started), attempts);
        });
        continue;
      }
      throw new JevRequestError(
        `Jev gateway returned HTTP ${response.status}.`,
        retryable, Math.round(performance.now() - started), attempts,
      );
    }
    let parsed: GatewayResponse;
    try {
      parsed = validateAnswers(GatewayResponseSchema.parse(await response.json()), questions);
    } catch {
      if (options.signal?.aborted) throw options.signal.reason;
      if (signal.aborted) throw new JevRequestError("Jev request deadline exceeded.", true,
        Math.round(performance.now() - started), attempts);
      throw new JevRequestError(
        "Jev returned an invalid or incomplete evaluation.", false,
        Math.round(performance.now() - started), attempts,
      );
    }
    return {
      response: parsed,
      latencyMs: Math.round(performance.now() - started),
      attempts,
      gatewayReportedCostUsd: cost(parsed.providerMetadata?.gateway?.cost),
      gatewayMarketCostUsd: cost(parsed.providerMetadata?.gateway?.marketCost),
    };
  }
  throw new Error("Jev retry limit exhausted.");
}
