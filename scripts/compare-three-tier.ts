#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { buildEvaluationContext, loadDataset, parseArgs, readCache, type CacheEnvelope, type PerTicketResult } from "./bakeoff";
import { composeStrategy, STRATEGIES, type Strategy } from "../lib/cascade/compare";
import { jevStage, nextAfterJev, THREE_TIER_POLICY, type TriageStage } from "../lib/cascade/three-tier";
import { JEV_QUESTIONS, JEV_TRIAGE_PROMPT_VERSION, decisionFromJev, jevState, triageWithJev, type JevTriageResult } from "../lib/jev/triage";
import { GatewayResponseSchema, validateAnswers } from "../lib/jev/client";
import { GATEWAY_MODELS, JEV_PRICING_SNAPSHOT, MODELS } from "../lib/bedrock/models";
import { RoutingDecisionSchema, type SourceIntentLabel } from "../lib/triage/schema";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function writeAtomic(file: string, data: unknown) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}
function joint(decision: TriageStage["decision"], label: SourceIntentLabel) {
  return decision?.category === label.intended_category &&
    decision.priority === label.intended_priority && decision.needs_human === label.intended_needs_human;
}
function percentile(values: number[], p: number) {
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
}

const JevResultSchema = z.object({
  response: GatewayResponseSchema,
  latencyMs: z.number().finite().nonnegative(),
  attempts: z.number().int().min(1).max(2),
  gatewayReportedCostUsd: z.number().finite().nonnegative().nullable(),
  gatewayMarketCostUsd: z.number().finite().nonnegative().nullable(),
});

export async function main(argv = process.argv.slice(2)) {
  if (argv.some((arg) => !["--collect-jev", "--help"].includes(arg))) throw new Error("Unknown argument. Use --help.");
  if (argv.includes("--help")) {
    console.log("npm run compare:three-tier [--collect-jev]\nOffline by default. --collect-jev pays for missing Jev results only.\nRequires validated full test-split Nano and Sonnet bakeoff caches. See docs/three-tier-example.md.");
    return;
  }
  const collect = argv.includes("--collect-jev");
  const selection = loadDataset(parseArgs(["--dataset=production", "--split=test"]));
  if (!selection.sourceIntent || selection.selectedReviewedCount !== selection.tickets.length) {
    throw new Error("Comparison requires reviewed labels for every ticket.");
  }
  const bases = {} as Record<"nano" | "sonnet", CacheEnvelope<PerTicketResult[]>>;
  for (const name of ["nano", "sonnet"] as const) {
    const file = join(selection.cacheDir, `model-${name}.json`);
    if (!existsSync(file)) throw new Error(`Missing ${file}. Run the documented Bedrock baseline collection first.`);
    const header = JSON.parse(readFileSync(file, "utf8")) as CacheEnvelope<PerTicketResult[]>;
    // Validate current data/prompt/schema/pricing, explicitly retaining the historical
    // execution revision. This is a replay, not a claim of a fresh baseline run.
    const historical = buildEvaluationContext(selection, header.evaluation.aws_region, header.evaluation.code_revision);
    const cache = readCache<PerTicketResult[]>(selection, historical, `model-${name}`);
    if (!cache) throw new Error(`Missing ${name} cache.`);
    const expectedModel = name === "nano" ? MODELS.NEMOTRON_NANO : MODELS.CLAUDE_SONNET;
    for (const result of cache.data) {
      const parsed = RoutingDecisionSchema.parse(result.final_decision);
      if (parsed.ticket_id !== result.ticket_id || result.final_model !== expectedModel ||
        result.models_called.length !== 1 || result.models_called[0] !== expectedModel ||
        !Number.isFinite(result.latency_ms) || result.latency_ms < 0 ||
        !Number.isFinite(result.estimated_comparative_cost_usd) || result.estimated_comparative_cost_usd < 0) {
        throw new Error(`Invalid ${name} baseline record.`);
      }
    }
    bases[name] = cache;
  }
  if (bases.nano.evaluation.evaluation_fingerprint !== bases.sonnet.evaluation.evaluation_fingerprint) {
    throw new Error("Nano and Sonnet baselines must have matching evaluation contexts.");
  }
  const provenance = {
    format: "three-tier-comparison-v1",
    model: GATEWAY_MODELS.JEV,
    prompt_version: JEV_TRIAGE_PROMPT_VERSION,
    questions_sha256: hash(JEV_QUESTIONS),
    states_sha256: hash(selection.tickets.map(jevState)),
    selected_labels_sha256: selection.selectedSourceIntentSha256,
    policy: THREE_TIER_POLICY,
    pricing: JEV_PRICING_SNAPSHOT,
    implementation_sha256: hash(Object.fromEntries([
      "lib/jev/client.ts", "lib/jev/triage.ts", "lib/cascade/three-tier.ts",
      "lib/cascade/compare.ts", "scripts/compare-three-tier.ts",
    ].map((file) => [file, readFileSync(file, "utf8")]))),
  };
  const identity = hash(provenance);
  const dir = ".bakeoff-cache/three-tier";
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `jev-${identity.slice(0, 16)}.json`);
  type JevCache = { identity: string; provenance: typeof provenance; created_at: string; updated_at: string; records: Record<string, JevTriageResult>; records_sha256: string };
  let cache: JevCache = {
    identity, provenance, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    records: {}, records_sha256: hash({}),
  };
  if (existsSync(file)) {
    cache = JSON.parse(readFileSync(file, "utf8")) as JevCache;
    if (cache.identity !== identity || hash(cache.provenance) !== identity || hash(cache.records) !== cache.records_sha256) {
      throw new Error("Jev cache integrity mismatch.");
    }
    const allowedIds = new Set(selection.tickets.map((ticket) => ticket.id));
    for (const [id, raw] of Object.entries(cache.records)) {
      if (!allowedIds.has(id)) throw new Error("Unexpected Jev cache ticket.");
      const parsed = JevResultSchema.parse(raw);
      validateAnswers(parsed.response, JEV_QUESTIONS);
      if (parsed.response.model !== GATEWAY_MODELS.JEV) throw new Error("Unexpected cached Jev model.");
      if (canonical(raw.decision) !== canonical(decisionFromJev(id, parsed).decision)) throw new Error("Cached Jev decision mismatch.");
    }
  }
  const missing = selection.tickets.filter((ticket) => !cache.records[ticket.id]);
  if (missing.length && !collect) throw new Error(`${missing.length} Jev results missing. Set AI_GATEWAY_API_KEY and pass --collect-jev.`);
  console.log(JSON.stringify({ tickets: selection.tickets.length, cached_jev: Object.keys(cache.records).length, new_jev_requests: missing.length, policy: THREE_TIER_POLICY }));
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, missing.length) }, async () => {
    while (cursor < missing.length) {
      const ticket = missing[cursor++];
      const result = await triageWithJev(ticket);
      cache.records[ticket.id] = result;
      cache.records_sha256 = hash(cache.records);
      cache.updated_at = new Date().toISOString();
      writeAtomic(file, cache);
      const count = Object.keys(cache.records).length;
      if (count % 10 === 0 || count === selection.tickets.length) console.log(`Jev completed ${count}/${selection.tickets.length}`);
    }
  });
  const settled = await Promise.allSettled(workers);
  const errors = settled.filter((result) => result.status === "rejected");
  if (errors.length) throw new Error(`Incomplete Jev run; checkpoints retained. ${errors.map((error) => (error as PromiseRejectedResult).reason.message).join("; ")}`);

  const records = selection.tickets.map((ticket, i) => {
    const baselineStage = (name: "nano" | "sonnet"): TriageStage => {
      const raw = bases[name].data[i];
      return {
        stage: name, model: raw.final_model, status: "completed", decision: raw.final_decision,
        latency_ms: raw.latency_ms, usage: { inputTokens: raw.input_token_count, outputTokens: raw.output_token_count },
        estimated_market_cost_usd: raw.estimated_comparative_cost_usd,
      };
    };
    const stages = { jev: jevStage(cache.records[ticket.id]), nano: baselineStage("nano"), sonnet: baselineStage("sonnet") };
    return {
      ticket_id: ticket.id,
      label: selection.sourceIntent!.get(ticket.id)!,
      stages,
      strategies: Object.fromEntries(STRATEGIES.map((strategy) => [strategy, composeStrategy(strategy, stages)])) as Record<Strategy, ReturnType<typeof composeStrategy>>,
    };
  });
  const summaries = STRATEGIES.map((strategy) => {
    const rows = records.map((record) => ({ ...record.strategies[strategy], label: record.label }));
    const high = rows.filter((r) => ["P0", "P1"].includes(r.label.intended_priority));
    const human = rows.filter((r) => r.label.intended_needs_human);
    const nonHuman = rows.filter((r) => !r.label.intended_needs_human);
    const calls = { jev: 0, nano: 0, sonnet: 0 };
    const routes: Record<string, number> = {};
    for (const row of rows) {
      for (const stage of row.calls) calls[stage]++;
      routes[row.route] = (routes[row.route] ?? 0) + 1;
    }
    return {
      strategy, n: rows.length,
      category_correct: rows.filter((r) => r.decision.category === r.label.intended_category).length,
      joint_correct: rows.filter((r) => joint(r.decision, r.label)).length,
      high_priority_recalled: high.filter((r) => ["P0", "P1"].includes(r.decision.priority)).length,
      high_priority_total: high.length,
      final_model_human_recalled: human.filter((r) => r.decision.needs_human).length,
      review_required_recalled: human.filter((r) => r.review_required).length,
      human_total: human.length,
      review_required_false_positives: nonHuman.filter((r) => r.review_required).length,
      non_human_total: nonHuman.length,
      calls, routes,
      estimated_market_cost_usd: rows.every((r) => r.estimated_market_cost_usd !== null)
        ? rows.reduce((sum, r) => sum + r.estimated_market_cost_usd!, 0) : null,
      estimated_p50_ms: percentile(rows.map((r) => r.estimated_latency_ms), 0.5),
      estimated_p95_ms: percentile(rows.map((r) => r.estimated_latency_ms), 0.95),
    };
  });
  const deferred = records.filter((record) => nextAfterJev(record.stages.jev.decision!) === "nano");
  const retained = deferred.filter((record) => record.strategies["jev-nano-sonnet"].calls.at(-1) === "nano");
  const middle = {
    jev_uncertain_non_high_risk: deferred.length,
    nano_retained: retained.length,
    sonnet_calls_avoided: retained.length,
    nano_joint_correct_on_deferred: deferred.filter((r) => joint(r.stages.nano.decision, r.label)).length,
    sonnet_joint_correct_on_deferred: deferred.filter((r) => joint(r.stages.sonnet.decision, r.label)).length,
    retained_nano_wrong_sonnet_right: retained.filter((r) => !joint(r.stages.nano.decision, r.label) && joint(r.stages.sonnet.decision, r.label)).map((r) => r.ticket_id),
    retained_nano_right_sonnet_wrong: retained.filter((r) => joint(r.stages.nano.decision, r.label) && !joint(r.stages.sonnet.decision, r.label)).map((r) => r.ticket_id),
  };
  const report = {
    generated_at: new Date().toISOString(),
    comparison_kind: "paired counterfactual replay on a previously examined synthetic test split",
    limitations: [
      "Not an untouched holdout or production benchmark; 150 reviewed synthetic tickets span 11 scenario families.",
      "Jev runs now; Bedrock results are historical. Summed cached latency is an estimate, not live end-to-end latency.",
      "Identical tickets and rubric, but provider-specific question/prompt formats differ. No model receives an earlier model's answer.",
      "Jev confidence and Nano self-reported confidence are not calibrated correctness probabilities or directly comparable scales.",
      "Jev alias does not pin an underlying provider version. Zero gateway-reported charges do not imply free market pricing.",
      "The final model's needs_human label and an OR of review signals are reported separately; false positives are also counted.",
      "Cost estimates use recorded usage/pricing and exclude hosting, human review, and potentially unreported retries.",
    ],
    provenance,
    bedrock_baselines: Object.fromEntries(Object.entries(bases).map(([name, value]) => [name, {
      created_at: value.created_at, code_revision: value.evaluation.code_revision,
      evaluation_fingerprint: value.evaluation.evaluation_fingerprint, data_sha256: value.data_sha256,
      pricing_snapshot: value.evaluation.pricing_snapshot, aws_region: value.evaluation.aws_region,
    }])),
    jev_run: {
      created_at: cache.created_at, updated_at: cache.updated_at, records_sha256: cache.records_sha256,
      new_requests_this_invocation: missing.length,
      all_results_gateway_reported_cost_usd: Object.values(cache.records).every((r) => r.gatewayReportedCostUsd !== null)
        ? Object.values(cache.records).reduce((sum, r) => sum + r.gatewayReportedCostUsd!, 0) : null,
      all_results_market_cost_usd: Object.values(cache.records).every((r) => r.gatewayMarketCostUsd !== null)
        ? Object.values(cache.records).reduce((sum, r) => sum + r.gatewayMarketCostUsd!, 0) : null,
      total_attempts: Object.values(cache.records).reduce((sum, r) => sum + r.attempts, 0),
    },
    summaries, middle_layer: middle, records,
  };
  const out = "docs/research";
  mkdirSync(out, { recursive: true });
  writeAtomic(join(out, "three-tier-comparison.json"), report);
  const pct = (n: number, d: number) => `${(100 * n / d).toFixed(1)}% (${n}/${d})`;
  const lines = [
    "# Jev / Nano / Sonnet: paired comparison", "",
    `Generated ${report.generated_at}. Policy frozen before the comparative run: Jev minimum field confidence < 0.8; Nano confidence < 0.7; P0/P1 or needs_human routes to Sonnet.`, "",
    "**Historical paired replay on previously examined synthetic data, not a new holdout result.**", "",
    "| Strategy | Category | Joint category + priority + human | P0/P1 recall | Final human recall | Preserved review recall | False review flags | Calls J/N/S | Estimated market USD | Estimated p50/p95 ms |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...summaries.map((s) => `| ${s.strategy} | ${pct(s.category_correct, s.n)} | ${pct(s.joint_correct, s.n)} | ${pct(s.high_priority_recalled, s.high_priority_total)} | ${pct(s.final_model_human_recalled, s.human_total)} | ${pct(s.review_required_recalled, s.human_total)} | ${s.review_required_false_positives}/${s.non_human_total} | ${s.calls.jev}/${s.calls.nano}/${s.calls.sonnet} | ${s.estimated_market_cost_usd?.toFixed(6) ?? "incomplete"} | ${s.estimated_p50_ms}/${s.estimated_p95_ms} |`),
    "", "## Does the middle tier help?", "",
    `Jev deferred ${middle.jev_uncertain_non_high_risk} non-high-risk tickets to Nano. Nano retained ${middle.nano_retained}, avoiding that many Sonnet calls.`,
    `On that deferred subset, Nano got ${middle.nano_joint_correct_on_deferred} joint labels right and Sonnet got ${middle.sonnet_joint_correct_on_deferred}.`,
    `Retained Nano wrong / Sonnet right: ${middle.retained_nano_wrong_sonnet_right.join(", ") || "none"}.`,
    `Retained Nano right / Sonnet wrong: ${middle.retained_nano_right_sonnet_wrong.join(", ") || "none"}.`,
    "", "## Provenance and limitations", "",
    ...report.limitations.map((line) => `- ${line}`),
    `- Nano baseline: ${bases.nano.created_at}; Sonnet baseline: ${bases.sonnet.created_at}.`,
    `- Jev market cost across all tickets: $${report.jev_run.all_results_market_cost_usd?.toFixed(6) ?? "unknown"}; gateway-reported charge: $${report.jev_run.all_results_gateway_reported_cost_usd?.toFixed(6) ?? "unknown"}.`,
    "- JSON companion contains individual synthetic-ticket decisions, labels, routing, hashes, pricing, and timestamps. No credentials.",
    "",
  ];
  writeFileSync(join(out, "three-tier-comparison.md"), lines.join("\n"));
  console.log(JSON.stringify({ summaries, middle_layer: middle, jev_run: report.jev_run }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
