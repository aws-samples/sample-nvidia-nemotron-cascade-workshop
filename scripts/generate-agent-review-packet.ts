import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  HumanReviewWorksheetSchema,
  SourceIntentLabelSchema,
  TICKET_CATEGORIES,
  TICKET_CATEGORY_DEFINITIONS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_DEFINITIONS,
  TRIAGE_CLASSIFICATION_GUIDANCE,
} from "../lib/triage/schema";

export const AGENT_REVIEW_PACKET_PATH =
  "data/production-shaped-50.agent-review-packet.json";
export const AGENT_REVIEW_RESULTS_PATH =
  "data/production-shaped-50.agent-review-results.json";
const WORKSHEET_PATH =
  "data/production-shaped-1k.test-review-worksheet.json";
const SOURCE_INTENT_PATH =
  "data/production-shaped-1k.source-intent.json";
const ROUTINE_SAMPLE_COUNT = 28;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ranked<T extends { ticket_id: string }>(
  values: T[],
  salt: string,
): T[] {
  return [...values].sort((left, right) =>
    sha256(`${salt}:${left.ticket_id}`).localeCompare(
      sha256(`${salt}:${right.ticket_id}`),
    ),
  );
}

export function generateAgentReviewPacket() {
  const worksheet = HumanReviewWorksheetSchema.parse(
    JSON.parse(readFileSync(WORKSHEET_PATH, "utf8")),
  );
  const sourceIntent = (
    JSON.parse(readFileSync(SOURCE_INTENT_PATH, "utf8")) as unknown[]
  ).map((label) => SourceIntentLabelSchema.parse(label));
  const testLabels = sourceIntent.filter((label) => label.split === "test");
  const ambiguous = testLabels.filter(
    (label) => label.cohort === "ambiguous",
  );
  const highRisk = testLabels.filter(
    (label) => label.cohort === "high_risk",
  );
  const routine = ranked(
    testLabels.filter((label) => label.cohort === "routine"),
    "production-shaped-50-routine-v1",
  ).slice(0, ROUTINE_SAMPLE_COUNT);
  const selected = ranked(
    [...ambiguous, ...highRisk, ...routine],
    "production-shaped-50-mixed-order-v1",
  );
  if (selected.length !== 50) {
    throw new Error(`Expected 50 selected tickets, found ${selected.length}.`);
  }

  const ticketById = new Map(
    worksheet.items.map((item) => [item.ticket.id, item.ticket]),
  );
  const items = selected.map((label, index) => {
    const ticket = ticketById.get(label.ticket_id);
    if (!ticket) {
      throw new Error(`Worksheet is missing ${label.ticket_id}.`);
    }
    return { review_number: index + 1, ticket };
  });

  const packetWithoutHash = {
    schema_version: "agent-review-packet-v1",
    methodology: "blind_ai_assisted_review",
    dataset_version: worksheet.dataset_version,
    dataset_sha256: worksheet.dataset_sha256,
    selection_version: "production-shaped-50-stratified-v1",
    selection_description:
      "A deterministic locked-test subset. Selection labels and generated answers are intentionally omitted.",
    total_items: items.length,
    allowed_categories: TICKET_CATEGORIES,
    category_definitions: TICKET_CATEGORY_DEFINITIONS,
    allowed_priorities: TICKET_PRIORITIES,
    priority_definitions: TICKET_PRIORITY_DEFINITIONS,
    classification_guidance: TRIAGE_CLASSIFICATION_GUIDANCE,
    required_output_fields: {
      ticket_id: "Copy exactly from the ticket.",
      category: "One allowed category.",
      priority: "One allowed priority.",
      needs_human: "Boolean. Must be true for P0/P1.",
      confidence:
        "Reviewer confidence from 0 to 1; this is metadata, not model confidence.",
      rationale:
        "One concise explanation grounded only in the ticket and rubric.",
    },
    items,
  };
  const packet = {
    ...packetWithoutHash,
    packet_sha256: sha256(JSON.stringify(packetWithoutHash)),
  };
  let resultsStatus = "Preserved";
  if (existsSync(AGENT_REVIEW_RESULTS_PATH)) {
    const existing = JSON.parse(
      readFileSync(AGENT_REVIEW_RESULTS_PATH, "utf8"),
    ) as { packet_sha256?: unknown; reviews?: unknown };
    if (Array.isArray(existing.reviews) && existing.reviews.length === 0) {
      resultsStatus = "Refreshed empty";
    } else if (existing.packet_sha256 !== packet.packet_sha256) {
      throw new Error(
        `${AGENT_REVIEW_RESULTS_PATH} contains reviews for a different packet; preserve or adjudicate them before regeneration.`,
      );
    }
  } else {
    resultsStatus = "Created";
  }

  writeFileSync(
    AGENT_REVIEW_PACKET_PATH,
    `${JSON.stringify(packet, null, 2)}\n`,
  );

  if (resultsStatus !== "Preserved") {
    writeFileSync(
      AGENT_REVIEW_RESULTS_PATH,
      `${JSON.stringify(
        {
          schema_version: "agent-review-results-v1",
          packet_sha256: packet.packet_sha256,
          reviewer_agent: null,
          reviewed_at: null,
          reviews: [],
        },
        null,
        2,
      )}\n`,
    );
  }
  return { packet, resultsStatus };
}

export function main() {
  const { packet, resultsStatus } = generateAgentReviewPacket();
  console.log(
    `Wrote ${packet.total_items} blind-review tickets → ${AGENT_REVIEW_PACKET_PATH}`,
  );
  console.log(
    `${resultsStatus} agent results → ${AGENT_REVIEW_RESULTS_PATH}`,
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
