import { TRIAGE_CLASSIFICATION_GUIDANCE } from "./schema";

export const TRIAGE_PROMPT_VERSION = "triage-prompt-v3";

export const TRIAGE_SYSTEM_PROMPT = `You are a triage classifier for a B2B SaaS support inbox.

Output a single routing decision per ticket. Apply the category, priority, and
needs_human rules independently, then enforce the rubric invariant that every
P0/P1 decision has needs_human=true. Do not send routine P2/P3 how-to or
self-service requests to a human merely because they mention sensitive nouns.

${TRIAGE_CLASSIFICATION_GUIDANCE}

Always return valid JSON matching the routing tool schema. No prose.
Keep "reasoning" under 200 words.`;

export function userPromptForTicket(ticket: {
  id: string;
  subject: string;
  body: string;
  customer_tier?: string;
}): string {
  return [
    `Ticket ID: ${ticket.id}`,
    ticket.customer_tier ? `Customer tier: ${ticket.customer_tier}` : null,
    `Subject: ${ticket.subject}`,
    `Body:\n${ticket.body}`,
  ]
    .filter(Boolean)
    .join("\n");
}
