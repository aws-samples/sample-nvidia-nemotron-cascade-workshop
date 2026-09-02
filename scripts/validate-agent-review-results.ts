import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
} from "../lib/triage/schema";
import {
  AGENT_REVIEW_PACKET_PATH,
  AGENT_REVIEW_RESULTS_PATH,
} from "./generate-agent-review-packet";

const PacketSchema = z.object({
  schema_version: z.literal("agent-review-packet-v1"),
  total_items: z.literal(50),
  packet_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  items: z.array(
    z.object({
      review_number: z.number().int().positive(),
      ticket: z.object({ id: z.string().min(1) }),
    }),
  ).length(50),
}).passthrough();

const AgentReviewSchema = z.object({
  ticket_id: z.string().min(1),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES),
  needs_human: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(1000),
}).superRefine((review, context) => {
  if (
    (review.priority === "P0" || review.priority === "P1") &&
    !review.needs_human
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["needs_human"],
      message: "P0/P1 reviews must set needs_human=true.",
    });
  }
});

const AgentReviewResultsSchema = z.object({
  schema_version: z.literal("agent-review-results-v1"),
  packet_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  reviewer_agent: z.string().min(1),
  reviewed_at: z.string().datetime({ offset: true }),
  reviews: z.array(AgentReviewSchema).length(50),
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateAgentReviewResults(
  packetInput: unknown,
  resultsInput: unknown,
) {
  if (!packetInput || typeof packetInput !== "object") {
    throw new Error("Agent review packet must be a JSON object.");
  }
  const {
    packet_sha256: rawPacketHash,
    ...rawPacketWithoutHash
  } = packetInput as Record<string, unknown>;
  if (
    typeof rawPacketHash !== "string" ||
    sha256(JSON.stringify(rawPacketWithoutHash)) !== rawPacketHash
  ) {
    throw new Error("Agent review packet hash is invalid.");
  }
  const packet = PacketSchema.parse(packetInput);
  const results = AgentReviewResultsSchema.parse(resultsInput);
  if (results.packet_sha256 !== packet.packet_sha256) {
    throw new Error("Agent results do not match the current review packet.");
  }
  const expectedIds = packet.items.map((item) => item.ticket.id);
  const actualIds = results.reviews.map((review) => review.ticket_id);
  if (new Set(actualIds).size !== actualIds.length) {
    throw new Error("Agent results contain duplicate ticket IDs.");
  }
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(
      "Agent results must include every packet ticket exactly once and preserve packet order.",
    );
  }
  return { packet, results };
}

export function main() {
  const { results } = validateAgentReviewResults(
    JSON.parse(readFileSync(AGENT_REVIEW_PACKET_PATH, "utf8")),
    JSON.parse(readFileSync(AGENT_REVIEW_RESULTS_PATH, "utf8")),
  );
  const priorities = Object.fromEntries(
    TICKET_PRIORITIES.map((priority) => [
      priority,
      results.reviews.filter((review) => review.priority === priority).length,
    ]),
  );
  console.log(`Validated ${results.reviews.length}/50 agent reviews.`);
  console.log(`Priority counts: ${JSON.stringify(priorities)}`);
  console.log(
    `Needs-human count: ${results.reviews.filter((review) => review.needs_human).length}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
