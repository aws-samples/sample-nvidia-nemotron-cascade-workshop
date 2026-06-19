import { TICKET_CATEGORIES, TICKET_PRIORITIES } from "./schema";

export const TRIAGE_SYSTEM_PROMPT = `You are a triage classifier for a B2B SaaS support inbox.

Output a single routing decision per ticket. Be conservative: if a ticket
mentions data loss, security, or revenue-impacting outage, treat it as P0
and set needs_human=true.

Categories: ${TICKET_CATEGORIES.join(", ")}
Priorities: ${TICKET_PRIORITIES.join(", ")}

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
