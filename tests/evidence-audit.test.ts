import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auditEvidence } from "../scripts/audit-three-tier";
import { loadDataset, parseArgs } from "../scripts/bakeoff";
const selection = loadDataset(parseArgs(["--dataset=production", "--split=test"]));
const labels = new Map(selection.tickets.map((t) => [t.id, selection.sourceIntent!.get(t.id)!]));
const report = JSON.parse(readFileSync("docs/research/three-tier-comparison.json", "utf8"));
describe("public evidence integrity", () => {
  it("binds the recorded audit to the exact public artifact and recomputed claims", () => {
    const text = readFileSync("docs/research/three-tier-comparison.json", "utf8");
    const recorded = JSON.parse(readFileSync("docs/research/three-tier-evidence-audit.json", "utf8"));
    expect(recorded.source_sha256).toBe(createHash("sha256").update(text).digest("hex"));
    const recomputed = auditEvidence(report, labels);
    expect(recorded.summaries).toEqual(recomputed.summaries);
    expect(recorded.claims).toEqual(recomputed.claims);
  });
  it("recomputes published results without private caches or credentials", () => {
    const result = auditEvidence(report, labels);
    expect(result.status).toBe("passed");
    expect(result.records).toBe(150);
    expect(result.claims.sonnet_calls_saved_vs_jev_sonnet).toBe(14);
  });
  it.each(["inflated-summary", "changed-route", "lost-review-flag", "modified-reference", "wrong-token-cost", "duplicate-ticket"])("rejects %s", (kind) => {
    const copy = structuredClone(report);
    const row = copy.records[0];
    if (kind === "inflated-summary") copy.summaries[0].category_correct++;
    if (kind === "changed-route") row.strategies["jev-nano-sonnet"].calls = ["sonnet"];
    if (kind === "lost-review-flag") row.strategies["jev-nano-sonnet"].review_required = !row.strategies["jev-nano-sonnet"].review_required;
    if (kind === "modified-reference") row.label.intended_category = row.label.intended_category === "auth" ? "other" : "auth";
    if (kind === "wrong-token-cost") row.stages.jev.estimated_market_cost_usd += .01;
    if (kind === "duplicate-ticket") copy.records[1] = copy.records[0];
    expect(() => auditEvidence(copy, labels)).toThrow("Evidence mismatch");
  });
});
