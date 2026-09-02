import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceIntentLabelSchema } from "../lib/triage/schema";
import {
  AGENT_REVIEW_PACKET_PATH,
  generateAgentReviewPacket,
} from "../scripts/generate-agent-review-packet";
import { validateAgentReviewResults } from "../scripts/validate-agent-review-results";

function readPacket() {
  return JSON.parse(readFileSync(AGENT_REVIEW_PACKET_PATH, "utf8")) as {
    packet_sha256: string;
    total_items: number;
    items: Array<{
      review_number: number;
      ticket: { id: string; subject: string; body: string };
    }>;
  };
}

describe("blind agent-review packet", () => {
  it("is deterministic, stratified, and contains no answer labels", () => {
    const generated = generateAgentReviewPacket().packet;
    const committed = readPacket();
    const serialized = JSON.stringify(committed);
    const sourceIntent = (
      JSON.parse(
        readFileSync(
          "data/production-shaped-1k.source-intent.json",
          "utf8",
        ),
      ) as unknown[]
    ).map((label) => SourceIntentLabelSchema.parse(label));
    const labelById = new Map(
      sourceIntent.map((label) => [label.ticket_id, label]),
    );
    const cohortCounts = { routine: 0, ambiguous: 0, high_risk: 0 };
    for (const item of committed.items) {
      cohortCounts[labelById.get(item.ticket.id)!.cohort]++;
    }

    expect(generated).toEqual(committed);
    expect(committed.total_items).toBe(50);
    expect(new Set(committed.items.map((item) => item.ticket.id)).size).toBe(50);
    expect(cohortCounts).toEqual({ routine: 28, ambiguous: 15, high_risk: 7 });
    expect(serialized).not.toContain("intended_category");
    expect(serialized).not.toContain("intended_priority");
    expect(serialized).not.toContain("intended_needs_human");
    expect(serialized).not.toContain('"cohort"');
    expect(serialized).not.toContain("source_intent_sha256");
  });

  it("validates complete ordered results and the P0/P1 invariant", () => {
    const packet = readPacket();
    const validResults = {
      schema_version: "agent-review-results-v1",
      packet_sha256: packet.packet_sha256,
      reviewer_agent: "test-agent",
      reviewed_at: "2026-08-20T12:00:00-07:00",
      reviews: packet.items.map((item) => ({
        ticket_id: item.ticket.id,
        category: "other",
        priority: "P2",
        needs_human: false,
        confidence: 0.5,
        rationale: "Validation fixture.",
      })),
    };

    expect(validateAgentReviewResults(packet, validResults).results.reviews).toHaveLength(50);
    validResults.reviews[0].priority = "P1";
    expect(() => validateAgentReviewResults(packet, validResults)).toThrow(
      /P0\/P1 reviews must set needs_human=true/,
    );
  });
});
