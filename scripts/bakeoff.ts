#!/usr/bin/env tsx
/**
 * Phase 4 bake-off harness.
 *
 * Runs the synthetic 1k dataset through three configurations and prints
 * a side-by-side table of cost / latency / agreement-with-ground-truth.
 *
 *   npm run bakeoff -- --label          # generate ground-truth labels (Sonnet, low temp)
 *   npm run bakeoff -- --config=sonnet  # baseline
 *   npm run bakeoff -- --config=nano    # nano only
 *   npm run bakeoff -- --config=routed  # nano + super escalation
 *   npm run bakeoff -- --all            # run all three
 *   npm run bakeoff -- --dry-run        # use cached results, no Bedrock calls
 *
 * Results land in .bakeoff-cache/ as JSON so reruns are cheap and the live
 * stage can show consistent numbers even if the network hiccups.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { triageTicket } from "../lib/bedrock/client";
import { MODELS, APPROX_COST_PER_1K_TOKENS, type ModelId } from "../lib/bedrock/models";
import { judgeTicket, type JudgeLabel } from "../lib/triage/judge";
import type { RoutingDecision, Ticket } from "../lib/triage/schema";

const DATASET_PATH = "data/synthetic-1k.json";
const CACHE_DIR = ".bakeoff-cache";
// Escalation logic. Three layers, ordered cheapest-first:
//
// 1. Confidence-based: Nano explicitly says it's unsure.
// 2. Stakes-based: the answer matters too much to take Nano's word for it
//    (P0/P1 outage, needs_human flag, or abuse category).
// 3. Category-based (domain-tuned): Nano picked a category that historical
//    disagreements with Opus showed it confuses with adjacent categories.
//    For B2B support triage, the high-disagreement set is:
//      - integration ↔ feature_request (e.g., "When will Notion sync land?")
//      - bug_report ↔ billing/performance (e.g., "double-charged" vs "wrong
//        amount in invoice")
//    Production teams replace this with a learned router trained on their
//    own historical disagreements; this hardcoded list is the workshop
//    starting point, not the production answer.
const HIGH_DISAGREEMENT_CATEGORIES: ReadonlySet<string> = new Set([
  "integration",
  "feature_request",
  "bug_report",
  "performance",
]);

function shouldEscalate(decision: RoutingDecision): boolean {
  return (
    decision.confidence < 0.7 ||
    decision.priority === "P0" ||
    decision.priority === "P1" ||
    decision.needs_human === true ||
    decision.category === "abuse" ||
    HIGH_DISAGREEMENT_CATEGORIES.has(decision.category)
  );
}

type ConfigName = "sonnet" | "nano" | "super" | "routed";

interface PerTicketResult {
  ticket_id: string;
  decision: RoutingDecision;
  model_used: ModelId;
  latency_ms: number;
  approx_tokens: number;
  approx_cost_usd: number;
  escalated: boolean;
}

interface RunSummary {
  config: ConfigName;
  total_tickets: number;
  total_latency_ms: number;
  total_approx_cost_usd: number;
  agreement_with_truth: number | null;
  escalation_rate: number;
  per_model_calls: Record<string, number>;
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    label: args.includes("--label"),
    all: args.includes("--all"),
    dryRun: args.includes("--dry-run"),
    config: (args.find((a) => a.startsWith("--config="))?.split("=")[1] ??
      null) as ConfigName | null,
    limit: Number(
      args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0",
    ),
  };
}

function loadDataset(limit: number): Ticket[] {
  const all = JSON.parse(readFileSync(DATASET_PATH, "utf8")) as Ticket[];
  return limit > 0 ? all.slice(0, limit) : all;
}

function cachePath(name: string): string {
  return join(CACHE_DIR, `${name}.json`);
}

function readCache<T>(name: string): T | null {
  const p = cachePath(name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

function writeCache(name: string, data: unknown) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(name), JSON.stringify(data, null, 2) + "\n");
}

/** Crude token estimate — good enough for cost display, not for billing. */
function estimateTokens(ticket: Ticket, decision: RoutingDecision): number {
  const inputChars = ticket.subject.length + ticket.body.length + 200;
  const outputChars = decision.reasoning.length + 100;
  return Math.ceil((inputChars + outputChars) / 4);
}

async function callOnce(ticket: Ticket, modelId: ModelId): Promise<PerTicketResult> {
  const start = Date.now();
  const decision = await triageTicket(ticket, { modelId });
  const latency = Date.now() - start;
  const tokens = estimateTokens(ticket, decision);
  return {
    ticket_id: ticket.id,
    decision,
    model_used: modelId,
    latency_ms: latency,
    approx_tokens: tokens,
    approx_cost_usd: (tokens / 1000) * APPROX_COST_PER_1K_TOKENS[modelId],
    escalated: false,
  };
}

async function runConfig(
  config: ConfigName,
  tickets: Ticket[],
  dryRun: boolean,
): Promise<PerTicketResult[]> {
  if (dryRun) {
    const cached = readCache<PerTicketResult[]>(`run-${config}`);
    if (!cached) {
      throw new Error(`No cache for ${config} — run without --dry-run first`);
    }
    console.log(`  [dry-run] using cached results for ${config}`);
    return cached;
  }

  const results: PerTicketResult[] = [];
  for (const [i, ticket] of tickets.entries()) {
    if (i % 10 === 0) {
      process.stdout.write(`  ${config}: ${i}/${tickets.length}\r`);
    }
    try {
      let r: PerTicketResult;
      if (config === "sonnet") {
        r = await callOnce(ticket, MODELS.CLAUDE_SONNET);
      } else if (config === "nano") {
        r = await callOnce(ticket, MODELS.NEMOTRON_NANO);
      } else if (config === "super") {
        r = await callOnce(ticket, MODELS.NEMOTRON_SUPER);
      } else {
        // routed: Nano on every ticket; if Nano flags low confidence, P0/P1,
        // needs_human, or abuse, re-check with Claude Sonnet and take its answer.
        // This matches the partnership cascade the live demo runs (see
        // app/api/triage/cascade/route.ts) — Nemotron handles the volume,
        // Claude handles the long tail.
        const nanoResult = await callOnce(ticket, MODELS.NEMOTRON_NANO);
        if (shouldEscalate(nanoResult.decision)) {
          const claudeResult = await callOnce(ticket, MODELS.CLAUDE_SONNET);
          r = {
            ...claudeResult,
            latency_ms: nanoResult.latency_ms + claudeResult.latency_ms,
            approx_cost_usd:
              nanoResult.approx_cost_usd + claudeResult.approx_cost_usd,
            approx_tokens: nanoResult.approx_tokens + claudeResult.approx_tokens,
            escalated: true,
          };
        } else {
          r = nanoResult;
        }
      }
      results.push(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `\n  ! ${config} ${ticket.id} skipped: ${msg.slice(0, 120)}`,
      );
    }
  }
  console.log(`  ${config}: ${tickets.length}/${tickets.length} ✓`);
  writeCache(`run-${config}`, results);
  return results;
}

function summarize(
  config: ConfigName,
  results: PerTicketResult[],
  groundTruth: Map<string, JudgeLabel> | null,
): RunSummary {
  const perModel: Record<string, number> = {};
  let totalLatency = 0;
  let totalCost = 0;
  let escalations = 0;
  let agree = 0;
  let evaluated = 0;

  for (const r of results) {
    perModel[r.model_used] = (perModel[r.model_used] ?? 0) + 1;
    totalLatency += r.latency_ms;
    totalCost += r.approx_cost_usd;
    if (r.escalated) escalations++;
    if (groundTruth) {
      const truth = groundTruth.get(r.ticket_id);
      if (truth) {
        evaluated++;
        if (truth.category === r.decision.category) agree++;
      }
    }
  }

  return {
    config,
    total_tickets: results.length,
    total_latency_ms: totalLatency,
    total_approx_cost_usd: totalCost,
    agreement_with_truth: evaluated > 0 ? agree / evaluated : null,
    escalation_rate: escalations / results.length,
    per_model_calls: perModel,
  };
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function printTable(summaries: RunSummary[]) {
  const header = ["config", "tickets", "total cost", "avg latency", "agreement", "escalation"];
  const rows = summaries.map((s) => [
    s.config,
    String(s.total_tickets),
    fmtUsd(s.total_approx_cost_usd),
    `${Math.round(s.total_latency_ms / s.total_tickets)}ms`,
    s.agreement_with_truth === null
      ? "n/a"
      : `${(s.agreement_with_truth * 100).toFixed(1)}%`,
    `${(s.escalation_rate * 100).toFixed(1)}%`,
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const sep = "  ";
  console.log("\n" + header.map((h, i) => h.padEnd(widths[i])).join(sep));
  console.log(widths.map((w) => "-".repeat(w)).join(sep));
  for (const r of rows) {
    console.log(r.map((c, i) => c.padEnd(widths[i])).join(sep));
  }
  console.log();
}

async function main() {
  const args = parseArgs();
  const tickets = loadDataset(args.limit);
  console.log(`Loaded ${tickets.length} tickets from ${DATASET_PATH}`);

  if (args.label) {
    if (args.dryRun) {
      throw new Error("--label cannot be combined with --dry-run");
    }
    console.log(
      "Generating ground-truth labels via Claude Opus 4.7 (temperature=0)…",
    );
    console.log(
      "  (Opus is the strongest model on Bedrock — our independent judge.)",
    );
    const labels = new Map<string, JudgeLabel>();
    for (const [i, ticket] of tickets.entries()) {
      if (i % 25 === 0) process.stdout.write(`  ${i}/${tickets.length}\r`);
      const label = await judgeTicket(ticket);
      labels.set(ticket.id, label);
    }
    writeCache("ground-truth", Array.from(labels.entries()));
    console.log(`  ${tickets.length}/${tickets.length} ✓`);
    console.log(`Wrote ground truth to ${cachePath("ground-truth")}`);
    return;
  }

  const truthRaw = readCache<[string, JudgeLabel][]>("ground-truth");
  const groundTruth = truthRaw ? new Map(truthRaw) : null;
  if (!groundTruth) {
    console.warn(
      "No ground truth labels yet — run `npm run bakeoff -- --label` first if you want agreement %",
    );
  } else {
    console.log("Ground truth: Claude Opus 4.7 (independent judge)");
  }

  const configs: ConfigName[] = args.all
    ? ["sonnet", "nano", "super", "routed"]
    : args.config
      ? [args.config]
      : ["routed"];

  const summaries: RunSummary[] = [];
  for (const config of configs) {
    console.log(`\n→ Running ${config}…`);
    const results = await runConfig(config, tickets, args.dryRun);
    summaries.push(summarize(config, results, groundTruth));
  }

  printTable(summaries);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
