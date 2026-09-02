import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HumanReviewWorksheetSchema,
  type HumanReviewOverride,
} from "../lib/triage/schema";
import {
  readReviewWorkspace,
  upsertHumanReview,
  type ReviewStorePaths,
} from "../lib/review/store";

const temporaryDirectories: string[] = [];

function fixture(): ReviewStorePaths {
  const directory = mkdtempSync(join(tmpdir(), "ticket-review-store-"));
  temporaryDirectories.push(directory);
  const worksheet = HumanReviewWorksheetSchema.parse(
    JSON.parse(
      readFileSync(
        "data/production-shaped-1k.test-review-worksheet.json",
        "utf8",
      ),
    ),
  );
  const worksheetPath = join(directory, "worksheet.json");
  const overridePath = join(directory, "overrides.json");
  writeFileSync(worksheetPath, `${JSON.stringify(worksheet, null, 2)}\n`);
  writeFileSync(
    overridePath,
    `${JSON.stringify(
      {
        schema_version: "human-review-overrides-v1",
        dataset_version: worksheet.dataset_version,
        dataset_sha256: worksheet.dataset_sha256,
        source_intent_sha256: worksheet.source_intent_sha256,
        locked_test_ticket_ids_sha256:
          worksheet.locked_test_ticket_ids_sha256,
        reviews: [],
      },
      null,
      2,
    )}\n`,
  );
  return { worksheetPath, overridePath };
}

function review(
  ticketId: string,
  overrides: Partial<HumanReviewOverride> = {},
): HumanReviewOverride {
  return {
    ticket_id: ticketId,
    category: "auth",
    priority: "P2",
    needs_human: false,
    review_status: "human_reviewed",
    reviewer: "test-reviewer",
    reviewed_at: "2026-08-12T12:00:00-07:00",
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local human-review store", () => {
  it("atomically upserts reviews in worksheet order", async () => {
    const paths = fixture();
    const initial = await readReviewWorkspace(paths);
    const firstId = initial.worksheet.items[0].ticket.id;
    const secondId = initial.worksheet.items[1].ticket.id;

    await upsertHumanReview(review(secondId), paths);
    await upsertHumanReview(review(firstId), paths);
    await upsertHumanReview(
      review(secondId, { category: "integration", notes: "Rechecked." }),
      paths,
    );

    const saved = await readReviewWorkspace(paths);
    expect(saved.overrides.reviews.map((entry) => entry.ticket_id)).toEqual([
      firstId,
      secondId,
    ]);
    expect(saved.overrides.reviews).toHaveLength(2);
    expect(saved.overrides.reviews[1]).toMatchObject({
      category: "integration",
      notes: "Rechecked.",
    });
  });

  it("serializes concurrent saves without losing a review", async () => {
    const paths = fixture();
    const initial = await readReviewWorkspace(paths);
    const firstId = initial.worksheet.items[0].ticket.id;
    const secondId = initial.worksheet.items[1].ticket.id;

    await Promise.all([
      upsertHumanReview(review(firstId), paths),
      upsertHumanReview(review(secondId), paths),
    ]);

    const saved = await readReviewWorkspace(paths);
    expect(saved.overrides.reviews.map((entry) => entry.ticket_id)).toEqual([
      firstId,
      secondId,
    ]);
  });

  it("rejects worksheet and override provenance mismatches", async () => {
    const paths = fixture();
    const overrides = JSON.parse(
      readFileSync(paths.overridePath, "utf8"),
    ) as { dataset_sha256: string };
    overrides.dataset_sha256 = "0".repeat(64);
    writeFileSync(paths.overridePath, JSON.stringify(overrides));

    await expect(readReviewWorkspace(paths)).rejects.toThrow(
      /provenance does not match/,
    );
  });

  it("rejects a P0/P1 label without human review", async () => {
    const paths = fixture();
    const workspace = await readReviewWorkspace(paths);
    const ticketId = workspace.worksheet.items[0].ticket.id;

    await expect(
      upsertHumanReview(
        review(ticketId, { priority: "P1", needs_human: false }),
        paths,
      ),
    ).rejects.toThrow(/P0\/P1 reviews must set needs_human=true/);
  });
});
