#!/usr/bin/env tsx
/**
 * Offline, independent recomputation from the public result artifact.
 * No credentials, local model caches, or network calls are required.
 * This checks evidence consistency; it does not authenticate provider responses
 * or establish the correctness of the human reference labels.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadDataset, parseArgs } from "./bakeoff";
import { RoutingDecisionSchema, SourceIntentLabelSchema, type SourceIntentLabel } from "../lib/triage/schema";
import { GATEWAY_MODELS, JEV_PRICING_SNAPSHOT, MODELS, estimateModelCostUsd } from "../lib/bedrock/models";
import { JEV_QUESTIONS, jevState } from "../lib/jev/triage";

const names = ["sonnet", "nano", "jev", "nano-sonnet", "jev-sonnet", "jev-nano-sonnet"] as const;
const layers = ["jev", "nano", "sonnet"] as const;
type Layer = typeof layers[number];
const Nonnegative = z.number().finite().nonnegative();
const Stage = z.object({
  stage: z.enum(layers), model: z.string(), status: z.literal("completed"),
  decision: RoutingDecisionSchema, latency_ms: Nonnegative,
  usage: z.object({ inputTokens: Nonnegative.int(), outputTokens: Nonnegative.int() }),
  estimated_market_cost_usd: Nonnegative,
  confidence_by_field: z.object({ category: Nonnegative.max(1), priority: Nonnegative.max(1), needs_human: Nonnegative.max(1) }).optional(),
  gateway_reported_cost_usd: Nonnegative.nullable().optional(),
  attempts: z.number().int().min(1).max(2).optional(),
});
const StrategyResult = z.object({
  decision: RoutingDecisionSchema, route: z.string(), calls: z.array(z.enum(layers)),
  review_required: z.boolean(), estimated_latency_ms: Nonnegative,
  estimated_market_cost_usd: Nonnegative.nullable(),
});
const Report = z.object({
  provenance: z.object({
    questions_sha256: z.string(), states_sha256: z.string(), selected_labels_sha256: z.string(),
    policy: z.object({ jevMinimumFieldConfidence: z.literal(0.8), nanoConfidenceThreshold: z.literal(0.7) }),
  }),
  jev_run: z.object({ records_sha256: z.string(), total_attempts: Nonnegative.int(),
    all_results_market_cost_usd: Nonnegative.nullable(), all_results_gateway_reported_cost_usd: Nonnegative.nullable() }),
  summaries: z.array(z.object({ strategy: z.enum(names) }).passthrough()),
  middle_layer: z.record(z.unknown()),
  records: z.array(z.object({
    ticket_id: z.string(), label: SourceIntentLabelSchema,
    stages: z.object({ jev: Stage, nano: Stage, sonnet: Stage }),
    strategies: z.record(z.enum(names), StrategyResult),
  })).length(150),
});
type RecordRow = z.infer<typeof Report>["records"][number];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function same(actual: unknown, expected: unknown, description: string) {
  if (typeof actual === "number" && typeof expected === "number") {
    if (Math.abs(actual - expected) <= 1e-9) return;
  } else if (canonical(actual) === canonical(expected)) return;
  throw new Error(`Evidence mismatch: ${description}`);
}
const flagged = (d: z.infer<typeof RoutingDecisionSchema>) =>
  d.priority === "P0" || d.priority === "P1" || d.needs_human;
const escalateNano = (d: z.infer<typeof RoutingDecisionSchema>) => flagged(d) || d.confidence < 0.7;
const joint = (d: z.infer<typeof RoutingDecisionSchema>, l: SourceIntentLabel) =>
  d.category === l.intended_category && d.priority === l.intended_priority && d.needs_human === l.intended_needs_human;
function expectedCalls(name: typeof names[number], r: RecordRow): Layer[] {
  const j = r.stages.jev.decision, n = r.stages.nano.decision;
  if (name === "jev" || name === "nano" || name === "sonnet") return [name];
  if (name === "nano-sonnet") return escalateNano(n) ? ["nano", "sonnet"] : ["nano"];
  if (flagged(j)) return ["jev", "sonnet"];
  if (j.confidence >= 0.8) return ["jev"];
  if (name === "jev-sonnet") return ["jev", "sonnet"];
  return escalateNano(n) ? ["jev", "nano", "sonnet"] : ["jev", "nano"];
}
const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1];

export function auditEvidence(raw: unknown, labels: Map<string, SourceIntentLabel>) {
  const report = Report.parse(raw);
  same(report.records.map((r) => r.ticket_id), [...labels.keys()], "ticket ID coverage and order");
  same(report.summaries.map((s) => s.strategy), [...names], "strategy coverage");
  const models = { jev: GATEWAY_MODELS.JEV, nano: MODELS.NEMOTRON_NANO, sonnet: MODELS.CLAUDE_SONNET };
  for (const row of report.records) {
    same(row.label, labels.get(row.ticket_id), `${row.ticket_id} reviewed reference`);
    for (const layer of layers) {
      const stage = row.stages[layer];
      same(stage.stage, layer, "stage name");
      same(stage.model, models[layer], "model ID");
      same(stage.decision.ticket_id, row.ticket_id, "stage ticket ID");
      const expectedCost = layer === "jev"
        ? stage.usage.inputTokens * JEV_PRICING_SNAPSHOT.inputUsdPerMillionTokens / 1_000_000
        : estimateModelCostUsd(models[layer], stage.usage);
      same(stage.estimated_market_cost_usd, expectedCost, "usage-based price estimate");
      if (layer === "jev") {
        if (!stage.confidence_by_field) throw new Error("Missing Jev field confidences.");
        same(stage.decision.confidence, Math.min(...Object.values(stage.confidence_by_field)), "minimum Jev confidence");
      }
    }
    for (const name of names) {
      const actual = row.strategies[name];
      if (!actual) throw new Error(`Missing strategy: ${name}`);
      const calls = expectedCalls(name, row);
      same(actual.calls, calls, `${row.ticket_id} ${name} calls`);
      same(actual.route, calls.join("→"), "route");
      same(actual.decision, row.stages[calls.at(-1)!].decision, "final decision");
      same(actual.review_required, calls.some((l) => flagged(row.stages[l].decision)), "preserved review signal");
      same(actual.estimated_latency_ms, calls.reduce((sum, l) => sum + row.stages[l].latency_ms, 0), "summed latency");
      const complete = calls.every((l) => (row.stages[l].attempts ?? 1) === 1);
      same(actual.estimated_market_cost_usd, complete
        ? calls.reduce((sum, l) => sum + row.stages[l].estimated_market_cost_usd, 0) : null, "cost completeness");
    }
  }
  const summaries = names.map((name) => {
    const rows = report.records;
    const callCounts = { jev: 0, nano: 0, sonnet: 0 }, routes: Record<string, number> = {};
    let category = 0, full = 0, high = 0, highTotal = 0, human = 0, preserved = 0, humanTotal = 0, fp = 0, cost = 0;
    for (const row of rows) {
      const s = row.strategies[name]!, l = row.label;
      category += Number(s.decision.category === l.intended_category);
      full += Number(joint(s.decision, l));
      if (["P0", "P1"].includes(l.intended_priority)) { highTotal++; high += Number(["P0", "P1"].includes(s.decision.priority)); }
      if (l.intended_needs_human) { humanTotal++; human += Number(s.decision.needs_human); preserved += Number(s.review_required); }
      else fp += Number(s.review_required);
      routes[s.route] = (routes[s.route] ?? 0) + 1;
      for (const layer of s.calls) { callCounts[layer]++; cost += row.stages[layer].estimated_market_cost_usd; }
    }
    const computed = {
      n: rows.length, category_correct: category, joint_correct: full,
      high_priority_recalled: high, high_priority_total: highTotal,
      final_model_human_recalled: human, review_required_recalled: preserved, human_total: humanTotal,
      review_required_false_positives: fp, non_human_total: rows.length - humanTotal,
      calls: callCounts, routes,
      estimated_market_cost_usd: rows.every((r) => r.strategies[name]!.estimated_market_cost_usd !== null) ? cost : null,
      estimated_p50_ms: percentile(rows.map((r) => r.strategies[name]!.estimated_latency_ms), .5),
      estimated_p95_ms: percentile(rows.map((r) => r.strategies[name]!.estimated_latency_ms), .95),
    };
    const published = report.summaries.find((s) => s.strategy === name)!;
    for (const [key, value] of Object.entries(computed)) same(published[key], value, `${name} summary ${key}`);
    return { strategy: name, ...computed, successful_call_market_cost_usd: cost };
  });
  const deferred = report.records.filter((r) => !flagged(r.stages.jev.decision) && r.stages.jev.decision.confidence < .8);
  const retained = deferred.filter((r) => !escalateNano(r.stages.nano.decision));
  const middle = {
    jev_uncertain_non_high_risk: deferred.length, nano_retained: retained.length,
    sonnet_calls_avoided: retained.length,
    nano_joint_correct_on_deferred: deferred.filter((r) => joint(r.stages.nano.decision, r.label)).length,
    sonnet_joint_correct_on_deferred: deferred.filter((r) => joint(r.stages.sonnet.decision, r.label)).length,
    retained_nano_wrong_sonnet_right: retained.filter((r) => !joint(r.stages.nano.decision, r.label) && joint(r.stages.sonnet.decision, r.label)).map((r) => r.ticket_id),
    retained_nano_right_sonnet_wrong: retained.filter((r) => joint(r.stages.nano.decision, r.label) && !joint(r.stages.sonnet.decision, r.label)).map((r) => r.ticket_id),
  };
  same(report.middle_layer, middle, "middle-layer subset comparison");
  same(report.jev_run.total_attempts, report.records.reduce((sum, r) => sum + (r.stages.jev.attempts ?? 1), 0), "completed-cache attempt count");
  same(report.jev_run.all_results_market_cost_usd, report.records.reduce((sum, r) => sum + r.stages.jev.estimated_market_cost_usd, 0), "Jev market cost");
  same(report.jev_run.all_results_gateway_reported_cost_usd, report.records.every((r) => r.stages.jev.gateway_reported_cost_usd != null)
    ? report.records.reduce((sum, r) => sum + r.stages.jev.gateway_reported_cost_usd!, 0) : null, "Jev reported charge");
  const three = summaries.find((s) => s.strategy === "jev-nano-sonnet")!, two = summaries.find((s) => s.strategy === "jev-sonnet")!;
  const original = summaries.find((s) => s.strategy === "nano-sonnet")!;
  return {
    status: "passed", records: report.records.length,
    scenario_families: new Set(report.records.map((r) => r.label.scenario_family)).size,
    summaries, middle_layer: middle,
    claims: {
      sonnet_calls_saved_vs_jev_sonnet: two.calls.sonnet - three.calls.sonnet,
      successful_cost_reduction_vs_jev_sonnet: 1 - three.successful_call_market_cost_usd / two.successful_call_market_cost_usd,
      successful_cost_increase_vs_nano_sonnet: three.successful_call_market_cost_usd / original.successful_call_market_cost_usd - 1,
      missed_preserved_human_signals: three.human_total - three.review_required_recalled,
      three_model_paths_observed_in_replay: three.routes["jev→nano→sonnet"] ?? 0,
    },
  };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.some((a) => a !== "--write")) throw new Error("Usage: npm run audit:three-tier [-- --write]");
  const file = "docs/research/three-tier-comparison.json";
  const text = readFileSync(file, "utf8"), raw = JSON.parse(text);
  const selected = loadDataset(parseArgs(["--dataset=production", "--split=test"]));
  const labels = new Map(selected.tickets.map((t) => [t.id, selected.sourceIntent!.get(t.id)!]));
  same(raw.provenance.questions_sha256, hash(JEV_QUESTIONS), "Jev question fingerprint");
  same(raw.provenance.states_sha256, hash(selected.tickets.map(jevState)), "Jev input/rubric fingerprint");
  same(raw.provenance.selected_labels_sha256, selected.selectedSourceIntentSha256, "selected label fingerprint");
  const result = {
    ...auditEvidence(raw, labels),
    source: file, source_sha256: createHash("sha256").update(text).digest("hex"),
    records_sha256: hash(raw.records),
    scope: "Offline consistency check of public records and reviewed synthetic references; no new inference or external peer review.",
  };
  if (argv.includes("--write")) writeFileSync("docs/research/three-tier-evidence-audit.json", `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
