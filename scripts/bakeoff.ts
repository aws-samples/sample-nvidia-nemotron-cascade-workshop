#!/usr/bin/env tsx
/**
 * Evaluation-integrity bake-off harness.
 *
 * Base-model live runs are paid and are cached only when every selected ticket
 * succeeds. Routed results are always composed offline from matching Nano and
 * Sonnet artifacts; the routed config never invokes Bedrock itself.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MODEL_TOKEN_PRICING,
  MODELS,
  PRICING_SNAPSHOT,
  estimateModelCostUsd,
  type ModelId,
} from "../lib/bedrock/models";
import { triageTicketWithUsage } from "../lib/bedrock/client";
import {
  JUDGE_PROMPT_VERSION,
  judgeTicket,
  type JudgeLabel,
} from "../lib/triage/judge";
import {
  TRIAGE_PROMPT_VERSION,
  TRIAGE_SYSTEM_PROMPT,
} from "../lib/triage/prompts";
import {
  HumanReviewOverrideFileSchema,
  RoutingDecisionSchema,
  SOURCE_INTENT_COHORTS,
  SourceIntentLabelSchema,
  TicketSchema,
  TRIAGE_TAXONOMY_VERSION,
  type RoutingDecision,
  type HumanReviewOverride,
  type SourceIntentLabel,
  type Ticket,
} from "../lib/triage/schema";
import {
  PRODUCTION_DATASET_VERSION,
  PRODUCTION_HUMAN_REVIEW_OVERRIDE_PATH,
} from "./generate-tickets";

export const DATASETS = {
  production: {
    path: "data/production-shaped-1k.json",
    sourceIntentPath: "data/production-shaped-1k.source-intent.json",
    reviewOverridePath: PRODUCTION_HUMAN_REVIEW_OVERRIDE_PATH,
    datasetVersion: PRODUCTION_DATASET_VERSION,
    description:
      "production-shaped (85% routine, 10% ambiguous, 5% high-risk)",
  },
  stress: {
    path: "data/synthetic-1k.json",
    sourceIntentPath: null,
    reviewOverridePath: null,
    datasetVersion: null,
    description: "stress/boundary profile (legacy synthetic-1k)",
  },
} as const;

export const DEFAULT_TICKET_LIMIT = 30;
export const CALIBRATION_TICKET_COUNT = 50;
export const LOCKED_TEST_TICKET_COUNT = 150;
export const HEADLINE_CONFIGS = ["sonnet", "nano", "routed"] as const;
export const EVALUATION_VERSION = "bakeoff-eval-v3";
export const CACHE_SCHEMA_VERSION = "bakeoff-cache-v3";
export const ROUTING_POLICY_VERSION = "workshop-routing-policy-v1";
export const ROUTING_POLICY_DESCRIPTION =
  "confidence < 0.7 OR priority is P0/P1 OR needs_human is true";
export const ROUTING_CONFIDENCE_THRESHOLD = 0.7;

const CACHE_DIR = ".bakeoff-cache/v3";
const CODE_REVISION_PATHS = [
  "lib/triage/schema.ts",
  "lib/triage/prompts.ts",
  "lib/triage/judge.ts",
  "scripts/generate-tickets.ts",
  "scripts/bakeoff.ts",
  "lib/bedrock/models.ts",
  "lib/bedrock/client.ts",
];

export type DatasetName = keyof typeof DATASETS;
export type ConfigName = "sonnet" | "nano" | "super" | "routed";
export type EvaluationSplit = "workshop" | "calibration" | "test" | "all";
export type RoutingTrigger =
  | "confidence_below_0_7"
  | "priority_p0_or_p1"
  | "needs_human";

type BaseConfigName = Exclude<ConfigName, "routed">;

export interface CliArgs {
  label: boolean;
  all: boolean;
  dryRun: boolean;
  experimentalSuper: boolean;
  fullDataset: boolean;
  help: boolean;
  claimSummary: boolean;
  dataset: DatasetName;
  split: EvaluationSplit;
  config: ConfigName | null;
  limit: number;
  limitExplicit: boolean;
  reviewOverridesPath: string | null;
}

export interface DatasetSelection {
  name: DatasetName;
  path: string;
  description: string;
  split: EvaluationSplit;
  tickets: Ticket[];
  sourceIntent: Map<string, SourceIntentLabel> | null;
  reviewOverridePath: string | null;
  reviewOverrideSha256: string | null;
  selectedReviewedCount: number;
  totalAvailable: number;
  datasetSha256: string;
  sourceIntentSha256: string | null;
  selectedTicketsSha256: string;
  selectedSourceIntentSha256: string | null;
  selectionFingerprint: string;
  cacheDir: string;
}

export interface EvaluationContext {
  evaluation_version: string;
  taxonomy_version: string;
  prompt_version: string;
  prompt_sha256: string;
  judge_prompt_version: string;
  routing_policy_version: string;
  routing_policy: string;
  dataset: {
    name: DatasetName;
    path: string;
    split: EvaluationSplit;
    file_sha256: string;
    source_intent_file_sha256: string | null;
    selected_tickets_sha256: string;
    selected_source_intent_sha256: string | null;
    ticket_ids: string[];
  };
  model_ids: typeof MODELS;
  aws_region: string;
  pricing_snapshot: {
    version: string;
    source: string;
    region: string;
    service_tier: string;
    usd_per_million_tokens: typeof MODEL_TOKEN_PRICING;
  };
  code_revision: string | null;
  evaluation_fingerprint: string;
}

export interface CacheEnvelope<T> {
  cache_schema_version: string;
  artifact: string;
  status: "complete";
  evaluation: EvaluationContext;
  created_at: string;
  run_id: string;
  ticket_ids: string[];
  record_count: number;
  failures: [];
  data_sha256: string;
  cache_fingerprint: string;
  data: T;
}

export interface PerTicketResult {
  ticket_id: string;
  decision: RoutingDecision;
  primary_decision: RoutingDecision;
  final_decision: RoutingDecision;
  primary_model: ModelId;
  final_model: ModelId;
  models_called: ModelId[];
  routing_triggers: RoutingTrigger[];
  latency_ms: number;
  input_token_count: number;
  output_token_count: number;
  token_count: number;
  estimated_comparative_cost_usd: number;
  escalated: boolean;
}

export interface RunSummary {
  config: ConfigName;
  total_tickets: number;
  failure_count: number;
  source_intent_category_agreement: number | null;
  source_intent_joint_agreement: number | null;
  p0_p1_recall: number | null;
  human_review_recall: number | null;
  opus_reference_category_agreement: number | null;
  opus_reference_joint_agreement: number | null;
  escalation_count: number;
  escalation_rate: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  total_estimated_comparative_cost_usd: number;
  per_model_calls: Record<string, number>;
  source_intent_metrics: SourceIntentMetrics | null;
  opus_reference_metrics: {
    category_agreement: ProportionMetric;
    joint_agreement: ProportionMetric;
  } | null;
  cohort_breakdowns: Record<string, CohortMetrics>;
  confusion_counts: ConfusionCounts | null;
  error_counts: ErrorCounts | null;
}

export interface ConfidenceInterval {
  lower: number;
  upper: number;
  method: "wilson" | "scenario_family_cluster_bootstrap";
  clusters?: number;
}

export interface ProportionMetric {
  numerator: number;
  denominator: number;
  rate: number | null;
  interval_95: ConfidenceInterval | null;
}

export interface SourceIntentMetrics {
  category_agreement: ProportionMetric;
  joint_agreement: ProportionMetric;
  p0_p1_recall: ProportionMetric;
  human_review_recall: ProportionMetric;
}

export interface CohortMetrics extends SourceIntentMetrics {
  total: number;
}

export interface ConfusionCounts {
  category: Record<string, Record<string, number>>;
  priority: Record<string, Record<string, number>>;
  needs_human: Record<string, Record<string, number>>;
}

export interface ErrorCounts {
  category_mismatch: number;
  priority_mismatch: number;
  needs_human_mismatch: number;
  joint_mismatch: number;
  false_negative_p0_p1: number;
  false_negative_needs_human: number;
}

interface RunIdentity {
  createdAt: string;
  runId: string;
}

interface RunFailure {
  ticket_id: string;
  message: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function optionValue(argv: string[], option: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${option}=`));
  if (inline) return inline.slice(option.length + 1);
  const index = argv.indexOf(option);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parseDataset(value: string | undefined): DatasetName {
  if (!value || value === "production" || value === "prod") {
    return "production";
  }
  if (
    value === "stress" ||
    value === "boundary" ||
    value === "synthetic-1k"
  ) {
    return "stress";
  }
  throw new Error(
    `Unknown dataset "${value}". Use --dataset=production or --dataset=stress.`,
  );
}

function parseSplit(value: string | undefined): EvaluationSplit {
  if (!value || value === "workshop") return "workshop";
  if (value === "calibration" || value === "test" || value === "all") {
    return value;
  }
  throw new Error(
    `Unknown split "${value}". Use workshop, calibration, test, or all.`,
  );
}

function parseConfig(value: string | undefined): ConfigName | null {
  if (!value) return null;
  if (
    value === "sonnet" ||
    value === "nano" ||
    value === "super" ||
    value === "routed"
  ) {
    return value;
  }
  throw new Error(
    `Unknown config "${value}". Use sonnet, nano, routed, or experimental super.`,
  );
}

function defaultLimitForSplit(split: EvaluationSplit): number {
  if (split === "calibration") return CALIBRATION_TICKET_COUNT;
  if (split === "test") return LOCKED_TEST_TICKET_COUNT;
  return DEFAULT_TICKET_LIMIT;
}

export function parseArgs(argv = process.argv.slice(2)): CliArgs {
  const fullDataset = argv.includes("--full-dataset");
  const splitValue = optionValue(argv, "--split");
  let split = parseSplit(splitValue);
  const limitValue = optionValue(argv, "--limit");
  const limitExplicit = limitValue !== undefined;
  if (fullDataset && limitExplicit) {
    throw new Error("Choose either --full-dataset or --limit, not both.");
  }
  if (fullDataset && splitValue && split !== "all") {
    throw new Error("--full-dataset can only be combined with --split=all.");
  }
  if (fullDataset) split = "all";
  if ((split === "calibration" || split === "test") && limitExplicit) {
    throw new Error(
      `${split} is a fixed evaluation split; do not combine --split=${split} with --limit.`,
    );
  }

  let limit = defaultLimitForSplit(split);
  if (limitValue !== undefined) {
    limit = Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("--limit must be a positive integer.");
    }
    if (limit >= 1000) {
      throw new Error(
        "Running all 1,000 tickets requires the explicit --full-dataset flag.",
      );
    }
  }

  const all = argv.includes("--all");
  const config = parseConfig(optionValue(argv, "--config"));
  const experimentalSuper = argv.includes("--experimental-super");
  if (all && config) {
    throw new Error("Choose either --all or --config, not both.");
  }
  if (config === "super" && !experimentalSuper) {
    throw new Error(
      "Nemotron Super is experimental. Add --experimental-super to run --config=super.",
    );
  }

  return {
    label: argv.includes("--label"),
    all,
    claimSummary: argv.includes("--claim-summary"),
    dryRun: argv.includes("--dry-run"),
    experimentalSuper,
    fullDataset,
    help: argv.includes("--help") || argv.includes("-h"),
    dataset: parseDataset(optionValue(argv, "--dataset")),
    split,
    config,
    limit,
    limitExplicit,
    reviewOverridesPath:
      optionValue(argv, "--review-overrides") ?? null,
  };
}

export function resolveConfigs(args: CliArgs): ConfigName[] {
  if (args.all) {
    return args.experimentalSuper
      ? [...HEADLINE_CONFIGS, "super"]
      : [...HEADLINE_CONFIGS];
  }
  return [args.config ?? "routed"];
}

function readSourceIntent(
  path: string | null,
): { labels: Map<string, SourceIntentLabel>; sha256: string } | null {
  if (!path) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON array of source-intent labels.`);
  }
  const labels = parsed.map((label) => SourceIntentLabelSchema.parse(label));
  const byId = new Map(labels.map((label) => [label.ticket_id, label]));
  if (byId.size !== labels.length) {
    throw new Error(`${path} contains duplicate ticket_id values.`);
  }
  return { labels: byId, sha256: sha256(raw) };
}

function readHumanReviewOverrides(
  path: string | null,
  datasetVersion: string | null,
  datasetSha256: string,
  sourceIntentSha256: string | null,
  sourceIntent: Map<string, SourceIntentLabel> | null,
): {
  reviews: Map<
    string,
    HumanReviewOverride
  >;
  sha256: string;
} | null {
  if (!path || !existsSync(path)) return null;
  if (!datasetVersion || !sourceIntentSha256 || !sourceIntent) {
    throw new Error(`${path} cannot be used with a dataset without source intent.`);
  }
  const raw = readFileSync(path, "utf8");
  const parsed = HumanReviewOverrideFileSchema.parse(JSON.parse(raw));
  const lockedTestIds = Array.from(sourceIntent.values())
    .filter((label) => label.split === "test")
    .map((label) => label.ticket_id);
  if (
    parsed.dataset_version !== datasetVersion ||
    parsed.dataset_sha256 !== datasetSha256 ||
    parsed.source_intent_sha256 !== sourceIntentSha256 ||
    parsed.locked_test_ticket_ids_sha256 !==
      sha256(JSON.stringify(lockedTestIds))
  ) {
    throw new Error(
      `Human-review override provenance mismatch at ${path}; regenerate the worksheet and rebase reviews onto the current immutable source intent.`,
    );
  }
  const reviews = new Map(
    parsed.reviews.map((review) => [review.ticket_id, review]),
  );
  if (reviews.size !== parsed.reviews.length) {
    throw new Error(`${path} contains duplicate review ticket_id values.`);
  }
  for (const ticketId of reviews.keys()) {
    if (!sourceIntent.has(ticketId)) {
      throw new Error(`${path} contains a review for unknown ticket ${ticketId}.`);
    }
  }
  return { reviews, sha256: sha256(raw) };
}

export interface HumanReviewGateStatus {
  complete: boolean;
  reviewed: number;
  total: number;
  missingTicketIds: string[];
  overridePath: string | null;
}

export function humanReviewGateStatus(
  selection: DatasetSelection,
): HumanReviewGateStatus {
  const labels = selection.sourceIntent
    ? Array.from(selection.sourceIntent.values())
    : [];
  const missingTicketIds = labels
    .filter((label) => label.review_status === "unreviewed")
    .map((label) => label.ticket_id);
  return {
    complete: labels.length > 0 && missingTicketIds.length === 0,
    reviewed: labels.length - missingTicketIds.length,
    total: labels.length,
    missingTicketIds,
    overridePath: selection.reviewOverridePath,
  };
}

export function enforceHumanReviewGate(
  selection: DatasetSelection,
  purpose: string,
): HumanReviewGateStatus {
  const status = humanReviewGateStatus(selection);
  if (status.complete) return status;
  const sample = status.missingTicketIds.slice(0, 10).join(", ");
  throw new Error(
    [
      `Human-review gate blocked ${purpose}: ${status.reviewed}/${status.total} selected labels are reviewed or adjudicated.`,
      `Complete the deterministic worksheet and record independent overrides in ${status.overridePath ?? "a --review-overrides file"}.`,
      sample
        ? `First missing ticket IDs: ${sample}${status.missingTicketIds.length > 10 ? ", ..." : ""}`
        : "This dataset has no reviewable source-intent labels.",
      "Generated source intent must remain unedited; regeneration intentionally does not overwrite the review override file.",
    ].join("\n"),
  );
}

export function loadDataset(args: CliArgs): DatasetSelection {
  const dataset = DATASETS[args.dataset];
  const rawDataset = readFileSync(dataset.path, "utf8");
  const parsed = JSON.parse(rawDataset) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${dataset.path} must contain a JSON array of tickets.`);
  }
  const allTickets = parsed.map((ticket) => TicketSchema.parse(ticket));
  const allById = new Map(allTickets.map((ticket) => [ticket.id, ticket]));
  if (allById.size !== allTickets.length) {
    throw new Error(`${dataset.path} contains duplicate ticket IDs.`);
  }
  const sourceIntentArtifact = readSourceIntent(dataset.sourceIntentPath);
  const allSourceIntent = sourceIntentArtifact?.labels ?? null;
  const datasetSha256 = sha256(rawDataset);
  const reviewOverridePath =
    args.reviewOverridesPath ?? dataset.reviewOverridePath;
  const reviewArtifact = readHumanReviewOverrides(
    reviewOverridePath,
    dataset.datasetVersion,
    datasetSha256,
    sourceIntentArtifact?.sha256 ?? null,
    allSourceIntent,
  );

  let candidates: Ticket[];
  if (args.split === "calibration" || args.split === "test") {
    if (!allSourceIntent) {
      throw new Error(
        `${args.dataset} has no source-intent metadata for --split=${args.split}.`,
      );
    }
    candidates = allTickets.filter(
      (ticket) => allSourceIntent.get(ticket.id)?.split === args.split,
    );
  } else if (args.split === "workshop" && allSourceIntent) {
    candidates = allTickets.filter(
      (ticket) => allSourceIntent.get(ticket.id)?.workshop_default === true,
    );
  } else {
    candidates = allTickets;
  }

  const requested = args.fullDataset ? candidates.length : args.limit;
  if (requested > candidates.length) {
    throw new Error(
      `Requested ${requested} tickets, but split ${args.split} has ${candidates.length}.`,
    );
  }
  const tickets = candidates.slice(0, requested);
  const selectedGeneratedSourceIntent = allSourceIntent
    ? new Map(
        tickets.map((ticket) => {
          const label = allSourceIntent.get(ticket.id);
          if (!label) {
            throw new Error(`Missing source-intent label for ${ticket.id}.`);
          }
          return [ticket.id, label];
        }),
      )
    : null;
  const sourceIntent = selectedGeneratedSourceIntent
    ? new Map(
        Array.from(selectedGeneratedSourceIntent.entries()).map(
          ([ticketId, label]) => {
            const review = reviewArtifact?.reviews.get(ticketId);
            return [
              ticketId,
              review
                ? {
                    ...label,
                    intended_category: review.category,
                    intended_priority: review.priority,
                    intended_needs_human: review.needs_human,
                    review_status: review.review_status,
                  }
                : label,
            ];
          },
        ),
      )
    : null;
  const selectedTicketsSha256 = sha256(stableJson(tickets));
  const selectedSourceIntentSha256 = selectedGeneratedSourceIntent
    ? sha256(stableJson(Array.from(selectedGeneratedSourceIntent.values())))
    : null;
  const selectionFingerprint = sha256(
    stableJson({
      dataset: args.dataset,
      split: args.split,
      datasetSha256,
      sourceIntentSha256: sourceIntentArtifact?.sha256 ?? null,
      selectedTicketsSha256,
      selectedSourceIntentSha256,
      ticketIds: tickets.map((ticket) => ticket.id),
    }),
  );

  return {
    name: args.dataset,
    path: dataset.path,
    description: dataset.description,
    split: args.split,
    tickets,
    sourceIntent,
    reviewOverridePath,
    reviewOverrideSha256: reviewArtifact?.sha256 ?? null,
    selectedReviewedCount: sourceIntent
      ? Array.from(sourceIntent.values()).filter(
          (label) => label.review_status !== "unreviewed",
        ).length
      : 0,
    totalAvailable: allTickets.length,
    datasetSha256,
    sourceIntentSha256: sourceIntentArtifact?.sha256 ?? null,
    selectedTicketsSha256,
    selectedSourceIntentSha256,
    selectionFingerprint,
    cacheDir: join(
      CACHE_DIR,
      args.dataset,
      `${args.split}-${tickets.length}-${selectionFingerprint.slice(0, 16)}`,
    ),
  };
}

function resolveCodeRevision(): string | null {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const diff = execFileSync(
      "git",
      ["diff", "--no-ext-diff", "HEAD", "--", ...CODE_REVISION_PATHS],
      { encoding: "utf8" },
    );
    return diff ? `${head}-dirty-${sha256(diff).slice(0, 16)}` : head;
  } catch {
    return null;
  }
}

export function buildEvaluationContext(
  selection: DatasetSelection,
  region = process.env.AWS_REGION ?? "us-west-2",
  codeRevision = resolveCodeRevision(),
): EvaluationContext {
  const withoutFingerprint = {
    evaluation_version: EVALUATION_VERSION,
    taxonomy_version: TRIAGE_TAXONOMY_VERSION,
    prompt_version: TRIAGE_PROMPT_VERSION,
    prompt_sha256: sha256(TRIAGE_SYSTEM_PROMPT),
    judge_prompt_version: JUDGE_PROMPT_VERSION,
    routing_policy_version: ROUTING_POLICY_VERSION,
    routing_policy: ROUTING_POLICY_DESCRIPTION,
    dataset: {
      name: selection.name,
      path: selection.path,
      split: selection.split,
      file_sha256: selection.datasetSha256,
      source_intent_file_sha256: selection.sourceIntentSha256,
      selected_tickets_sha256: selection.selectedTicketsSha256,
      selected_source_intent_sha256:
        selection.selectedSourceIntentSha256,
      ticket_ids: selection.tickets.map((ticket) => ticket.id),
    },
    model_ids: MODELS,
    aws_region: region,
    pricing_snapshot: {
      version: PRICING_SNAPSHOT.version,
      source: PRICING_SNAPSHOT.source,
      region: PRICING_SNAPSHOT.region,
      service_tier: PRICING_SNAPSHOT.serviceTier,
      usd_per_million_tokens: MODEL_TOKEN_PRICING,
    },
    code_revision: codeRevision,
  };
  return {
    ...withoutFingerprint,
    evaluation_fingerprint: sha256(stableJson(withoutFingerprint)),
  };
}

export function cachePath(
  selection: DatasetSelection,
  artifact: string,
): string {
  return join(selection.cacheDir, `${artifact}.json`);
}

function cacheFingerprint<T>(
  envelope: Omit<CacheEnvelope<T>, "cache_fingerprint" | "data">,
): string {
  return sha256(stableJson(envelope));
}

export function createCacheEnvelope<T>(
  artifact: string,
  evaluation: EvaluationContext,
  identity: RunIdentity,
  ticketIds: string[],
  data: T,
): CacheEnvelope<T> {
  const provenance = {
    cache_schema_version: CACHE_SCHEMA_VERSION,
    artifact,
    status: "complete" as const,
    evaluation,
    created_at: identity.createdAt,
    run_id: identity.runId,
    ticket_ids: ticketIds,
    record_count: ticketIds.length,
    failures: [] as [],
    data_sha256: sha256(stableJson(data)),
  };
  return {
    ...provenance,
    cache_fingerprint: cacheFingerprint(provenance),
    data,
  };
}

function validateModelCacheRecordCoverage(
  artifact: string,
  data: unknown,
  expectedIds: string[],
  path: string,
) {
  if (!artifact.startsWith("model-")) return;
  if (!Array.isArray(data)) {
    throw new Error(`Cached model records are malformed at ${path}.`);
  }

  const actualIds = data.map((record) =>
    record && typeof record === "object" && "ticket_id" in record
      ? (record as { ticket_id?: unknown }).ticket_id
      : null,
  );
  if (
    actualIds.some((ticketId) => typeof ticketId !== "string") ||
    stableJson(actualIds) !== stableJson(expectedIds)
  ) {
    throw new Error(
      `Cached model records at ${path} do not contain exactly one result for each selected ticket in order (${actualIds.length}/${expectedIds.length}).`,
    );
  }
}

export function readCache<T>(
  selection: DatasetSelection,
  evaluation: EvaluationContext,
  artifact: string,
): CacheEnvelope<T> | null {
  const path = cachePath(selection, artifact);
  if (!existsSync(path)) return null;
  const envelope = JSON.parse(readFileSync(path, "utf8")) as Partial<
    CacheEnvelope<T>
  >;
  if (envelope.cache_schema_version !== CACHE_SCHEMA_VERSION) {
    throw new Error(
      `Incompatible cache at ${path}; expected ${CACHE_SCHEMA_VERSION}. Existing paid caches must not be reused under the new evaluation contract.`,
    );
  }
  if (
    envelope.artifact !== artifact ||
    envelope.status !== "complete" ||
    !envelope.evaluation ||
    !envelope.created_at ||
    !envelope.run_id ||
    !Array.isArray(envelope.ticket_ids) ||
    !Array.isArray(envelope.failures) ||
    envelope.failures.length !== 0 ||
    typeof envelope.data_sha256 !== "string" ||
    typeof envelope.cache_fingerprint !== "string"
  ) {
    throw new Error(`Incomplete or malformed cache provenance at ${path}.`);
  }
  const expectedIds = selection.tickets.map((ticket) => ticket.id);
  if (
    envelope.evaluation.evaluation_fingerprint !==
      evaluation.evaluation_fingerprint ||
    stableJson(envelope.ticket_ids) !== stableJson(expectedIds) ||
    envelope.record_count !== expectedIds.length
  ) {
    throw new Error(
      `Cache provenance mismatch at ${path}; dataset, IDs, models, prompt, policy, eval version, Region, pricing, or code revision changed.`,
    );
  }
  const provenance = {
    cache_schema_version: envelope.cache_schema_version,
    artifact: envelope.artifact,
    status: envelope.status,
    evaluation: envelope.evaluation,
    created_at: envelope.created_at,
    run_id: envelope.run_id,
    ticket_ids: envelope.ticket_ids,
    record_count: envelope.record_count,
    failures: envelope.failures as [],
    data_sha256: envelope.data_sha256,
  };
  if (cacheFingerprint(provenance) !== envelope.cache_fingerprint) {
    throw new Error(`Cache fingerprint mismatch at ${path}.`);
  }
  if (sha256(stableJson(envelope.data)) !== envelope.data_sha256) {
    throw new Error(`Cached data hash mismatch at ${path}.`);
  }
  validateModelCacheRecordCoverage(
    artifact,
    envelope.data,
    expectedIds,
    path,
  );
  return envelope as CacheEnvelope<T>;
}

function writeCache<T>(
  selection: DatasetSelection,
  envelope: CacheEnvelope<T>,
) {
  mkdirSync(selection.cacheDir, { recursive: true });
  writeFileSync(
    cachePath(selection, envelope.artifact),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
}

function artifactForConfig(config: BaseConfigName): string {
  return `model-${config}`;
}

function modelForConfig(config: BaseConfigName): ModelId {
  if (config === "nano") return MODELS.NEMOTRON_NANO;
  if (config === "sonnet") return MODELS.CLAUDE_SONNET;
  return MODELS.NEMOTRON_SUPER;
}

export function routingTriggers(decision: RoutingDecision): RoutingTrigger[] {
  const triggers: RoutingTrigger[] = [];
  if (decision.confidence < ROUTING_CONFIDENCE_THRESHOLD) {
    triggers.push("confidence_below_0_7");
  }
  if (decision.priority === "P0" || decision.priority === "P1") {
    triggers.push("priority_p0_or_p1");
  }
  if (decision.needs_human) triggers.push("needs_human");
  return triggers;
}

async function callOnce(
  ticket: Ticket,
  modelId: ModelId,
): Promise<PerTicketResult> {
  const start = Date.now();
  const { decision, usage } = await triageTicketWithUsage(ticket, { modelId });
  if (decision.ticket_id !== ticket.id) {
    throw new Error(
      `Model ${modelId} returned ticket_id=${decision.ticket_id}; expected ${ticket.id}.`,
    );
  }
  const latency = Date.now() - start;
  if (!usage) {
    throw new Error(
      `Model ${modelId} did not return token usage; claim-bearing cost calculation requires actual input/output usage.`,
    );
  }
  return {
    ticket_id: ticket.id,
    decision,
    primary_decision: decision,
    final_decision: decision,
    primary_model: modelId,
    final_model: modelId,
    models_called: [modelId],
    routing_triggers: [],
    latency_ms: latency,
    input_token_count: usage.inputTokens,
    output_token_count: usage.outputTokens,
    token_count: usage.totalTokens,
    estimated_comparative_cost_usd: estimateModelCostUsd(modelId, usage),
    escalated: false,
  };
}

function validateResults(
  results: PerTicketResult[],
  expectedIds: string[],
  label: string,
): PerTicketResult[] {
  const actualIds = results.map((result) => result.ticket_id);
  if (stableJson(actualIds) !== stableJson(expectedIds)) {
    throw new Error(
      `${label} does not contain the identical ordered comparison set (${actualIds.length}/${expectedIds.length}).`,
    );
  }
  for (const result of results) {
    RoutingDecisionSchema.parse(result.primary_decision);
    RoutingDecisionSchema.parse(result.final_decision);
    RoutingDecisionSchema.parse(result.decision);
  }
  return results;
}

function formatFailures(config: string, failures: RunFailure[]): string {
  return [
    `${config} failed for ${failures.length} ticket(s); no cache was written.`,
    ...failures.map(
      (failure) => `  ${failure.ticket_id}: ${failure.message.slice(0, 300)}`,
    ),
  ].join("\n");
}

async function runBaseConfig(
  config: BaseConfigName,
  selection: DatasetSelection,
  evaluation: EvaluationContext,
  dryRun: boolean,
  identity: RunIdentity,
): Promise<PerTicketResult[]> {
  const artifact = artifactForConfig(config);
  const expectedIds = selection.tickets.map((ticket) => ticket.id);
  if (dryRun) {
    const cached = readCache<PerTicketResult[]>(
      selection,
      evaluation,
      artifact,
    );
    if (!cached) {
      throw new Error(
        `No complete matching ${config} cache at ${cachePath(selection, artifact)}. Dry-run never calls Bedrock.`,
      );
    }
    return validateResults(cached.data, expectedIds, `${config} cache`);
  }

  const modelId = modelForConfig(config);
  const results: PerTicketResult[] = [];
  const failures: RunFailure[] = [];
  for (const [index, ticket] of selection.tickets.entries()) {
    if (index % 10 === 0) {
      process.stdout.write(
        `  ${config}: ${index}/${selection.tickets.length}\r`,
      );
    }
    try {
      results.push(await callOnce(ticket, modelId));
    } catch (error) {
      failures.push({
        ticket_id: ticket.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  process.stdout.write("\n");
  if (failures.length > 0) {
    throw new Error(formatFailures(config, failures));
  }
  validateResults(results, expectedIds, `${config} live run`);
  writeCache(
    selection,
    createCacheEnvelope(artifact, evaluation, identity, expectedIds, results),
  );
  console.log(`  ${config}: ${results.length}/${expectedIds.length} complete`);
  return results;
}

function readRequiredBaseCache(
  config: "nano" | "sonnet",
  selection: DatasetSelection,
  evaluation: EvaluationContext,
): PerTicketResult[] {
  const artifact = artifactForConfig(config);
  const cached = readCache<PerTicketResult[]>(selection, evaluation, artifact);
  if (!cached) {
    throw new Error(
      [
        "Routed-only evaluation requires matching complete Nano and Sonnet caches.",
        `Missing ${config}: ${cachePath(selection, artifact)}`,
        "Legacy .bakeoff-cache/run-* and production/*/run-* artifacts are intentionally incompatible with bakeoff-cache-v2 and will not be reused.",
      ].join("\n"),
    );
  }
  return validateResults(
    cached.data,
    selection.tickets.map((ticket) => ticket.id),
    `${config} routed prerequisite`,
  );
}

export function composeRoutedResults(
  nanoResults: PerTicketResult[],
  sonnetResults: PerTicketResult[],
): PerTicketResult[] {
  const nanoIds = nanoResults.map((result) => result.ticket_id);
  const sonnetIds = sonnetResults.map((result) => result.ticket_id);
  if (stableJson(nanoIds) !== stableJson(sonnetIds)) {
    throw new Error(
      "Nano and Sonnet caches do not contain the identical ordered comparison set.",
    );
  }
  return nanoResults.map((nanoResult, index) => {
    const sonnetResult = sonnetResults[index];
    const triggers = routingTriggers(nanoResult.final_decision);
    if (triggers.length === 0) {
      return {
        ...nanoResult,
        decision: nanoResult.final_decision,
        routing_triggers: [],
        escalated: false,
      };
    }
    return {
      ticket_id: nanoResult.ticket_id,
      decision: sonnetResult.final_decision,
      primary_decision: nanoResult.final_decision,
      final_decision: sonnetResult.final_decision,
      primary_model: MODELS.NEMOTRON_NANO,
      final_model: MODELS.CLAUDE_SONNET,
      models_called: [MODELS.NEMOTRON_NANO, MODELS.CLAUDE_SONNET],
      routing_triggers: triggers,
      latency_ms: nanoResult.latency_ms + sonnetResult.latency_ms,
      input_token_count:
        nanoResult.input_token_count + sonnetResult.input_token_count,
      output_token_count:
        nanoResult.output_token_count + sonnetResult.output_token_count,
      token_count: nanoResult.token_count + sonnetResult.token_count,
      estimated_comparative_cost_usd:
        nanoResult.estimated_comparative_cost_usd +
        sonnetResult.estimated_comparative_cost_usd,
      escalated: true,
    };
  });
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.ceil((percentileValue / 100) * sorted.length) - 1,
  );
  return sorted[index];
}

export function wilson95(
  numerator: number,
  denominator: number,
): ConfidenceInterval | null {
  if (denominator === 0) return null;
  const z = 1.959963984540054;
  const rate = numerator / denominator;
  const zSquared = z * z;
  const denominatorAdjustment = 1 + zSquared / denominator;
  const center = (rate + zSquared / (2 * denominator)) / denominatorAdjustment;
  const margin =
    (z / denominatorAdjustment) *
    Math.sqrt(
      (rate * (1 - rate)) / denominator +
        zSquared / (4 * denominator * denominator),
    );
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    method: "wilson",
  };
}

function proportion(
  numerator: number,
  denominator: number,
  interval95 = wilson95(numerator, denominator),
): ProportionMetric {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : null,
    interval_95: interval95,
  };
}

interface MetricCounts {
  total: number;
  categoryAgree: number;
  jointAgree: number;
  highPriorityExpected: number;
  highPriorityRecalled: number;
  humanExpected: number;
  humanRecalled: number;
}

interface SourceAccumulator extends MetricCounts {
  familyCounts: Map<string, MetricCounts>;
  confusion: ConfusionCounts;
  errors: ErrorCounts;
}

function metricCounts(): MetricCounts {
  return {
    total: 0,
    categoryAgree: 0,
    jointAgree: 0,
    highPriorityExpected: 0,
    highPriorityRecalled: 0,
    humanExpected: 0,
    humanRecalled: 0,
  };
}

function sourceAccumulator(): SourceAccumulator {
  return {
    ...metricCounts(),
    familyCounts: new Map(),
    confusion: { category: {}, priority: {}, needs_human: {} },
    errors: {
      category_mismatch: 0,
      priority_mismatch: 0,
      needs_human_mismatch: 0,
      joint_mismatch: 0,
      false_negative_p0_p1: 0,
      false_negative_needs_human: 0,
    },
  };
}

function incrementConfusion(
  matrix: Record<string, Record<string, number>>,
  expected: string,
  actual: string,
) {
  matrix[expected] ??= {};
  matrix[expected][actual] = (matrix[expected][actual] ?? 0) + 1;
}

function recordSourceResult(
  accumulator: SourceAccumulator,
  source: SourceIntentLabel,
  decision: RoutingDecision,
) {
  accumulator.total++;
  const categoryMatches = source.intended_category === decision.category;
  const priorityMatches = source.intended_priority === decision.priority;
  const humanMatches = source.intended_needs_human === decision.needs_human;
  if (categoryMatches) accumulator.categoryAgree++;
  else accumulator.errors.category_mismatch++;
  if (!priorityMatches) accumulator.errors.priority_mismatch++;
  if (!humanMatches) accumulator.errors.needs_human_mismatch++;
  if (categoryMatches && priorityMatches && humanMatches) {
    accumulator.jointAgree++;
  } else {
    accumulator.errors.joint_mismatch++;
  }
  incrementConfusion(
    accumulator.confusion.category,
    source.intended_category,
    decision.category,
  );
  incrementConfusion(
    accumulator.confusion.priority,
    source.intended_priority,
    decision.priority,
  );
  incrementConfusion(
    accumulator.confusion.needs_human,
    String(source.intended_needs_human),
    String(decision.needs_human),
  );
  const expectedHighPriority =
    source.intended_priority === "P0" || source.intended_priority === "P1";
  if (expectedHighPriority) {
    accumulator.highPriorityExpected++;
    if (decision.priority === "P0" || decision.priority === "P1") {
      accumulator.highPriorityRecalled++;
    } else {
      accumulator.errors.false_negative_p0_p1++;
    }
  }
  if (source.intended_needs_human) {
    accumulator.humanExpected++;
    if (decision.needs_human) accumulator.humanRecalled++;
    else accumulator.errors.false_negative_needs_human++;
  }

  const family = accumulator.familyCounts.get(source.scenario_family) ?? metricCounts();
  family.total++;
  if (categoryMatches) family.categoryAgree++;
  if (categoryMatches && priorityMatches && humanMatches) family.jointAgree++;
  if (expectedHighPriority) {
    family.highPriorityExpected++;
    if (decision.priority === "P0" || decision.priority === "P1") {
      family.highPriorityRecalled++;
    }
  }
  if (source.intended_needs_human) {
    family.humanExpected++;
    if (decision.needs_human) family.humanRecalled++;
  }
  accumulator.familyCounts.set(source.scenario_family, family);
}

function scenarioFamilyClusterBootstrap95(
  families: MetricCounts[],
  numeratorKey: keyof MetricCounts,
  denominatorKey: keyof MetricCounts,
): ConfidenceInterval | null {
  if (families.length < 2) return null;

  const rates: number[] = [];
  let state = 0x5eed1234;
  const nextIndex = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    const uniform = ((mixed ^ (mixed >>> 14)) >>> 0) / 0x100000000;
    return Math.floor(uniform * families.length);
  };
  for (let iteration = 0; iteration < 5000; iteration++) {
    let numerator = 0;
    let denominator = 0;
    for (let draw = 0; draw < families.length; draw++) {
      const family = families[nextIndex()];
      numerator += family[numeratorKey];
      denominator += family[denominatorKey];
    }
    if (denominator > 0) rates.push(numerator / denominator);
  }
  if (rates.length === 0) return null;
  rates.sort((left, right) => left - right);
  const lowerIndex = Math.floor(0.025 * (rates.length - 1));
  const upperIndex = Math.ceil(0.975 * (rates.length - 1));
  return {
    lower: rates[lowerIndex],
    upper: rates[upperIndex],
    method: "scenario_family_cluster_bootstrap",
    clusters: families.length,
  };
}

function clusteredProportion(
  accumulator: SourceAccumulator,
  numeratorKey: keyof MetricCounts,
  denominatorKey: keyof MetricCounts,
): ProportionMetric {
  return proportion(
    accumulator[numeratorKey],
    accumulator[denominatorKey],
    scenarioFamilyClusterBootstrap95(
      Array.from(accumulator.familyCounts.values()),
      numeratorKey,
      denominatorKey,
    ),
  );
}

function sourceMetrics(accumulator: SourceAccumulator): SourceIntentMetrics {
  return {
    category_agreement: clusteredProportion(
      accumulator,
      "categoryAgree",
      "total",
    ),
    joint_agreement: clusteredProportion(
      accumulator,
      "jointAgree",
      "total",
    ),
    p0_p1_recall: clusteredProportion(
      accumulator,
      "highPriorityRecalled",
      "highPriorityExpected",
    ),
    human_review_recall: clusteredProportion(
      accumulator,
      "humanRecalled",
      "humanExpected",
    ),
  };
}

export function summarize(
  config: ConfigName,
  results: PerTicketResult[],
  sourceIntent: Map<string, SourceIntentLabel> | null,
  opusReference: Map<string, JudgeLabel> | null = null,
): RunSummary {
  const perModel: Record<string, number> = {};
  let estimatedCost = 0;
  let escalations = 0;
  const source = sourceAccumulator();
  const cohorts = new Map(
    SOURCE_INTENT_COHORTS.map((cohort) => [cohort, sourceAccumulator()]),
  );
  let opusCategoryAgree = 0;
  let opusJointAgree = 0;
  let opusEvaluated = 0;

  for (const result of results) {
    for (const model of result.models_called) {
      perModel[model] = (perModel[model] ?? 0) + 1;
    }
    estimatedCost += result.estimated_comparative_cost_usd;
    if (result.escalated) escalations++;
    const sourceLabel = sourceIntent?.get(result.ticket_id);
    if (sourceLabel) {
      recordSourceResult(source, sourceLabel, result.final_decision);
      recordSourceResult(
        cohorts.get(sourceLabel.cohort)!,
        sourceLabel,
        result.final_decision,
      );
    }
    const opus = opusReference?.get(result.ticket_id);
    if (opus) {
      opusEvaluated++;
      if (opus.category === result.final_decision.category) {
        opusCategoryAgree++;
      }
      if (
        opus.category === result.final_decision.category &&
        opus.priority === result.final_decision.priority &&
        opus.needs_human === result.final_decision.needs_human
      ) {
        opusJointAgree++;
      }
    }
  }

  const metrics = source.total > 0 ? sourceMetrics(source) : null;
  const cohortBreakdowns = Object.fromEntries(
    Array.from(cohorts.entries())
      .filter(([, accumulator]) => accumulator.total > 0)
      .map(([cohort, accumulator]) => [
        cohort,
        { total: accumulator.total, ...sourceMetrics(accumulator) },
      ]),
  );
  return {
    config,
    total_tickets: results.length,
    failure_count: 0,
    source_intent_category_agreement:
      metrics?.category_agreement.rate ?? null,
    source_intent_joint_agreement: metrics?.joint_agreement.rate ?? null,
    p0_p1_recall: metrics?.p0_p1_recall.rate ?? null,
    human_review_recall: metrics?.human_review_recall.rate ?? null,
    opus_reference_category_agreement:
      opusEvaluated > 0 ? opusCategoryAgree / opusEvaluated : null,
    opus_reference_joint_agreement:
      opusEvaluated > 0 ? opusJointAgree / opusEvaluated : null,
    escalation_count: escalations,
    escalation_rate: results.length > 0 ? escalations / results.length : 0,
    p50_latency_ms: percentile(
      results.map((result) => result.latency_ms),
      50,
    ),
    p95_latency_ms: percentile(
      results.map((result) => result.latency_ms),
      95,
    ),
    total_estimated_comparative_cost_usd: estimatedCost,
    per_model_calls: perModel,
    source_intent_metrics: metrics,
    opus_reference_metrics:
      opusEvaluated > 0
        ? {
            category_agreement: proportion(opusCategoryAgree, opusEvaluated),
            joint_agreement: proportion(opusJointAgree, opusEvaluated),
          }
        : null,
    cohort_breakdowns: cohortBreakdowns,
    confusion_counts: source.total > 0 ? source.confusion : null,
    error_counts: source.total > 0 ? source.errors : null,
  };
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function proportionWithInterval(metric: ProportionMetric | undefined): string {
  if (!metric || metric.rate === null) return "n/a";
  if (!metric.interval_95) {
    return `${percent(metric.rate)} (n=${metric.denominator}; interval unavailable)`;
  }
  const clusterCount = metric.interval_95.clusters
    ? `; ${metric.interval_95.clusters} scenario families`
    : "";
  return `${percent(metric.rate)} [${percent(metric.interval_95.lower)}, ${percent(metric.interval_95.upper)}] (n=${metric.denominator}${clusterCount})`;
}

function printTables(summaries: RunSummary[], claimSummary: boolean) {
  console.log(
    claimSummary
      ? "\nClaim-bearing quality summary against independently reviewed labels"
      : "\nDEVELOPMENT ONLY: quality against synthetic or incompletely reviewed source intent",
  );
  console.table(
    summaries.map((summary) => ({
      config: summary.config,
      tickets: summary.total_tickets,
      failures: summary.failure_count,
      "category agreement (family-clustered 95%)": proportionWithInterval(
        summary.source_intent_metrics?.category_agreement,
      ),
      "joint agreement (family-clustered 95%)": proportionWithInterval(
        summary.source_intent_metrics?.joint_agreement,
      ),
      "P0/P1 recall (family-clustered 95%)": proportionWithInterval(
        summary.source_intent_metrics?.p0_p1_recall,
      ),
      "human-review recall (family-clustered 95%)": proportionWithInterval(
        summary.source_intent_metrics?.human_review_recall,
      ),
      "Opus reference agreement": percent(
        summary.opus_reference_category_agreement,
      ),
    })),
  );
  console.log("Cohort breakdowns");
  console.table(
    summaries.flatMap((summary) =>
      Object.entries(summary.cohort_breakdowns).map(([cohort, metrics]) => ({
        config: summary.config,
        cohort,
        tickets: metrics.total,
        "category agreement": proportionWithInterval(
          metrics.category_agreement,
        ),
        "joint agreement": proportionWithInterval(metrics.joint_agreement),
        "P0/P1 recall": proportionWithInterval(metrics.p0_p1_recall),
        "human-review recall": proportionWithInterval(
          metrics.human_review_recall,
        ),
      })),
    ),
  );
  console.log("Error counts");
  console.table(
    summaries.map((summary) => ({
      config: summary.config,
      ...(summary.error_counts ?? {}),
    })),
  );
  console.log("Confusion counts (expected → predicted)");
  for (const summary of summaries) {
    console.log(
      `${summary.config}: ${JSON.stringify(summary.confusion_counts ?? {})}`,
    );
  }
  console.log("Operational comparison (costs are estimates, not billing data)");
  console.table(
    summaries.map((summary) => ({
      config: summary.config,
      escalations: `${summary.escalation_count} (${percent(summary.escalation_rate)})`,
      "p50 latency":
        summary.p50_latency_ms === null
          ? "n/a"
          : `${summary.p50_latency_ms}ms`,
      "p95 latency":
        summary.p95_latency_ms === null
          ? "n/a"
          : `${summary.p95_latency_ms}ms`,
      "estimated comparative cost":
        `$${summary.total_estimated_comparative_cost_usd.toFixed(4)}`,
      "model calls": JSON.stringify(summary.per_model_calls),
    })),
  );
}

function printLiveWarning(
  selection: DatasetSelection,
  label: boolean,
  configs: ConfigName[],
) {
  const paidConfigs = configs.filter((config) => config !== "routed");
  if (!label && paidConfigs.length === 0) return;
  console.warn("\n⚠ LIVE BEDROCK RUN: this command invokes paid model APIs.");
  console.warn(
    `  Dataset: ${selection.name}/${selection.split} (${selection.tickets.length} tickets)`,
  );
  console.warn(
    `  Workload: ${label ? "optional Opus reference labels" : paidConfigs.join(", ")}\n`,
  );
}

function printHelp() {
  console.log(`Usage: npm run bakeoff -- [options]

Datasets:
  --dataset=production  Production-shaped profile (default)
  --dataset=stress      Legacy stress/boundary profile

Evaluation scope:
  --split=workshop      Safe 30-ticket workshop subset (default)
  --split=calibration   Fixed 50-ticket calibration set
  --split=test          Fixed locked 150-ticket test set
  --split=all           Select from the complete dataset
  --limit=N             Limit workshop/all selection (default: ${DEFAULT_TICKET_LIMIT})
  --full-dataset        Explicitly select all 1,000 tickets

Configs:
  --config=routed       Offline Nano→Sonnet composition (default; requires caches)
  --config=nano         Run Nano once per selected ticket
  --config=sonnet       Run Sonnet once per selected ticket
  --all                 Run Nano and Sonnet once, then compose routed offline
  --experimental-super  Add/permit experimental Super

Modes:
  --label               Generate optional Opus reference/adjudication labels
  --dry-run             Read complete matching caches; never call Bedrock
  --claim-summary       Require every selected label to be independently reviewed
  --review-overrides=P  Read reviewer-authored label overrides from path P
  --help                Show this message`);

  console.log(`
Human-review workflow:
  1. Review data/production-shaped-1k.test-review-worksheet.json independently.
  2. Put final labels in ${PRODUCTION_HUMAN_REVIEW_OVERRIDE_PATH}; generation never overwrites it.
  3. Run --split=test only after all 150 overrides are human_reviewed/adjudicated.
  4. Add --claim-summary for any publishable/blog claim. Without it, output is explicitly development-only.`);
}

async function generateOpusReference(
  selection: DatasetSelection,
  evaluation: EvaluationContext,
  identity: RunIdentity,
) {
  const labels: Array<[string, JudgeLabel]> = [];
  const failures: RunFailure[] = [];
  for (const [index, ticket] of selection.tickets.entries()) {
    if (index % 25 === 0) {
      process.stdout.write(`  opus: ${index}/${selection.tickets.length}\r`);
    }
    try {
      labels.push([ticket.id, await judgeTicket(ticket)]);
    } catch (error) {
      failures.push({
        ticket_id: ticket.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  process.stdout.write("\n");
  if (failures.length > 0) {
    throw new Error(formatFailures("Opus reference labeling", failures));
  }
  const expectedIds = selection.tickets.map((ticket) => ticket.id);
  const actualIds = labels.map(([ticketId]) => ticketId);
  if (stableJson(actualIds) !== stableJson(expectedIds)) {
    throw new Error("Opus reference labels do not match the comparison set.");
  }
  writeCache(
    selection,
    createCacheEnvelope(
      "opus-reference-labels",
      evaluation,
      identity,
      expectedIds,
      labels,
    ),
  );
  console.log(
    `Wrote optional Opus reference labels to ${cachePath(selection, "opus-reference-labels")}`,
  );
}

function readOptionalOpusReference(
  selection: DatasetSelection,
  evaluation: EvaluationContext,
): Map<string, JudgeLabel> | null {
  const cached = readCache<Array<[string, JudgeLabel]>>(
    selection,
    evaluation,
    "opus-reference-labels",
  );
  if (!cached) return null;
  const expectedIds = selection.tickets.map((ticket) => ticket.id);
  const actualIds = cached.data.map(([ticketId]) => ticketId);
  if (stableJson(actualIds) !== stableJson(expectedIds)) {
    throw new Error("Opus reference cache does not match the comparison set.");
  }
  return new Map(cached.data);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }
  if (args.label && args.dryRun) {
    throw new Error(
      "--label cannot be combined with --dry-run because labeling is a paid live run.",
    );
  }
  if (args.label && args.claimSummary) {
    throw new Error(
      "--label creates an advisory model reference and cannot produce a claim-bearing summary.",
    );
  }

  const selection = loadDataset(args);
  const reviewGate = humanReviewGateStatus(selection);
  const includesLockedTest =
    selection.sourceIntent !== null &&
    Array.from(selection.sourceIntent.values()).some(
      (label) => label.split === "test",
    );
  const lockedTestLiveRun = includesLockedTest && !args.dryRun;
  if (lockedTestLiveRun || args.claimSummary) {
    enforceHumanReviewGate(
      selection,
      lockedTestLiveRun
        ? "a locked-test live run"
        : "a claim-bearing summary",
    );
  } else if (selection.sourceIntent && !reviewGate.complete) {
    console.warn(
      [
        "\n⚠ DEVELOPMENT-ONLY EVALUATION: results are not approved for publication or external claims.",
        `  Human review: ${reviewGate.reviewed}/${reviewGate.total} selected labels complete.`,
        "  Use the review worksheet, complete the separate override file, and rerun with --claim-summary.",
      ].join("\n"),
    );
  }
  const evaluation = buildEvaluationContext(selection);
  const configs = resolveConfigs(args);
  const identity = {
    createdAt: new Date().toISOString(),
    runId: randomUUID(),
  };
  console.log(
    `Loaded ${selection.tickets.length}/${selection.totalAvailable} tickets from ${selection.path}`,
  );
  console.log(`Evaluation split: ${selection.split}`);
  console.log(`Dataset profile: ${selection.description}`);
  console.log(
    `Evaluation fingerprint: ${evaluation.evaluation_fingerprint}`,
  );
  if (selection.sourceIntent) {
    const unreviewed = Array.from(selection.sourceIntent.values()).filter(
      (label) => label.review_status === "unreviewed",
    ).length;
    console.log(
      `Source-intent labels: ${selection.sourceIntent.size} (${unreviewed} unreviewed)`,
    );
    if (reviewGate.complete) {
      console.log(
        `Human-review gate: complete (${reviewGate.reviewed}/${reviewGate.total}); overrides ${selection.reviewOverrideSha256}`,
      );
    }
  }

  if (!args.dryRun) printLiveWarning(selection, args.label, configs);
  if (args.label) {
    await generateOpusReference(selection, evaluation, identity);
    return;
  }

  const resultsByConfig = new Map<ConfigName, PerTicketResult[]>();
  const routedOnly = configs.length === 1 && configs[0] === "routed";
  const needsNano = configs.includes("nano") || configs.includes("routed");
  const needsSonnet = configs.includes("sonnet") || configs.includes("routed");

  if (needsNano) {
    resultsByConfig.set(
      "nano",
      routedOnly
        ? readRequiredBaseCache("nano", selection, evaluation)
        : await runBaseConfig(
            "nano",
            selection,
            evaluation,
            args.dryRun,
            identity,
          ),
    );
  }
  if (needsSonnet) {
    resultsByConfig.set(
      "sonnet",
      routedOnly
        ? readRequiredBaseCache("sonnet", selection, evaluation)
        : await runBaseConfig(
            "sonnet",
            selection,
            evaluation,
            args.dryRun,
            identity,
          ),
    );
  }
  if (configs.includes("super")) {
    resultsByConfig.set(
      "super",
      await runBaseConfig(
        "super",
        selection,
        evaluation,
        args.dryRun,
        identity,
      ),
    );
  }
  if (configs.includes("routed")) {
    resultsByConfig.set(
      "routed",
      composeRoutedResults(
        resultsByConfig.get("nano")!,
        resultsByConfig.get("sonnet")!,
      ),
    );
  }

  const expectedIds = selection.tickets.map((ticket) => ticket.id);
  for (const config of configs) {
    validateResults(
      resultsByConfig.get(config) ?? [],
      expectedIds,
      `${config} comparison results`,
    );
  }
  const opusReference = readOptionalOpusReference(selection, evaluation);
  if (opusReference) {
    console.log(
      "Optional reference: Claude Opus labels (advisory, not ground truth)",
    );
  }
  const summaries = configs.map((config) =>
    summarize(
      config,
      resultsByConfig.get(config)!,
      selection.sourceIntent,
      opusReference,
    ),
  );
  printTables(summaries, args.claimSummary);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
