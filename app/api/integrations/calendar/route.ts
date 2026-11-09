import { NextResponse } from "next/server";
import { createCalendarEvent, listCalendarEvents } from "@/lib/server/google";
import { getSignedInEmail } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const email = await getSignedInEmail();
  if (!email) return NextResponse.json({ error: "Sign in to use ULTRON." }, { status: 401 });
  const url = new URL(request.url);
  const start = url.searchParams.get("from") ? new Date(url.searchParams.get("from")!) : new Date();
  const end = url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || end.getTime() - start.getTime() > 31 * 24 * 60 * 60 * 1000) {
    return NextResponse.json({ error: "Choose a valid date range no longer than 31 days." }, { status: 400 });
  }
  try {
    return NextResponse.json({ events: await listCalendarEvents(email, start, end) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Calendar could not be read.";
    const status = message.startsWith("Reconnect ") ? 409 : message.startsWith("Google access") ? 403 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: Request) {
  const email = await getSignedInEmail();
  if (!email) return NextResponse.json({ error: "Sign in to use ULTRON." }, { status: 401 });
  let input: unknown;
  try { input = await request.json(); } catch { return NextResponse.json({ error: "Request must be valid JSON." }, { status: 400 }); }
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  const description = typeof body.description === "string" ? body.description.slice(0, 2_000) : "";
  const start = typeof body.start === "string" ? body.start : "";
  const end = typeof body.end === "string" ? body.end : "";
  const timeZone = typeof body.timeZone === "string" ? body.timeZone.slice(0, 80) : undefined;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (!title || !Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= startDate) {
    return NextResponse.json({ error: "Provide an event title and valid start/end times." }, { status: 400 });
  }
  try {
    const created = await createCalendarEvent(email, { title, description, start: startDate.toISOString(), end: endDate.toISOString(), timeZone }) as { id?: string; htmlLink?: string };
    return NextResponse.json({ created: true, id: created.id ?? null, htmlLink: created.htmlLink ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Calendar event could not be created.";
    const status = message.startsWith("Reconnect ") ? 409 : message.startsWith("Google access") ? 403 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
