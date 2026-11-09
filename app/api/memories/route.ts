import { NextResponse } from "next/server";
import { getDatabasePool } from "@/lib/server/database";
import { getSignedInEmail } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8_000;
const MAX_CONTENT_LENGTH = 2_000;
const CATEGORIES = new Set(["preference", "personal", "project", "routine", "general"]);
const CREDENTIAL_PATTERN = /\b(password|passcode|api[\s_-]*key|secret|access token|refresh token|private key)\b/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MemoryBody = { id?: unknown; content?: unknown; category?: unknown; tags?: unknown; source?: unknown };

async function readBody(request: Request): Promise<MemoryBody | null> {
  const size = Number(request.headers.get("content-length"));
  if (Number.isFinite(size) && size > MAX_BODY_BYTES) return null;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? value as MemoryBody : null;
  } catch {
    return null;
  }
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim().toLowerCase().slice(0, 32))
    .filter(Boolean))].slice(0, 10);
}

function normalizeCategory(value: unknown): string {
  return typeof value === "string" && CATEGORIES.has(value) ? value : "general";
}

function storageUnavailable() {
  return NextResponse.json({ error: "Memory storage is unavailable. Check the local PostgreSQL connection and run the database migration." }, { status: 503 });
}

async function requireSignedIn() {
  return await getSignedInEmail()
    ? null
    : NextResponse.json({ error: "Sign in to use ULTRON." }, { status: 401 });
}

export async function GET(request: Request) {
  const accessError = await requireSignedIn();
  if (accessError) return accessError;
  if (!process.env.DATABASE_URL) return storageUnavailable();
  const query = new URL(request.url).searchParams.get("q")?.trim().slice(0, 160) ?? "";
  try {
    const { rows } = await getDatabasePool().query(
      `SELECT id, content, category, tags, source,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM public.ultron_memories
       WHERE $1 = '' OR
         to_tsvector('simple'::regconfig, content) @@ plainto_tsquery('simple'::regconfig, $1)
         OR content ILIKE $2 OR category ILIKE $2 OR array_to_string(tags, ' ') ILIKE $2
       ORDER BY updated_at DESC
       LIMIT 100`,
      [query, `%${query}%`],
    );
    return NextResponse.json({ memories: rows });
  } catch {
    return storageUnavailable();
  }
}

export async function POST(request: Request) {
  const accessError = await requireSignedIn();
  if (accessError) return accessError;
  if (!process.env.DATABASE_URL) return storageUnavailable();
  const body = await readBody(request);
  if (!body || typeof body.content !== "string") {
    return NextResponse.json({ error: "Provide valid memory text." }, { status: 400 });
  }
  const content = body.content.trim();
  if (!content || content.length > MAX_CONTENT_LENGTH) {
    return NextResponse.json({ error: "Memory text must be between 1 and 2000 characters." }, { status: 400 });
  }
  if (CREDENTIAL_PATTERN.test(content)) {
    return NextResponse.json({ error: "ULTRON will not store passwords, API keys, or access tokens as memories." }, { status: 400 });
  }

  try {
    const { rows } = await getDatabasePool().query(
      `INSERT INTO public.ultron_memories (content, category, tags, source)
       VALUES ($1, $2, $3, $4)
       RETURNING id, content, category, tags, source,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [content, normalizeCategory(body.category), normalizeTags(body.tags), body.source === "agent" ? "agent" : "user"],
    );
    return NextResponse.json({ memory: rows[0] }, { status: 201 });
  } catch {
    return storageUnavailable();
  }
}

export async function PATCH(request: Request) {
  const accessError = await requireSignedIn();
  if (accessError) return accessError;
  if (!process.env.DATABASE_URL) return storageUnavailable();
  const body = await readBody(request);
  if (!body || typeof body.id !== "string" || !UUID_PATTERN.test(body.id) || typeof body.content !== "string") {
    return NextResponse.json({ error: "Provide a valid memory ID and text." }, { status: 400 });
  }
  const content = body.content.trim();
  if (!content || content.length > MAX_CONTENT_LENGTH || CREDENTIAL_PATTERN.test(content)) {
    return NextResponse.json({ error: "Memory text is empty, too long, or contains a credential ULTRON cannot store." }, { status: 400 });
  }
  try {
    const { rows } = await getDatabasePool().query(
      `UPDATE public.ultron_memories
       SET content = $2, category = $3, tags = $4, updated_at = now()
       WHERE id = $1
       RETURNING id, content, category, tags, source,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [body.id, content, normalizeCategory(body.category), normalizeTags(body.tags)],
    );
    return rows[0]
      ? NextResponse.json({ memory: rows[0] })
      : NextResponse.json({ error: "Memory not found." }, { status: 404 });
  } catch {
    return storageUnavailable();
  }
}

export async function DELETE(request: Request) {
  const accessError = await requireSignedIn();
  if (accessError) return accessError;
  if (!process.env.DATABASE_URL) return storageUnavailable();
  const body = await readBody(request);
  if (!body || typeof body.id !== "string" || !UUID_PATTERN.test(body.id)) {
    return NextResponse.json({ error: "Provide a valid memory ID." }, { status: 400 });
  }
  try {
    const { rowCount } = await getDatabasePool().query(
      "DELETE FROM public.ultron_memories WHERE id = $1",
      [body.id],
    );
    return rowCount
      ? NextResponse.json({ deleted: true })
      : NextResponse.json({ error: "Memory not found." }, { status: 404 });
  } catch {
    return storageUnavailable();
  }
}
