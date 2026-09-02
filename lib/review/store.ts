import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  HumanReviewOverrideFileSchema,
  HumanReviewOverrideSchema,
  HumanReviewWorksheetSchema,
  type HumanReviewOverride,
  type HumanReviewOverrideFile,
  type HumanReviewWorksheet,
} from "../triage/schema";

export const REVIEW_WORKSHEET_PATH = resolve(
  process.cwd(),
  "data/production-shaped-1k.test-review-worksheet.json",
);
export const REVIEW_OVERRIDE_PATH = resolve(
  process.cwd(),
  "data/production-shaped-1k.human-review-overrides.json",
);

export interface ReviewStorePaths {
  worksheetPath: string;
  overridePath: string;
}

export interface ReviewWorkspace {
  worksheet: HumanReviewWorksheet;
  overrides: HumanReviewOverrideFile;
}

const DEFAULT_PATHS: ReviewStorePaths = {
  worksheetPath: REVIEW_WORKSHEET_PATH,
  overridePath: REVIEW_OVERRIDE_PATH,
};

let writeQueue: Promise<void> = Promise.resolve();

function assertMatchingProvenance(
  worksheet: HumanReviewWorksheet,
  overrides: HumanReviewOverrideFile,
) {
  if (
    overrides.dataset_version !== worksheet.dataset_version ||
    overrides.dataset_sha256 !== worksheet.dataset_sha256 ||
    overrides.source_intent_sha256 !== worksheet.source_intent_sha256 ||
    overrides.locked_test_ticket_ids_sha256 !==
      worksheet.locked_test_ticket_ids_sha256
  ) {
    throw new Error(
      "Human-review override provenance does not match the locked worksheet.",
    );
  }
}

function assertReviewCoverage(
  worksheet: HumanReviewWorksheet,
  overrides: HumanReviewOverrideFile,
) {
  const worksheetIds = new Set(
    worksheet.items.map((item) => item.ticket.id),
  );
  const reviewIds = new Set<string>();
  for (const review of overrides.reviews) {
    if (!worksheetIds.has(review.ticket_id)) {
      throw new Error(`Override contains unknown ticket ${review.ticket_id}.`);
    }
    if (reviewIds.has(review.ticket_id)) {
      throw new Error(`Override contains duplicate ticket ${review.ticket_id}.`);
    }
    reviewIds.add(review.ticket_id);
  }
}

export async function readReviewWorkspace(
  paths: ReviewStorePaths = DEFAULT_PATHS,
): Promise<ReviewWorkspace> {
  const [worksheetRaw, overridesRaw] = await Promise.all([
    readFile(paths.worksheetPath, "utf8"),
    readFile(paths.overridePath, "utf8"),
  ]);
  const worksheet = HumanReviewWorksheetSchema.parse(JSON.parse(worksheetRaw));
  const overrides = HumanReviewOverrideFileSchema.parse(JSON.parse(overridesRaw));
  assertMatchingProvenance(worksheet, overrides);
  assertReviewCoverage(worksheet, overrides);
  return { worksheet, overrides };
}

async function performReviewUpsert(
  input: unknown,
  paths: ReviewStorePaths,
): Promise<ReviewWorkspace> {
  const review = HumanReviewOverrideSchema.parse(input);
  const workspace = await readReviewWorkspace(paths);
  const worksheetOrder = new Map(
    workspace.worksheet.items.map((item, index) => [item.ticket.id, index]),
  );
  if (!worksheetOrder.has(review.ticket_id)) {
    throw new Error(`Cannot review unknown ticket ${review.ticket_id}.`);
  }

  const reviews = new Map(
    workspace.overrides.reviews.map((existing) => [
      existing.ticket_id,
      existing,
    ]),
  );
  reviews.set(review.ticket_id, review);
  const overrides = HumanReviewOverrideFileSchema.parse({
    ...workspace.overrides,
    reviews: Array.from(reviews.values()).sort(
      (left, right) =>
        worksheetOrder.get(left.ticket_id)! -
        worksheetOrder.get(right.ticket_id)!,
    ),
  });
  const temporaryPath = `${paths.overridePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(overrides, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporaryPath, paths.overridePath);
  return { worksheet: workspace.worksheet, overrides };
}

export function upsertHumanReview(
  input: unknown,
  paths: ReviewStorePaths = DEFAULT_PATHS,
): Promise<ReviewWorkspace> {
  const operation = writeQueue.then(() => performReviewUpsert(input, paths));
  writeQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
