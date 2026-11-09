import { NextResponse } from "next/server";
import { disconnectGoogle, getGoogleConnectionStatus } from "@/lib/server/google";
import { getSignedInEmail } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const email = await getSignedInEmail();
  if (!email) return NextResponse.json({ error: "Sign in to use ULTRON." }, { status: 401 });
  try {
    return NextResponse.json(await getGoogleConnectionStatus(email), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Google connection status is unavailable." }, { status: 503 });
  }
}

export async function DELETE() {
  const email = await getSignedInEmail();
  if (!email) return NextResponse.json({ error: "Sign in to use ULTRON." }, { status: 401 });
  try {
    await disconnectGoogle(email);
    return NextResponse.json({ disconnected: true });
  } catch {
    return NextResponse.json({ error: "Google could not be disconnected. Try again." }, { status: 503 });
  }
}
