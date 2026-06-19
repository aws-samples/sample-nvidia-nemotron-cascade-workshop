import { NextResponse, type NextRequest } from "next/server";
import { triageTicket } from "@/lib/bedrock/client";
import { TicketSchema } from "@/lib/triage/schema";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const parsed = TicketSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid ticket payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const decision = await triageTicket(parsed.data);
    return NextResponse.json(decision);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Triage failed", detail: message },
      { status: 500 },
    );
  }
}
