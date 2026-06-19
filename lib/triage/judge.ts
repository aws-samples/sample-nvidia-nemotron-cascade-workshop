import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import { MODELS } from "@/lib/bedrock/models";
import { ROUTING_TOOL } from "@/lib/bedrock/client";
import { TICKET_CATEGORIES, TICKET_PRIORITIES, type Ticket } from "./schema";
import { userPromptForTicket } from "./prompts";

/**
 * Ground-truth judge for the bake-off.
 *
 * Claude Opus 4.7 — the strongest model on Bedrock — labels every ticket
 * once. The bake-off measures how often each tested config (Sonnet 4.6,
 * Nano 30B, Nano→Super routed) agrees with Opus's judgment.
 */

const JUDGE_SYSTEM_PROMPT = `You are an independent triage classifier providing ground-truth labels
for B2B SaaS support tickets. You will be used to grade other models — be
careful, deliberate, and conservative.

Categories: ${TICKET_CATEGORIES.join(", ")}
Priorities: ${TICKET_PRIORITIES.join(", ")} (P0=critical/outage, P1=urgent, P2=normal, P3=low)

If the ticket mentions data loss, security incident, or revenue-impacting
outage, treat it as P0 and set needs_human=true.

Use the route_ticket tool. Set confidence to your true probability the
classification is correct — do NOT default to 0.95+ on every ticket. If
the ticket is genuinely ambiguous, score yourself in the 0.6-0.8 range.`;

export const JudgeLabelSchema = z.object({
  ticket_id: z.string(),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().optional(),
  needs_human: z.boolean().optional().default(false),
});
export type JudgeLabel = z.infer<typeof JudgeLabelSchema>;

let _client: BedrockRuntimeClient | null = null;
function getClient() {
  if (!_client)
    _client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION ?? "us-west-2",
    });
  return _client;
}

export async function judgeTicket(ticket: Ticket): Promise<JudgeLabel> {
  const input: ConverseCommandInput = {
    modelId: MODELS.OPUS_JUDGE,
    system: [{ text: JUDGE_SYSTEM_PROMPT }],
    messages: [
      { role: "user", content: [{ text: userPromptForTicket(ticket) }] },
    ],
    // Opus 4.7 deprecates explicit temperature — use defaults.
    inferenceConfig: { maxTokens: 512 },
    toolConfig: {
      tools: [ROUTING_TOOL],
      toolChoice: { tool: { name: "route_ticket" } },
    },
  };
  const r = await getClient().send(new ConverseCommand(input));
  const blocks = r.output?.message?.content ?? [];
  const toolUse = blocks.find((b) => "toolUse" in b)?.toolUse;
  if (!toolUse?.input) {
    throw new Error(
      `Judge (Opus) returned no toolUse block for ticket ${ticket.id}`,
    );
  }
  const raw = toolUse.input as Record<string, unknown>;
  if (typeof raw.ticket_id !== "string") raw.ticket_id = ticket.id;
  return JudgeLabelSchema.parse(raw);
}
