import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DEFAULT_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];
const MODEL_TIMEOUT_MS = 12_000;
const MAX_TEXT = 2000;
const MAX_CONTEXT = 6000;
const MAX_CONTENTS = 24;
const MAX_CONTENTS_CHARS = 24_000;
const MAX_BODY_BYTES = 64_000;

const SYSTEM_PROMPT = [
  "You are ULTRON, a personal AI assistant.",
  "Use the available tools for time, notes, to-dos, timers, and project documentation when relevant.",
  "Never claim a tool action succeeded until you receive its result.",
  "Ask a brief follow-up when required information is missing or ambiguous.",
  "The tools only work in the user's current browser and do not access other applications.",
  "Keep answers clear and concise for voice playback.",
].join(" ");

const TOOLS = [{
  functionDeclarations: [
    { name: "get_time", description: "Get the user's current local time and date.", parameters: { type: "OBJECT", properties: {} } },
    { name: "search_project_docs", description: "Search ULTRON's README, docs, and knowledge files. Use for questions about this project.", parameters: { type: "OBJECT", properties: { query: { type: "STRING", description: "The topic or question to search for." } }, required: ["query"] } },
    { name: "create_note", description: "Save a personal note in this browser.", parameters: { type: "OBJECT", properties: { text: { type: "STRING", description: "The note to save." } }, required: ["text"] } },
    { name: "list_notes", description: "List saved personal notes from this browser.", parameters: { type: "OBJECT", properties: {} } },
    { name: "add_todo", description: "Add an item to the user's to-do list in this browser.", parameters: { type: "OBJECT", properties: { text: { type: "STRING", description: "The task to add." } }, required: ["text"] } },
    { name: "list_todos", description: "List to-do items from this browser.", parameters: { type: "OBJECT", properties: {} } },
    { name: "complete_todo", description: "Mark a to-do item complete using its displayed one-based number.", parameters: { type: "OBJECT", properties: { number: { type: "INTEGER", description: "The displayed to-do number." } }, required: ["number"] } },
    { name: "set_timer", description: "Set a timer of up to 24 hours in this browser. Use a duration such as '5 minutes' and optionally a reminder label.", parameters: { type: "OBJECT", properties: { duration: { type: "STRING", description: "Timer duration, such as '5 minutes' or '1 hour 30 minutes'." }, label: { type: "STRING", description: "Optional reason for the reminder." } }, required: ["duration"] } },
    { name: "list_timers", description: "List active timers in this browser.", parameters: { type: "OBJECT", properties: {} } },
  ],
}];

type GeminiPart = {
  text?: string;
  thoughtSignature?: string;
  functionCall?: { name?: string; id?: string; args?: unknown };
  functionResponse?: unknown;
};
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiData = {
  candidates?: Array<{ content?: GeminiContent }>;
  error?: { message?: string };
};

class ModelTimeoutError extends Error {}
class PayloadTooLargeError extends Error {}

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) throw new PayloadTooLargeError();
  if (!request.body) throw new SyntaxError("Missing request body.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function normalizeContents(input: unknown): GeminiContent[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CONTENTS) return null;
  const contents: GeminiContent[] = [];
  let totalChars = 0;

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const raw = item as { role?: unknown; parts?: unknown };
    if ((raw.role !== "user" && raw.role !== "model") || !Array.isArray(raw.parts)) continue;
    const parts: GeminiPart[] = [];
    for (const rawPart of raw.parts.slice(0, 8)) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      if (typeof part.text === "string") {
        const text = part.text.slice(0, MAX_TEXT);
        totalChars += text.length;
        parts.push({ text });
      } else if (part.functionCall && typeof part.functionCall === "object") {
        const call = part.functionCall as Record<string, unknown>;
        if (typeof call.name !== "string" || !call.args || typeof call.args !== "object") continue;
        parts.push({
          functionCall: {
            name: call.name.slice(0, 80),
            ...(typeof call.id === "string" ? { id: call.id.slice(0, 120) } : {}),
            args: call.args,
          },
          ...(typeof part.thoughtSignature === "string" ? { thoughtSignature: part.thoughtSignature.slice(0, 4000) } : {}),
        });
        totalChars += JSON.stringify(call.args).length;
      } else if (part.functionResponse && typeof part.functionResponse === "object") {
        const response = part.functionResponse as Record<string, unknown>;
        if (typeof response.name !== "string" || !response.response || typeof response.response !== "object") continue;
        parts.push({ functionResponse: {
          name: response.name.slice(0, 80),
          ...(typeof response.id === "string" ? { id: response.id.slice(0, 120) } : {}),
          response: response.response,
        } });
        totalChars += JSON.stringify(response.response).length;
      }
    }
    if (parts.length) contents.push({ role: raw.role, parts });
  }

  if (!contents.length || totalChars > MAX_CONTENTS_CHARS || contents[contents.length - 1].role !== "user") return null;
  return contents;
}

async function requestModel(model: string, apiKey: string, payload: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch((error: unknown) => {
      if (controller.signal.aborted) throw error;
      return {};
    }) as GeminiData;
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted) throw new ModelTimeoutError("Gemini request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY is missing. Add it to .env.local and restart the server." }, { status: 500 });

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(request);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json({ error: "Agent request is too large." }, { status: 413 });
    }
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const body = rawBody && typeof rawBody === "object" ? rawBody as { contents?: unknown; context?: unknown } : {};

  const contents = normalizeContents(body.contents);
  if (!contents) return NextResponse.json({ error: "Conversation is invalid or too large." }, { status: 400 });
  const context = typeof body.context === "string" ? body.context.trim().slice(0, MAX_CONTEXT) : "";
  const systemText = context
    ? `${SYSTEM_PROMPT}\n\nProject documentation excerpts follow. Ground project answers in these excerpts and cite the file name. If they do not answer the question, say so.\n\n${context}`
    : SYSTEM_PROMPT;

  const preferred = process.env.GEMINI_MODEL?.trim();
  const models = preferred ? [preferred, ...DEFAULT_MODELS.filter((model) => model !== preferred)] : DEFAULT_MODELS;
  let lastError = "Gemini request failed.";
  let lastStatus = 502;

  for (const model of models) {
    try {
      const { response, data } = await requestModel(model, apiKey, {
        systemInstruction: { parts: [{ text: systemText }] },
        contents,
        tools: TOOLS,
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      });

      if (response.ok) {
        const modelContent = data.candidates?.[0]?.content;
        const parts = modelContent?.parts ?? [];
        const toolCalls = parts.flatMap((part) => part.functionCall ? [part.functionCall] : []);
        if (toolCalls.length && modelContent) return NextResponse.json({ modelContent, toolCalls, model });
        const reply = parts.map((part) => part.text ?? "").join("\n").trim();
        if (reply) return NextResponse.json({ reply, model });
        lastError = `${model} returned no text.`;
        continue;
      }

      lastError = data.error?.message || `${model} failed (${response.status}).`;
      lastStatus = response.status === 504 ? 504 : 502;
      console.error(`[agent] ${model} -> ${response.status}: ${lastError}`);
      if ([404, 429, 500, 503, 504].includes(response.status)) continue;
      return NextResponse.json({ error: lastError }, { status: 502 });
    } catch (error) {
      lastError = error instanceof ModelTimeoutError ? `${model} timed out after ${MODEL_TIMEOUT_MS / 1000} seconds.` : `${model} could not be reached.`;
      lastStatus = error instanceof ModelTimeoutError ? 504 : 502;
      console.warn(`[agent] ${lastError}`);
    }
  }

  return NextResponse.json({
    error: lastStatus === 504 ? "The AI service took too long to respond. Please try again." : lastError,
  }, { status: lastStatus });
}
