#!/usr/bin/env tsx
/**
 * cascade-classify MCP server.
 *
 * Exposes `cascade_classify(text, labels[])` — cost-aware text
 * classification on Amazon Bedrock. NVIDIA Nemotron 3 Nano classifies every
 * request; Anthropic Claude Sonnet is called when Nano's probability margin
 * shows uncertainty or when an explicit caller guardrail requests escalation.
 * Also exposes `triage_three_tier(ticket)` — Jev → Nano → Sonnet ticket triage.
 *
 * Mount from any MCP client (Claude Code, Cursor, ...):
 *
 *   { "mcpServers": { "cascade-classify": {
 *       "command": "<repo>/node_modules/.bin/tsx",
 *       "args": ["--tsconfig", "<repo>/tsconfig.json", "<repo>/mcp/server.ts"],
 *       "env": { "AWS_REGION": "us-west-2" } } } }
 *
 * Credentials: AWS SDK default chain — whatever makes
 * `aws sts get-caller-identity` work makes this server work.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cascadeClassify } from "../lib/cascade/classify";
import { triageThreeTier } from "../lib/cascade/three-tier";
import { TicketSchema } from "../lib/triage/schema";

const server = new McpServer({
  name: "cascade-classify",
  version: "0.1.0",
});

server.registerTool(
  "cascade_classify",
  {
    title: "Cascade classify",
    description:
      "Classify text into one of the provided labels with cost-aware model routing. " +
      "Runs NVIDIA Nemotron 3 Nano (fast, cost-efficient) on every request and " +
      "escalates to Anthropic Claude Sonnet when Nano's probability margin " +
      "shows uncertainty or an explicit caller guardrail fires. Use for any " +
      "sort-into-fixed-categories step: intent detection, ticket/alert " +
      "routing, moderation triage, log severity, document tagging. " +
      "Returns the winning label, the full probability distribution, " +
      "which model produced the answer, and approximate cost.",
    inputSchema: {
      text: z.string().min(1).describe("The text to classify"),
      labels: z
        .array(z.string().min(1))
        .min(2)
        .max(50)
        .describe("Candidate labels (2-50). The answer is one of these."),
      margin_threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Escalate when top1-top2 probability gap is below this. " +
            "Default 0.25. Lower = fewer escalations (cheaper, riskier); " +
            "higher = more escalations (costlier, safer).",
        ),
      force_escalate: z
        .boolean()
        .optional()
        .describe(
          "Skip the margin check and always use the strong model. " +
            "Set when the caller knows the stakes are high.",
        ),
      escalate_labels: z
        .array(z.string())
        .optional()
        .describe(
          "Labels that always escalate to the strong model when they are " +
            "the primary model's top pick, regardless of margin. Use for " +
            "labels the primary model is known to confuse. Putting every " +
            "label here means paying for both models on every call.",
        ),
    },
  },
  async ({ text, labels, margin_threshold, force_escalate, escalate_labels }) => {
    const result = await cascadeClassify(text, labels, {
      marginThreshold: margin_threshold,
      forceEscalate: force_escalate,
      escalateLabels: escalate_labels,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              label: result.label,
              distribution: result.distribution,
              escalated: result.escalated,
              model_used: result.modelUsed,
              primary_margin: Number(result.primaryMargin.toFixed(3)),
              latency_ms: result.latencyMs,
              approx_cost_usd:
                result.approxCostUsd === null
                  ? null
                  : Number(result.approxCostUsd.toFixed(6)),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "triage_three_tier",
  {
    title: "Three-tier ticket triage",
    description:
      "Classify a support ticket into category, priority and human-review status. " +
      "Starts with Jev on Vercel AI Gateway, uses Nemotron Nano on Bedrock for uncertain " +
      "routine tickets, and escalates to Sonnet on Bedrock when needed. " +
      "P0/P1 or human-review signals from Jev bypass Nano. Returns all stage decisions, " +
      "the route, latency and estimated cost. review_required preserves earlier review " +
      "signals even if the final model disagrees. This is a classification example; " +
      "it does not modify a ticket or perform the requested account action. " +
      "Requires AI_GATEWAY_API_KEY and AWS credentials on the server.",
    inputSchema: { ticket: TicketSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({ ticket }, extra) => {
    const result = await triageThreeTier(ticket, { signal: extra.signal });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
