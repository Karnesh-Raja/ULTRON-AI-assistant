import { NextResponse } from "next/server";
import { searchGmail, sendGmail } from "@/lib/server/google";
import { getSignedInEmail } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const email = await getSignedInEmail();
  if (!email) return NextResponse.json({ error: "Sign in to use ULTRON." }, { status: 401 });
  const query = new URL(request.url).searchParams.get("q")?.trim().slice(0, 200) ?? "";
  if (!query) return NextResponse.json({ error: "Provide a Gmail search phrase." }, { status: 400 });
  try {
    return NextResponse.json({ messages: await searchGmail(email, query) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gmail search failed.";
    const status = message.startsWith("Connect ") || message.startsWith("Reconnect ") ? 409 : message.startsWith("Google access") ? 403 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: Request) {
  const email = await getSignedInEmail();
  if (!email) return NextResponse.json({ error: "Sign in to use ULTRON." }, { status: 401 });
  let input: unknown;
  try { input = await request.json(); } catch { return NextResponse.json({ error: "Request must be valid JSON." }, { status: 400 }); }
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const to = typeof body.to === "string" ? body.to.trim().slice(0, 254) : "";
  const subject = typeof body.subject === "string" ? body.subject.trim().slice(0, 240) : "";
  const text = typeof body.body === "string" ? body.body.trim().slice(0, 8_000) : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !subject || !text) {
    return NextResponse.json({ error: "Provide a valid recipient, subject, and message." }, { status: 400 });
  }
  try {
    const sent = await sendGmail(email, { to, subject, body: text }) as { id?: string; threadId?: string };
    return NextResponse.json({ sent: true, id: sent.id ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email could not be sent.";
    const status = message.startsWith("Reconnect ") ? 409 : message.startsWith("Google access") ? 403 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
