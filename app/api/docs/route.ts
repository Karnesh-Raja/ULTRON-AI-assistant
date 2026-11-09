import { NextResponse } from "next/server";
import { getSignedInEmail } from "@/lib/server/session";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Project documentation search.
 * Indexes README.md plus every .md / .mdx / .txt file inside the folders listed below
 * (the project root only - nothing outside the project can be read).
 * Drop your own documentation into /knowledge and it is searchable immediately.
 */
const ROOT = process.cwd();
const FOLDERS = ["knowledge", "docs"];
const ROOT_FILES = ["README.md"];
const EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const MAX_FILES = 200;
const MAX_FILE_BYTES = 500_000;
const MAX_DEPTH = 3;
const CHUNK_CHARS = 700;
const SNIPPET_CHARS = 420;

interface Chunk {
  file: string;
  heading: string;
  text: string;
  tokens: string[];
}

const STOP = new Set(
  "a an and are as at be but by do does for from how i in is it its me my of on or our so than that the their then there these this to us was we what when where which who why will with you your about say tell docs doc documentation project".split(" "),
);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

async function collectFiles(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(full, depth + 1, out);
    else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
}

function chunkFile(file: string, content: string): Chunk[] {
  const chunks: Chunk[] = [];
  let heading = path.basename(file);
  let buffer = "";
  const flush = () => {
    const text = buffer.trim();
    buffer = "";
    if (text.length < 20) return;
    chunks.push({ file, heading, text, tokens: tokenize(`${heading} ${text}`) });
  };
  for (const line of content.split(/\r?\n/)) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      flush();
      heading = h[1].trim();
      continue;
    }
    buffer += line + "\n";
    if (buffer.length >= CHUNK_CHARS && line.trim() === "") flush();
  }
  flush();
  return chunks;
}

async function buildIndex(): Promise<{ chunks: Chunk[]; files: string[] }> {
  const paths: string[] = [];
  for (const f of ROOT_FILES) paths.push(path.join(ROOT, f));
  for (const folder of FOLDERS) await collectFiles(path.join(ROOT, folder), 0, paths);

  const chunks: Chunk[] = [];
  const files: string[] = [];
  for (const full of paths) {
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(full, "utf8");
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      files.push(rel);
      chunks.push(...chunkFile(rel, content));
    } catch {
      /* unreadable file - skip */
    }
  }
  return { chunks, files };
}

function snippetFor(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = Math.max(0, at === -1 ? 0 : at - 80);
  const slice = flat.slice(start, start + SNIPPET_CHARS);
  return (start > 0 ? "…" : "") + slice + (start + SNIPPET_CHARS < flat.length ? "…" : "");
}

export async function GET(request: Request) {
  if (!await getSignedInEmail()) return NextResponse.json({ error: "Sign in to use ULTRON." }, { status: 401 });
  const query = new URL(request.url).searchParams.get("q")?.trim().slice(0, 200) ?? "";
  const { chunks, files } = await buildIndex();

  if (!query) return NextResponse.json({ files, results: [] });

  const terms = Array.from(new Set(tokenize(query)));
  if (!terms.length) return NextResponse.json({ files, results: [] });

  // document frequency for a simple TF-IDF style score
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, chunks.filter((c) => c.tokens.includes(t)).length);

  const scored = chunks
    .map((c) => {
      let score = 0;
      const headingTokens = tokenize(c.heading);
      for (const t of terms) {
        const tf = c.tokens.filter((x) => x === t || (t.length > 3 && x.startsWith(t))).length;
        if (!tf) continue;
        const idf = Math.log(1 + chunks.length / (1 + (df.get(t) ?? 0)));
        score += (1 + Math.log(tf)) * idf;
        if (headingTokens.includes(t)) score += idf * 1.5; // heading matches count extra
      }
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ c, score }) => ({
      file: c.file,
      heading: c.heading,
      snippet: snippetFor(c.text, terms),
      score: Math.round(score * 100) / 100,
    }));

  return NextResponse.json({ files, results: scored });
}
