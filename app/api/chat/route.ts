import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Tried in order. If one is retired (404), out of quota (429) or busy (503),
// the next one is used. Override the first choice with GEMINI_MODEL in .env.local.
const DEFAULT_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];

const SYSTEM_PROMPT = [
  "You are ULTRON, a helpful futuristic desktop AI assistant inspired by a sci-fi holographic interface.",
  "Speak clearly and naturally, with concise answers suitable for being read aloud (no markdown, no bullet symbols, no emojis).",
  "Address the user politely when appropriate. Do not claim to control the computer or access information you do not have.",
  "You can see the earlier messages of this conversation: use them to understand follow-up questions such as 'explain that again' or 'give another example'.",
  "The app itself (not you) handles: telling the time and date, opening websites, notes, to-do lists, timers and reminders, and searching project documentation. If the user wants one of those, tell them to say it directly, for example 'set a timer for five minutes'.",
].join(" ");

const MAX_HISTORY = 20;
const MAX_TEXT = 2000;
const MAX_CONTEXT = 6000;
const MODEL_TIMEOUT_MS = 12_000;

type Turn = { role: "user" | "model"; parts: Array<{ text: string }> };

type GeminiData = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
};

class ModelTimeoutError extends Error {
  constructor() {
    super("Gemini request timed out.");
    this.name = "ModelTimeoutError";
  }
}

/** Bound both the upstream request and response-body read for one model attempt. */
async function requestModel(
  model: string,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<{ response: Response; data: GeminiData }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    const data = (await response.json().catch((error: unknown) => {
      if (controller.signal.aborted) throw error;
      return {};
    })) as GeminiData;
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted) throw new ModelTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Validate client history and turn it into Gemini "contents" (alternating, starts with user). */
function buildContents(history: unknown, message: string): Turn[] {
  const turns: Turn[] = [];
  const push = (role: "user" | "model", text: string) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n" + text; // merge same-role neighbours
    else turns.push({ role, parts: [{ text }] });
  };
  if (Array.isArray(history)) {
    for (const item of history.slice(-MAX_HISTORY)) {
      if (!item || typeof item !== "object") continue;
      const { role, text } = item as { role?: unknown; text?: unknown };
      if ((role !== "user" && role !== "assistant") || typeof text !== "string") continue;
      const clean = text.trim().slice(0, MAX_TEXT);
      if (!clean) continue;
      push(role === "user" ? "user" : "model", clean);
    }
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  push("user", message);
  return turns;
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY is missing. Add it to .env.local and restart the server." },
        { status: 500 },
      );
    }

    let body: { message?: unknown; history?: unknown; context?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return NextResponse.json({ error: "Please enter a message." }, { status: 400 });
    if (message.length > MAX_TEXT) {
      return NextResponse.json({ error: "Message is too long (maximum 2000 characters)." }, { status: 400 });
    }

    const context = typeof body.context === "string" ? body.context.trim().slice(0, MAX_CONTEXT) : "";
    const systemText = context
      ? `${SYSTEM_PROMPT}\n\nProject documentation excerpts are provided below. Answer using them and mention the file name you used. If they do not contain the answer, say so briefly instead of guessing.\n\n${context}`
      : SYSTEM_PROMPT;
    const contents = buildContents(body.history, message);

    const preferred = process.env.GEMINI_MODEL?.trim();
    const models = preferred
      ? [preferred, ...DEFAULT_MODELS.filter((m) => m !== preferred)]
      : DEFAULT_MODELS;

    let lastError = "Gemini request failed.";
    let lastStatus = 502;

    for (const model of models) {
      let geminiResponse: Response;
      let data: GeminiData;
      try {
        ({ response: geminiResponse, data } = await requestModel(model, apiKey, {
          systemInstruction: { parts: [{ text: systemText }] },
          contents,
          // Larger budget so newer "thinking" models still have room to answer.
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
        }));
      } catch (error) {
        if (error instanceof ModelTimeoutError) {
          lastError = `${model} timed out after ${MODEL_TIMEOUT_MS / 1000} seconds.`;
          lastStatus = 504;
          console.warn(`[chat] ${lastError}`);
          continue;
        }
        lastError = `${model} could not be reached.`;
        lastStatus = 502;
        console.error(`[chat] ${model} request failed:`, error);
        continue;
      }

      if (geminiResponse.ok) {
        const reply = data.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || "")
          .join("\n")
          .trim();
        if (reply) return NextResponse.json({ reply, model });
        lastError = `${model} returned no text.`;
        continue;
      }

      lastError = data.error?.message || `${model} failed (${geminiResponse.status}).`;
      lastStatus = geminiResponse.status === 504 ? 504 : 502;
      console.error(`[chat] ${model} -> ${geminiResponse.status}: ${lastError}`);

      // Model missing, unavailable, overloaded, or timed out: try the next model.
      if ([404, 429, 500, 503, 504].includes(geminiResponse.status)) continue;

      // Anything else (e.g. 400 or 403 for a bad API key) will fail on every model.
      return NextResponse.json({ error: lastError }, { status: 502 });
    }

    return NextResponse.json(
      {
        error: lastStatus === 504
          ? "The AI service took too long to respond. Please try again."
          : lastError,
      },
      { status: lastStatus },
    );
  } catch {
    return NextResponse.json({ error: "Could not process the request. Check your connection and try again." }, { status: 500 });
  }
}
