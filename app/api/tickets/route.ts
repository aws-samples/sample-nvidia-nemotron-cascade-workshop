import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export async function GET() {
  const filePath = path.join(process.cwd(), "data", "sample-tickets.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  const tickets = JSON.parse(raw);
  return NextResponse.json(tickets);
}
