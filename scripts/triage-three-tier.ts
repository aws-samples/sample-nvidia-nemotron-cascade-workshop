#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { triageThreeTier } from "../lib/cascade/three-tier";
import { TicketSchema } from "../lib/triage/schema";

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === "--help") {
    console.log("Usage: npm run triage:three-tier -- <ticket.json|--example|->\nRequires AI_GATEWAY_API_KEY and AWS default credentials. '-' reads ticket JSON from stdin.");
    return;
  }
  const input: unknown = arg === "--example" ? {
    id: "demo-invoice",
    subject: "Download an invoice",
    body: "Where in the dashboard can I download a PDF of last month's invoice?",
    customer_tier: "pro",
  } : JSON.parse(readFileSync(arg === "-" ? 0 : arg, "utf8"));
  const result = await triageThreeTier(TicketSchema.parse(input));
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Three-tier triage failed.");
  process.exitCode = 1;
});
