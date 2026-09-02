import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODELS } from "../lib/bedrock/models";
import { JUDGE_SYSTEM_PROMPT } from "../lib/triage/judge";
import { TRIAGE_SYSTEM_PROMPT } from "../lib/triage/prompts";
import {
  HumanReviewOverrideFileSchema,
  NEEDS_HUMAN_RUBRIC,
  SourceIntentLabelSchema,
  TicketSchema,
  TRIAGE_CLASSIFICATION_GUIDANCE,
  type RoutingDecision,
  type SourceIntentLabel,
} from "../lib/triage/schema";
import {
  CALIBRATION_TICKET_COUNT,
  DEFAULT_TICKET_LIMIT,
  LOCKED_TEST_TICKET_COUNT,
  buildEvaluationContext,
  cachePath,
  composeRoutedResults,
  createCacheEnvelope,
  enforceHumanReviewGate,
  humanReviewGateStatus,
  loadDataset,
  main,
  parseArgs,
  resolveConfigs,
  readCache,
  routingTriggers,
  summarize,
  type PerTicketResult,
} from "../scripts/bakeoff";
import {
  PRODUCTION_METADATA_OUTPUT,
  PRODUCTION_REVIEW_WORKSHEET_OUTPUT,
  PRODUCTION_SOURCE_INTENT_OUTPUT,
  generateLockedTestReviewWorksheet,
  generateProductionDataset,
  generateStressTickets,
} from "../scripts/generate-tickets";

function decision(
  ticketId: string,
  overrides: Partial<RoutingDecision> = {},
): RoutingDecision {
  return {
    ticket_id: ticketId,
    category: "billing",
    priority: "P2",
    confidence: 0.9,
    reasoning: "Evaluation fixture.",
    needs_human: false,
    ...overrides,
  };
}

function result(
  ticketId: string,
  model: (typeof MODELS)[keyof typeof MODELS],
  finalDecision = decision(ticketId),
  latencyMs = 100,
): PerTicketResult {
  return {
    ticket_id: ticketId,
    decision: finalDecision,
    primary_decision: finalDecision,
    final_decision: finalDecision,
    primary_model: model,
    final_model: model,
    models_called: [model],
    routing_triggers: [],
    latency_ms: latencyMs,
    input_token_count: 80,
    output_token_count: 20,
    token_count: 100,
    estimated_comparative_cost_usd: 0.001,
    escalated: false,
  };
}

function cacheFixture() {
  const tempDirectory = mkdtempSync(join(tmpdir(), "bakeoff-cache-"));
  const selection = {
    ...loadDataset(parseArgs([])),
    cacheDir: tempDirectory,
  };
  const evaluation = buildEvaluationContext(
    selection,
    "us-west-2",
    "cache-test-revision",
  );
  const ticketIds = selection.tickets.map((ticket) => ticket.id);
  const data = ticketIds.map((ticketId) =>
    result(ticketId, MODELS.NEMOTRON_NANO, decision(ticketId)),
  );
  const envelope = createCacheEnvelope(
    "model-nano",
    evaluation,
    { createdAt: "2026-08-11T19:00:00.000Z", runId: "cache-test" },
    ticketIds,
    data,
  );
  const path = cachePath(selection, "model-nano");
  return { tempDirectory, selection, evaluation, ticketIds, data, envelope, path };
}

describe("shared triage taxonomy", () => {
  it("reuses one taxonomy in classifier and optional judge prompts", () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain(TRIAGE_CLASSIFICATION_GUIDANCE);
    expect(JUDGE_SYSTEM_PROMPT).toContain(TRIAGE_CLASSIFICATION_GUIDANCE);
    expect(TRIAGE_CLASSIFICATION_GUIDANCE).toContain(
      "Security incidents map to abuse",
    );
    expect(TRIAGE_CLASSIFICATION_GUIDANCE).toContain(
      "Customer tier is context only",
    );
    expect(NEEDS_HUMAN_RUBRIC).toContain("Priority is P0 or P1");
    expect(NEEDS_HUMAN_RUBRIC).toContain("Material ambiguity");
    expect(NEEDS_HUMAN_RUBRIC).toContain("production-data action");
    expect(NEEDS_HUMAN_RUBRIC).toContain("exception to policy");
    expect(NEEDS_HUMAN_RUBRIC).toContain("routine requests");
  });
});

describe("bake-off CLI safety", () => {
  it("defaults to the 30-ticket workshop split and routed config", () => {
    const args = parseArgs([]);

    expect(args.dataset).toBe("production");
    expect(args.split).toBe("workshop");
    expect(args.limit).toBe(DEFAULT_TICKET_LIMIT);
    expect(args.fullDataset).toBe(false);
    expect(args.claimSummary).toBe(false);
    expect(resolveConfigs(args)).toEqual(["routed"]);
    expect(loadDataset(args).tickets).toHaveLength(DEFAULT_TICKET_LIMIT);
  });

  it("parses explicit claim and review-override workflow flags", () => {
    const args = parseArgs([
      "--claim-summary",
      "--review-overrides=/tmp/reviews.json",
    ]);

    expect(args.claimSummary).toBe(true);
    expect(args.reviewOverridesPath).toBe("/tmp/reviews.json");
  });

  it("uses fixed calibration and locked test comparison sets", () => {
    const calibration = parseArgs(["--split=calibration"]);
    const test = parseArgs(["--split=test"]);

    expect(calibration.limit).toBe(CALIBRATION_TICKET_COUNT);
    expect(test.limit).toBe(LOCKED_TEST_TICKET_COUNT);
    expect(loadDataset(calibration).tickets).toHaveLength(50);
    expect(loadDataset(test).tickets).toHaveLength(150);
    expect(() => parseArgs(["--split=test", "--limit=10"])).toThrow(
      /fixed evaluation split/,
    );
  });

  it("requires an explicit full-dataset flag for 1,000 tickets", () => {
    expect(() => parseArgs(["--split=all", "--limit=1000"])).toThrow(
      /--full-dataset/,
    );
    expect(parseArgs(["--full-dataset"]).fullDataset).toBe(true);
  });

  it("keeps Super out of headline runs unless explicitly enabled", () => {
    expect(resolveConfigs(parseArgs(["--all"]))).toEqual([
      "sonnet",
      "nano",
      "routed",
    ]);
    expect(
      resolveConfigs(parseArgs(["--all", "--experimental-super"])),
    ).toEqual(["sonnet", "nano", "routed", "super"]);
    expect(() => parseArgs(["--config=super"])).toThrow(
      /--experimental-super/,
    );
  });
});

describe("deterministic production evaluation data", () => {
  it("emits schema-clean tickets and separate source-intent artifacts", () => {
    const generated = generateProductionDataset();
    const committedTickets = readFileSync(
      "data/production-shaped-1k.json",
      "utf8",
    );
    const committedLabels = readFileSync(PRODUCTION_SOURCE_INTENT_OUTPUT, "utf8");
    const committedMetadata = readFileSync(PRODUCTION_METADATA_OUTPUT, "utf8");
    const committedWorksheet = readFileSync(
      PRODUCTION_REVIEW_WORKSHEET_OUTPUT,
      "utf8",
    );
    const worksheet = generateLockedTestReviewWorksheet(generated);

    expect(generated.tickets).toHaveLength(1000);
    expect(generated.sourceIntentLabels).toHaveLength(1000);
    expect(
      generated.tickets.every(
        (ticket) =>
          TicketSchema.safeParse(ticket).success &&
          Object.keys(ticket).every((key) =>
            ["id", "subject", "body", "customer_tier"].includes(key),
          ),
      ),
    ).toBe(true);
    expect(
      generated.sourceIntentLabels.every(
        (label) => SourceIntentLabelSchema.safeParse(label).success,
      ),
    ).toBe(true);
    expect(`${JSON.stringify(generated.tickets, null, 2)}\n`).toBe(
      committedTickets,
    );
    expect(`${JSON.stringify(generated.sourceIntentLabels, null, 2)}\n`).toBe(
      committedLabels,
    );
    expect(`${JSON.stringify(generated.metadata, null, 2)}\n`).toBe(
      committedMetadata,
    );
    expect(`${JSON.stringify(worksheet, null, 2)}\n`).toBe(
      committedWorksheet,
    );
    expect(worksheet.items).toHaveLength(LOCKED_TEST_TICKET_COUNT);
    expect(
      worksheet.items.every(
        (item) =>
          item.review_template.category === null &&
          !("generated_source_intent" in item),
      ),
    ).toBe(true);
  });

  it("keeps calibration and test scenario families disjoint", () => {
    const { sourceIntentLabels } = generateProductionDataset();
    const calibrationFamilies = new Set(
      sourceIntentLabels
        .filter((label) => label.split === "calibration")
        .map((label) => label.scenario_family),
    );
    const testFamilies = new Set(
      sourceIntentLabels
        .filter((label) => label.split === "test")
        .map((label) => label.scenario_family),
    );

    expect(
      [...calibrationFamilies].filter((family) => testFamilies.has(family)),
    ).toEqual([]);
    expect(
      sourceIntentLabels.filter((label) => label.split === "calibration"),
    ).toHaveLength(50);
    expect(
      sourceIntentLabels.filter((label) => label.split === "test"),
    ).toHaveLength(150);
    expect(
      sourceIntentLabels.filter((label) => label.workshop_default),
    ).toHaveLength(30);
    expect(
      sourceIntentLabels.every((label) => label.review_status === "unreviewed"),
    ).toBe(true);
  });

  it("keeps subjects and bodies coupled within scenarios", () => {
    const { tickets } = generateProductionDataset();
    const invoiceCopies = tickets.filter(
      (ticket) => ticket.subject === "Invoice copy",
    );
    const accountTakeovers = tickets.filter(
      (ticket) => ticket.subject === "Possible account takeover",
    );

    expect(invoiceCopies.length).toBeGreaterThan(0);
    expect(
      invoiceCopies.every((ticket) => ticket.body.includes("send invoice")),
    ).toBe(true);
    expect(accountTakeovers.length).toBeGreaterThan(0);
    expect(
      accountTakeovers.every((ticket) =>
        ticket.body.includes("unrecognized administrator login"),
      ),
    ).toBe(true);
  });

  it("keeps routine password resets as self-service guidance", () => {
    const generated = generateProductionDataset();
    const labelsById = new Map(
      generated.sourceIntentLabels.map((label) => [label.ticket_id, label]),
    );
    const passwordResetTickets = generated.tickets.filter(
      (ticket) =>
        labelsById.get(ticket.id)?.scenario_family === "test_password_reset",
    );

    expect(passwordResetTickets.length).toBeGreaterThan(0);
    expect(
      passwordResetTickets.every((ticket) =>
        /where|which self-service/i.test(ticket.body),
      ),
    ).toBe(true);
    expect(
      passwordResetTickets.every(
        (ticket) => labelsById.get(ticket.id)?.intended_needs_human === false,
      ),
    ).toBe(true);
    expect(
      passwordResetTickets.every(
        (ticket) => labelsById.get(ticket.id)?.intended_priority === "P3",
      ),
    ).toBe(true);
  });

  it("separates feature requests from permission actions", () => {
    const generated = generateProductionDataset();
    const labelsById = new Map(
      generated.sourceIntentLabels.map((label) => [label.ticket_id, label]),
    );
    const roleRequests = generated.tickets.filter(
      (ticket) => ticket.subject === "Read-only role request",
    );

    expect(roleRequests.length).toBeGreaterThan(0);
    expect(
      roleRequests.every((ticket) =>
        ticket.body.includes("does not currently offer"),
      ),
    ).toBe(true);
    expect(
      roleRequests.every((ticket) => {
        const label = labelsById.get(ticket.id);
        return (
          label?.intended_category === "feature_request" &&
          label.intended_priority === "P3" &&
          label.intended_needs_human === false
        );
      }),
    ).toBe(true);
  });

  it("distinguishes broad outages from one-workspace write failures", () => {
    const generated = generateProductionDataset();
    const labelsById = new Map(
      generated.sourceIntentLabels.map((label) => [label.ticket_id, label]),
    );
    const broadOutages = generated.tickets.filter(
      (ticket) => ticket.subject === "Production unavailable",
    );
    const workspaceOutages = generated.tickets.filter(
      (ticket) => ticket.subject === "Writes failing in production",
    );

    expect(broadOutages.length).toBeGreaterThan(0);
    expect(workspaceOutages.length).toBeGreaterThan(0);
    expect(
      broadOutages.every((ticket) => {
        const label = labelsById.get(ticket.id);
        return (
          label?.intended_category === "bug_report" &&
          label.intended_priority === "P0" &&
          label.intended_needs_human === true
        );
      }),
    ).toBe(true);
    expect(
      workspaceOutages.every((ticket) => {
        const label = labelsById.get(ticket.id);
        return (
          label?.intended_category === "bug_report" &&
          label.intended_priority === "P1" &&
          label.intended_needs_human === true
        );
      }),
    ).toBe(true);
  });

  it("preserves the historical stress dataset byte-for-byte", () => {
    const generated = `${JSON.stringify(generateStressTickets(), null, 2)}\n`;
    const committed = readFileSync("data/synthetic-1k.json", "utf8");

    expect(generated).toBe(committed);
    expect(createHash("sha256").update(generated).digest("hex")).toBe(
      "b2d8b5720cbeee532f3c08c8af52f8f8844456ecc6a56d7fb36b6c6bdca756c8",
    );
  });
});

describe("independent human-review overrides", () => {
  it("blocks executable locked-test live and claim-summary paths before calls", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "bakeoff-gate-test-"));
    const overridePath = join(tempDirectory, "reviews.json");
    const worksheet = generateLockedTestReviewWorksheet();
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

    try {
      const reviewArg = `--review-overrides=${overridePath}`;
      await expect(
        main(["--split=test", "--config=nano", reviewArg]),
      ).rejects.toThrow(/Human-review gate blocked a locked-test live run/);
      await expect(
        main([
          "--split=all",
          "--limit=100",
          "--config=nano",
          reviewArg,
        ]),
      ).rejects.toThrow(/Human-review gate blocked a locked-test live run/);
      await expect(main(["--claim-summary", reviewArg])).rejects.toThrow(
        /Human-review gate blocked a claim-bearing summary/,
      );
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("keeps generated intent unreviewed and blocks an incomplete locked test", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "bakeoff-empty-reviews-"));
    const overridePath = join(tempDirectory, "reviews.json");
    const worksheet = generateLockedTestReviewWorksheet();
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

    try {
      const selection = loadDataset(
        parseArgs(["--split=test", `--review-overrides=${overridePath}`]),
      );
      expect(selection.selectedReviewedCount).toBe(0);
      expect(humanReviewGateStatus(selection)).toMatchObject({
        complete: false,
        reviewed: 0,
        total: LOCKED_TEST_TICKET_COUNT,
      });
      expect(() =>
        enforceHumanReviewGate(selection, "a locked-test live run"),
      ).toThrow(/0\/150 selected labels/);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("merges a complete reviewer-authored override without mutating source intent", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "bakeoff-reviews-"));
    const overridePath = join(tempDirectory, "reviews.json");
    const worksheet = generateLockedTestReviewWorksheet();
    const sourceIntent = generateProductionDataset().sourceIntentLabels;
    const testLabels = sourceIntent.filter((label) => label.split === "test");
    const override = HumanReviewOverrideFileSchema.parse({
      schema_version: "human-review-overrides-v1",
      dataset_version: worksheet.dataset_version,
      dataset_sha256: worksheet.dataset_sha256,
      source_intent_sha256: worksheet.source_intent_sha256,
      locked_test_ticket_ids_sha256: worksheet.locked_test_ticket_ids_sha256,
      reviews: testLabels.map((label) => ({
        ticket_id: label.ticket_id,
        category: label.intended_category,
        priority: label.intended_priority,
        needs_human: label.intended_needs_human,
        review_status: "human_reviewed",
        reviewer: "independent-reviewer",
        reviewed_at: "2026-08-11T12:00:00-07:00",
      })),
    });
    writeFileSync(overridePath, `${JSON.stringify(override, null, 2)}\n`);

    try {
      const selection = loadDataset(
        parseArgs(["--split=test", `--review-overrides=${overridePath}`]),
      );
      expect(enforceHumanReviewGate(selection, "a claim summary")).toMatchObject(
        { complete: true, reviewed: 150, total: 150 },
      );
      expect(
        Array.from(selection.sourceIntent!.values()).every(
          (label) => label.review_status === "human_reviewed",
        ),
      ).toBe(true);
      expect(
        sourceIntent.every((label) => label.review_status === "unreviewed"),
      ).toBe(true);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("rejects review overrides with mismatched provenance", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "bakeoff-reviews-"));
    const overridePath = join(tempDirectory, "reviews.json");
    const worksheet = generateLockedTestReviewWorksheet();
    writeFileSync(
      overridePath,
      `${JSON.stringify({
        schema_version: "human-review-overrides-v1",
        dataset_version: worksheet.dataset_version,
        dataset_sha256: "0".repeat(64),
        source_intent_sha256: worksheet.source_intent_sha256,
        locked_test_ticket_ids_sha256:
          worksheet.locked_test_ticket_ids_sha256,
        reviews: [],
      })}\n`,
    );

    try {
      expect(() =>
        loadDataset(
          parseArgs(["--split=test", `--review-overrides=${overridePath}`]),
        ),
      ).toThrow(/override provenance mismatch/);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});

describe("canonical routed policy", () => {
  it("uses only confidence, P0/P1, and needs_human triggers", () => {
    expect(routingTriggers(decision("T-1", { confidence: 0.69 }))).toEqual([
      "confidence_below_0_7",
    ]);
    expect(routingTriggers(decision("T-1", { priority: "P1" }))).toEqual([
      "priority_p0_or_p1",
    ]);
    expect(routingTriggers(decision("T-1", { needs_human: true }))).toEqual([
      "needs_human",
    ]);
    expect(
      routingTriggers(decision("T-1", { category: "abuse" })),
    ).toEqual([]);
    expect(
      routingTriggers(decision("T-1", { category: "performance" })),
    ).toEqual([]);
  });

  it("composes routed output offline while preserving both decisions", () => {
    const nanoDecision = decision("T-1", {
      category: "auth",
      confidence: 0.5,
    });
    const sonnetDecision = decision("T-1", {
      category: "abuse",
      priority: "P0",
      needs_human: true,
    });
    const nano = result("T-1", MODELS.NEMOTRON_NANO, nanoDecision, 80);
    const sonnet = result("T-1", MODELS.CLAUDE_SONNET, sonnetDecision, 200);

    const [routed] = composeRoutedResults([nano], [sonnet]);

    expect(routed.primary_decision).toEqual(nanoDecision);
    expect(routed.final_decision).toEqual(sonnetDecision);
    expect(routed.routing_triggers).toEqual(["confidence_below_0_7"]);
    expect(routed.models_called).toEqual([
      MODELS.NEMOTRON_NANO,
      MODELS.CLAUDE_SONNET,
    ]);
    expect(routed.latency_ms).toBe(280);
    expect(routed.escalated).toBe(true);
  });
});

describe("cache rejection", () => {
  it("rejects legacy cache schemas", () => {
    const fixture = cacheFixture();
    fixture.envelope.cache_schema_version = "bakeoff-cache-v1";
    writeFileSync(fixture.path, JSON.stringify(fixture.envelope));

    try {
      expect(() =>
        readCache(fixture.selection, fixture.evaluation, "model-nano"),
      ).toThrow(/Incompatible cache/);
    } finally {
      rmSync(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("rejects incomplete cache provenance", () => {
    const fixture = cacheFixture();
    delete (fixture.envelope as Partial<typeof fixture.envelope>).run_id;
    writeFileSync(fixture.path, JSON.stringify(fixture.envelope));

    try {
      expect(() =>
        readCache(fixture.selection, fixture.evaluation, "model-nano"),
      ).toThrow(/Incomplete or malformed cache provenance/);
    } finally {
      rmSync(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("rejects tampered cached data", () => {
    const fixture = cacheFixture();
    fixture.envelope.data[0].ticket_id = "TAMPERED";
    writeFileSync(fixture.path, JSON.stringify(fixture.envelope));

    try {
      expect(() =>
        readCache(fixture.selection, fixture.evaluation, "model-nano"),
      ).toThrow(/Cached data hash mismatch/);
    } finally {
      rmSync(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", (data: PerTicketResult[]) => data.slice(0, -1)],
    [
      "duplicate",
      (data: PerTicketResult[]) => [...data.slice(0, -1), data[0]],
    ],
    [
      "unexpected",
      (data: PerTicketResult[]) => [
        ...data.slice(0, -1),
        result("UNEXPECTED", MODELS.NEMOTRON_NANO, decision("UNEXPECTED")),
      ],
    ],
  ])("rejects %s model records with otherwise valid provenance", (_, mutate) => {
    const fixture = cacheFixture();
    const malformedData = mutate(fixture.data);
    const envelope = createCacheEnvelope(
      "model-nano",
      fixture.evaluation,
      { createdAt: "2026-08-11T19:00:00.000Z", runId: "cache-test" },
      fixture.ticketIds,
      malformedData,
    );
    writeFileSync(fixture.path, JSON.stringify(envelope));

    try {
      expect(() =>
        readCache(fixture.selection, fixture.evaluation, "model-nano"),
      ).toThrow(/do not contain exactly one result for each selected ticket/);
    } finally {
      rmSync(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("rejects provenance-mismatched caches", () => {
    const fixture = cacheFixture();
    writeFileSync(fixture.path, JSON.stringify(fixture.envelope));
    const mismatchedEvaluation = buildEvaluationContext(
      fixture.selection,
      "us-east-1",
      "cache-test-revision",
    );

    try {
      expect(() =>
        readCache(fixture.selection, mismatchedEvaluation, "model-nano"),
      ).toThrow(/Cache provenance mismatch/);
    } finally {
      rmSync(fixture.tempDirectory, { recursive: true, force: true });
    }
  });
});

describe("evaluation provenance and metrics", () => {
  it("fingerprints dataset, IDs, models, policy, prompt, Region, pricing, and revision", () => {
    const selection = loadDataset(parseArgs([]));
    const west = buildEvaluationContext(selection, "us-west-2", "revision-a");
    const east = buildEvaluationContext(selection, "us-east-1", "revision-a");
    const revision = buildEvaluationContext(
      selection,
      "us-west-2",
      "revision-b",
    );

    expect(west.dataset.ticket_ids).toHaveLength(30);
    expect(west.dataset.source_intent_file_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(west.dataset.selected_source_intent_sha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(west.model_ids).toEqual(MODELS);
    expect(west.routing_policy).toContain("confidence < 0.7");
    expect(west.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(west.pricing_snapshot.version).toBeTruthy();
    expect(west.evaluation_fingerprint).not.toBe(
      east.evaluation_fingerprint,
    );
    expect(west.evaluation_fingerprint).not.toBe(
      revision.evaluation_fingerprint,
    );
  });

  it("reports joint agreement, recalls, escalations, latency, and estimated cost", () => {
    const labels = new Map<string, SourceIntentLabel>([
      [
        "T-1",
        SourceIntentLabelSchema.parse({
          ticket_id: "T-1",
          cohort: "high_risk",
          scenario_family: "security",
          intended_category: "abuse",
          intended_priority: "P0",
          intended_needs_human: true,
          split: "test",
          workshop_default: false,
          review_status: "human_reviewed",
        }),
      ],
      [
        "T-2",
        SourceIntentLabelSchema.parse({
          ticket_id: "T-2",
          cohort: "routine",
          scenario_family: "billing",
          intended_category: "billing",
          intended_priority: "P2",
          intended_needs_human: false,
          split: "test",
          workshop_default: false,
          review_status: "human_reviewed",
        }),
      ],
    ]);
    const first = result(
      "T-1",
      MODELS.CLAUDE_SONNET,
      decision("T-1", {
        category: "abuse",
        priority: "P0",
        needs_human: true,
      }),
      10,
    );
    first.escalated = true;
    first.models_called = [
      MODELS.NEMOTRON_NANO,
      MODELS.CLAUDE_SONNET,
    ];
    const second = result(
      "T-2",
      MODELS.NEMOTRON_NANO,
      decision("T-2", { category: "auth" }),
      100,
    );

    const summary = summarize("routed", [first, second], labels);

    expect(summary.source_intent_category_agreement).toBe(0.5);
    expect(summary.source_intent_joint_agreement).toBe(0.5);
    expect(summary.p0_p1_recall).toBe(1);
    expect(summary.human_review_recall).toBe(1);
    expect(summary.escalation_count).toBe(1);
    expect(summary.escalation_rate).toBe(0.5);
    expect(summary.p50_latency_ms).toBe(10);
    expect(summary.p95_latency_ms).toBe(100);
    expect(summary.total_estimated_comparative_cost_usd).toBe(0.002);
    expect(summary.per_model_calls).toEqual({
      [MODELS.NEMOTRON_NANO]: 2,
      [MODELS.CLAUDE_SONNET]: 1,
    });
    expect(summary.source_intent_metrics?.category_agreement).toMatchObject({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    });
    expect(
      summary.source_intent_metrics?.category_agreement.interval_95,
    ).toMatchObject({
      lower: expect.any(Number),
      upper: expect.any(Number),
      method: "scenario_family_cluster_bootstrap",
      clusters: 2,
    });
    expect(
      summary.source_intent_metrics!.category_agreement.interval_95!.lower,
    ).toBeLessThan(0.5);
    expect(
      summary.source_intent_metrics!.category_agreement.interval_95!.upper,
    ).toBeGreaterThan(0.5);
    expect(summary.cohort_breakdowns).toMatchObject({
      high_risk: { total: 1 },
      routine: { total: 1 },
    });
    expect(summary.confusion_counts?.category).toMatchObject({
      abuse: { abuse: 1 },
      billing: { auth: 1 },
    });
    expect(summary.error_counts).toMatchObject({
      category_mismatch: 1,
      priority_mismatch: 0,
      needs_human_mismatch: 0,
      joint_mismatch: 1,
      false_negative_p0_p1: 0,
      false_negative_needs_human: 0,
    });
  });
});
