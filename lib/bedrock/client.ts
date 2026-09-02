import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import { TRIAGE_SYSTEM_PROMPT, userPromptForTicket } from "@/lib/triage/prompts";
import {
  RoutingDecisionSchema,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  type RoutingDecision,
  type Ticket,
} from "@/lib/triage/schema";
import { MODELS, type ModelId } from "./models";

const REGION = process.env.AWS_REGION ?? "us-west-2";

let _client: BedrockRuntimeClient | null = null;

/**
 * Lazy singleton so tests can mock the SDK before construction.
 */
export function getBedrockClient(): BedrockRuntimeClient {
  if (_client === null) {
    _client = new BedrockRuntimeClient({ region: REGION });
  }
  return _client;
}

/**
 * The single tool the model is offered. Forces structured routing output
 * via Bedrock's Converse-API tool-calling, so we never parse free-form JSON.
 */
export const ROUTING_TOOL: Tool = {
  toolSpec: {
    name: "route_ticket",
    description: "Emit the final routing decision for one support ticket.",
    inputSchema: {
      json: {
        type: "object",
        required: [
          "ticket_id",
          "category",
          "priority",
          "confidence",
          "reasoning",
          "needs_human",
        ],
        properties: {
          ticket_id: { type: "string" },
          category: { type: "string", enum: [...TICKET_CATEGORIES] },
          priority: { type: "string", enum: [...TICKET_PRIORITIES] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reasoning: { type: "string", maxLength: 2000 },
          needs_human: { type: "boolean" },
        },
      },
    },
  },
};

export interface TriageOptions {
  modelId?: ModelId;
  maxTokens?: number;
  temperature?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TriageResult {
  decision: RoutingDecision;
  /** Actual token usage from the Converse response; null if unavailable. */
  usage: TokenUsage | null;
}

/**
 * Classify a single ticket via the Bedrock Converse API, returning the
 * decision together with the actual token usage reported by the service.
 *
 * Phase 2 (the bulk processor) should follow this same shape — call
 * `getBedrockClient()`, send a `ConverseCommand` with the routing tool,
 * extract the toolUse block, and validate against `RoutingDecisionSchema`.
 */
export async function triageTicketWithUsage(
  ticket: Ticket,
  options: TriageOptions = {},
): Promise<TriageResult> {
  const modelId = options.modelId ?? MODELS.CLAUDE_SONNET;

  const messages: Message[] = [
    {
      role: "user",
      content: [{ text: userPromptForTicket(ticket) }],
    },
  ];

  const input: ConverseCommandInput = {
    modelId,
    system: [{ text: TRIAGE_SYSTEM_PROMPT }],
    messages,
    inferenceConfig: {
      maxTokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0,
    },
    toolConfig: {
      tools: [ROUTING_TOOL],
      toolChoice: { tool: { name: "route_ticket" } },
    },
  };

  const response = await getBedrockClient().send(new ConverseCommand(input));
  const blocks: ContentBlock[] = response.output?.message?.content ?? [];
  const usage: TokenUsage | null = response.usage
    ? {
        inputTokens: response.usage.inputTokens ?? 0,
        outputTokens: response.usage.outputTokens ?? 0,
        totalTokens: response.usage.totalTokens ?? 0,
      }
    : null;

  // Anthropic + Nemotron Super honor toolChoice and emit a toolUse block.
  // Nemotron Nano often emits the routing JSON as a text block instead, even
  // with toolChoice forced. Accept either — Zod validates the shape.
  const toolUse = blocks.find((b) => "toolUse" in b)?.toolUse;
  if (toolUse?.input) {
    return { decision: RoutingDecisionSchema.parse(toolUse.input), usage };
  }

  const text = blocks.find((b) => "text" in b)?.text;
  if (text) {
    const json = extractJson(text);
    if (json) return { decision: RoutingDecisionSchema.parse(json), usage };
  }

  throw new Error(
    `Bedrock response did not include a parseable routing decision (model=${modelId})`,
  );
}

/**
 * Back-compat wrapper: decision only. Prefer `triageTicketWithUsage` when
 * you need real token counts for cost accounting.
 */
export async function triageTicket(
  ticket: Ticket,
  options: TriageOptions = {},
): Promise<RoutingDecision> {
  const { decision } = await triageTicketWithUsage(ticket, options);
  return decision;
}

function extractJson(text: string): unknown | null {
  // Direct parse first.
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  // Pull the first balanced {...} block — handles models that wrap JSON in
  // markdown fences or surrounding prose.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
