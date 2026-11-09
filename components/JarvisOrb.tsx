"use client";

import ChessPanel from "./ChessPanel";
import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi, type OrbState, type OrbTheme } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import { WakeWordListener, type WakeState } from "@/lib/wakeWord";
import { getRecognitionCtor, type SpeechRecognitionLike } from "@/lib/speech";
import { beep } from "@/lib/audio";
import { APP_SHORTCUTS, findSite } from "@/lib/sites";
import {
  browserStore,
  completeTodo,
  createNote,
  createTimer,
  createTodo,
  formatClock,
  formatDuration,
  getNotes,
  getTimers,
  getTodos,
  popExpiredTimers,
  removeNote,
  removeTimer,
  removeTodo,
  runLocalCommand,
  toggleTodo,
  type AssistantResult,
  type Note,
  type PanelId,
  type TimerItem,
  type Todo,
} from "@/lib/assistant";

type CameraState = "off" | "starting" | "on" | "error";
type InputSource = "typed" | "voice";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
}
interface DocHit {
  file: string;
  heading: string;
  snippet: string;
  score: number;
}
interface MemoryRecord {
  id: string;
  content: string;
  category: string;
  tags: string[];
  source: "user" | "agent";
  createdAt: string;
  updatedAt: string;
}

interface AgentContent {
  role: "user" | "model";
  parts: Array<Record<string, unknown>>;
}

interface AgentToolCall {
  name?: string;
  id?: string;
  args?: unknown;
}

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

const STATE_LABEL: Record<OrbState, string> = {
  idle: "IDLE",
  listening: "LISTENING",
  thinking: "THINKING",
  speaking: "SPEAKING",
  error: "ERROR",
  paused: "PAUSED",
};

const PANELS: PanelId[] = ["chat", "tasks", "docs", "memory", "study", "chess"];
const THEME_OPTIONS: Array<{ id: OrbTheme; label: string; color: string }> = [
  { id: "orange", label: "Orange", color: "#ffad32" },
  { id: "blue", label: "Blue", color: "#42d8ff" },
  { id: "violet", label: "Violet", color: "#bd8cff" },
  { id: "teal", label: "Teal", color: "#4ff0ce" },
  { id: "rose", label: "Rose", color: "#ff78bd" },
];
const HISTORY_KEY = "ultron.history";
const MAX_STORED_MESSAGES = 60;
const MAX_SENT_MESSAGES = 12;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_ICON_POSITIONS = [
  [18, 30], [39, 18], [61, 18], [82, 30],
  [18, 69], [39, 82], [61, 82], [82, 69],
] as const;
const APP_DWELL_MS = 4500;

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const cyclePanel = (current: PanelId, step: 1 | -1): PanelId =>
  PANELS[(PANELS.indexOf(current) + step + PANELS.length) % PANELS.length];

/** Chrome stops reading long text, so speak it sentence group by sentence group. */
function splitForSpeech(text: string, max = 220): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).length > max) {
      out.push(cur.trim());
      cur = s;
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.flatMap((p) =>
    p.length <= max * 1.5 ? [p] : (p.match(new RegExp(`.{1,${max}}(\\s|$)`, "g")) ?? [p]).map((x) => x.trim()),
  );
}

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const chatListRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const wakeRef = useRef<WakeWordListener | null>(null);
  const pttRecRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);

  const speakIdRef = useRef(0);
  const busyRef = useRef(false);
  const pausedRef = useRef(false);
  const wakeOnRef = useRef(false);
  const pttRef = useRef(false);
  const speakingRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const timersRef = useRef<TimerItem[]>([]);
  const panelRef = useRef<PanelId>("chat");
  const processRef = useRef<(text: string, via: InputSource) => void>(() => {});
  const historyLoadedRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPauseRef = useRef(true);
  const mountedRef = useRef(true);
  const appPointerRef = useRef<{ x: number; y: number } | null>(null);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle", palm: 0 });
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [orbTheme, setOrbTheme] = useState<OrbTheme>("orange");
  const [appLauncherOpen, setAppLauncherOpen] = useState(false);
  const [appPointer, setAppPointer] = useState<{ x: number; y: number } | null>(null);
  const [hoveredApp, setHoveredApp] = useState<string | null>(null);
  const [dwellProgress, setDwellProgress] = useState(0);
  const [textPanelOpen, setTextPanelOpen] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [listening, setListening] = useState(false); // push-to-talk mic
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [errorFlash, setErrorFlash] = useState(false);
  const [wakeOn, setWakeOn] = useState(false);
  const [wakeState, setWakeState] = useState<WakeState>("off");
  const [panel, setPanel] = useState<PanelId>("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [timers, setTimers] = useState<TimerItem[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [docHits, setDocHits] = useState<DocHit[]>([]);
  const [docQuery, setDocQuery] = useState("");
  const [docFiles, setDocFiles] = useState<number | null>(null);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<{ url: string; label: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [studyFen, setStudyFen] = useState("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      trackerRef.current?.stop();
      trackerRef.current = null;
    };
  }, []);

  useEffect(() => { appPointerRef.current = appPointer; }, [appPointer]);

  const wakeCapturing = wakeState === "capturing";
  const orbState: OrbState = paused
    ? "paused"
    : speaking
      ? "speaking"
      : thinking
        ? "thinking"
        : errorFlash
          ? "error"
          : listening || wakeCapturing
            ? "listening"
            : "idle";

  /* ───────────── small UI helpers ───────────── */

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 1800);
  }, []);

  const flashError = useCallback(() => {
    setErrorFlash(true);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setErrorFlash(false), 4000);
  }, []);

  const pushMessage = useCallback((role: ChatMessage["role"], text: string) => {
    const next = [...messagesRef.current, { id: newId(), role, text, at: Date.now() }].slice(-MAX_STORED_MESSAGES);
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const clearMessages = useCallback(() => {
    messagesRef.current = [];
    setMessages([]);
  }, []);

  const refreshData = useCallback(() => {
    const t = getTimers(browserStore);
    timersRef.current = t;
    setNotes(getNotes(browserStore));
    setTodos(getTodos(browserStore));
    setTimers(t);
  }, []);

  const refreshMemories = useCallback(async () => {
    setMemoryLoading(true);
    setMemoryError(null);
    try {
      const response = await fetch("/api/memories", { cache: "no-store" });
      const data = await response.json().catch(() => ({})) as { memories?: MemoryRecord[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Memory storage could not be reached.");
      setMemories(data.memories ?? []);
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : "Memory storage could not be reached.");
    } finally {
      setMemoryLoading(false);
    }
  }, []);

  /* ───────────── speaking (system voice - no API key) ───────────── */

  const resumeWakeIfNeeded = useCallback(() => {
    if (wakeOnRef.current && !pausedRef.current && !pttRef.current && !speakingRef.current) {
      wakeRef.current?.resume();
    }
  }, []);

  const finishSpeaking = useCallback(
    (id: number) => {
      if (speakIdRef.current !== id) return; // a newer utterance took over
      speakingRef.current = false;
      setSpeaking(false);
      resumeWakeIfNeeded();
    },
    [resumeWakeIfNeeded],
  );

  const cancelSpeech = useCallback(() => {
    speakIdRef.current++; // invalidates callbacks of the utterances being cancelled
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    speakingRef.current = false;
    setSpeaking(false);
    resumeWakeIfNeeded();
  }, [resumeWakeIfNeeded]);

  const speak = useCallback(
    (text: string) => {
      if (pausedRef.current) return; // paused = muted
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        setError("SPEECH OUTPUT IS NOT SUPPORTED IN THIS BROWSER");
        return;
      }
      const clean = text
        .replace(/```[\s\S]*?```/g, " code omitted. ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`#>~|]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!clean) return;

      const synth = window.speechSynthesis;
      synth.cancel();
      const id = ++speakIdRef.current;
      const chunks = splitForSpeech(clean);
      wakeRef.current?.pause(); // don't let the wake word hear ULTRON itself
      speakingRef.current = true;
      setSpeaking(true);

      chunks.forEach((chunk, i) => {
        const utterance = new SpeechSynthesisUtterance(chunk);
        utterance.lang = "en-IN";
        if (voiceRef.current) utterance.voice = voiceRef.current;
        utterance.rate = 0.94;
        utterance.pitch = 0.82;
        utterance.volume = 1;
        utterance.onboundary = () => sceneRef.current?.pulse(0.8);
        utterance.onend = () => {
          if (i === chunks.length - 1) finishSpeaking(id);
        };
        utterance.onerror = () => finishSpeaking(id);
        synth.speak(utterance);
      });
    },
    [finishSpeaking],
  );

  /* ───────────── asking ULTRON ───────────── */

  const executeAgentTool = useCallback(async (call: AgentToolCall): Promise<Record<string, unknown>> => {
    const args = call.args && typeof call.args === "object" && !Array.isArray(call.args)
      ? call.args as Record<string, unknown>
      : {};
    const textArg = (name: string, max = 500) =>
      typeof args[name] === "string" ? (args[name] as string).trim().slice(0, max) : "";

    switch (call.name) {
      case "get_time": {
        const now = new Date();
        return { time: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), date: now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" }) };
      }
      case "search_project_docs": {
        const query = textArg("query", 200);
        if (!query) return { error: "A search query is required." };
        const response = await fetch(`/api/docs?q=${encodeURIComponent(query)}`);
        const data = await response.json().catch(() => ({})) as { results?: DocHit[]; files?: string[] };
        if (!response.ok) return { error: "Project documentation search failed." };
        const hits = (data.results ?? []).slice(0, 5);
        setDocQuery(query);
        setDocHits(hits);
        setDocFiles(data.files?.length ?? 0);
        panelRef.current = "docs";
        setPanel("docs");
        return { filesSearched: data.files?.length ?? 0, results: hits.map(({ file, heading, snippet }) => ({ file, heading, snippet })) };
      }
      case "create_note": {
        const note = createNote(browserStore, textArg("text", 2000));
        if (!note) return { error: "The note was empty." };
        refreshData();
        panelRef.current = "tasks";
        setPanel("tasks");
        return { saved: true, text: note.text, createdAt: note.at };
      }
      case "list_notes":
        return { notes: getNotes(browserStore).slice(-10).map(({ text, at }) => ({ text: text.slice(0, 500), at })) };
      case "add_todo": {
        const todo = createTodo(browserStore, textArg("text"));
        if (!todo) return { error: "The to-do was empty." };
        refreshData();
        panelRef.current = "tasks";
        setPanel("tasks");
        return { added: true, text: todo.text };
      }
      case "list_todos":
        return { todos: getTodos(browserStore).slice(0, 30).map(({ text, done }, index) => ({ number: index + 1, text: text.slice(0, 300), done })) };
      case "complete_todo": {
        const number = typeof args.number === "number" ? args.number : Number.NaN;
        const todo = completeTodo(browserStore, number);
        if (!todo) return { error: "No to-do exists with that number." };
        refreshData();
        panelRef.current = "tasks";
        setPanel("tasks");
        return { completed: true, text: todo.text };
      }
      case "set_timer": {
        const timer = createTimer(browserStore, textArg("duration", 100), textArg("label", 300));
        if (!timer) return { error: "That duration is invalid or longer than 24 hours." };
        refreshData();
        panelRef.current = "tasks";
        setPanel("tasks");
        return { set: true, label: timer.label, durationMs: timer.durationMs, endsAt: timer.endsAt };
      }
      case "list_timers":
        return { timers: getTimers(browserStore).slice(0, 20).map(({ label, durationMs, endsAt }) => ({ label, durationMs, endsAt })) };
      case "remember_information": {
        const content = textArg("content", 2000);
        if (!content) return { error: "Memory content is required." };
        const category = textArg("category", 20);
        const tags = Array.isArray(args.tags)
          ? args.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 10)
          : [];
        const response = await fetch("/api/memories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, category, tags, source: "agent" }),
        });
        const data = await response.json().catch(() => ({})) as { memory?: MemoryRecord; error?: string };
        if (!response.ok || !data.memory) return { error: data.error || "Memory could not be saved." };
        setMemories((current) => [data.memory!, ...current.filter((item) => item.id !== data.memory!.id)]);
        return { saved: true, id: data.memory.id, content: data.memory.content, category: data.memory.category };
      }
      case "search_memories": {
        const query = textArg("query", 160);
        if (!query) return { error: "A memory search phrase is required." };
        const response = await fetch(`/api/memories?q=${encodeURIComponent(query)}`, { cache: "no-store" });
        const data = await response.json().catch(() => ({})) as { memories?: MemoryRecord[]; error?: string };
        if (!response.ok) return { error: data.error || "Saved memories could not be searched." };
        return { matches: (data.memories ?? []).slice(0, 5).map(({ id, content, category, tags }) => ({ id, content, category, tags })) };
      }
      case "forget_memory": {
        const id = textArg("id", 36);
        if (!UUID_PATTERN.test(id)) return { error: "A specific saved memory ID is required." };
        const response = await fetch("/api/memories", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        const data = await response.json().catch(() => ({})) as { deleted?: boolean; error?: string };
        if (!response.ok) return { error: data.error || "Memory could not be deleted." };
        setMemories((current) => current.filter((item) => item.id !== id));
        return { deleted: data.deleted === true };
      }
      default:
        return { error: "This tool is not available." };
    }
  }, [refreshData]);

  const callAgent = useCallback(async (message: string, history: ChatMessage[]) => {
    const contents: AgentContent[] = [];
    for (const item of history.slice(-MAX_SENT_MESSAGES)) {
      const text = item.text.trim().slice(0, 2000);
      if (!text) continue;
      const role = item.role === "user" ? "user" : "model";
      const last = contents[contents.length - 1];
      if (last?.role === role && typeof last.parts[0]?.text === "string") {
        last.parts[0].text = `${last.parts[0].text as string}\n${text}`;
      } else {
        contents.push({ role, parts: [{ text }] });
      }
    }
    while (contents.length && contents[0].role !== "user") contents.shift();
    contents.push({ role: "user", parts: [{ text: message.slice(0, 2000) }] });

    const controller = new AbortController();
    const overallTimeout = window.setTimeout(() => controller.abort(), 90_000);
    let toolCount = 0;
    try {
      for (let round = 0; round < 4; round++) {
        const response = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents }),
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({})) as {
          reply?: string;
          error?: string;
          modelContent?: AgentContent;
          toolCalls?: AgentToolCall[];
        };
        if (!response.ok) throw new Error(data.error || "ULTRON could not respond.");
        const calls = data.toolCalls ?? [];
        if (!calls.length) {
          const answer = data.reply?.trim();
          if (!answer) throw new Error("ULTRON returned an empty response.");
          return answer;
        }
        if (!data.modelContent || data.modelContent.role !== "model" || !Array.isArray(data.modelContent.parts)) {
          throw new Error("ULTRON received an invalid tool request.");
        }
        toolCount += calls.length;
        if (toolCount > 8) throw new Error("ULTRON reached the tool-call limit for this request.");
        contents.push(data.modelContent);
        const functionResponses: Array<Record<string, unknown>> = [];
        for (const call of calls) {
          const name = call.name ?? "";
          const result = await executeAgentTool(call);
          functionResponses.push({ functionResponse: {
            name,
            ...(call.id ? { id: call.id } : {}),
            response: result,
          } });
        }
        contents.push({ role: "user", parts: functionResponses });
      }
      throw new Error("ULTRON reached the maximum number of agent steps.");
    } catch (error) {
      if (controller.signal.aborted) throw new Error("ULTRON's agent request timed out. Please try again.");
      throw error;
    } finally {
      window.clearTimeout(overallTimeout);
    }
  }, [executeAgentTool]);

  const callChat = useCallback(async (message: string, history: ChatMessage[], context?: string) => {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        history: history.slice(-MAX_SENT_MESSAGES).map((item) => ({ role: item.role, text: item.text })),
        context,
      }),
    });
    const data = await response.json().catch(() => ({})) as { reply?: string; error?: string };
    if (!response.ok) throw new Error(data.error || "ULTRON could not respond.");
    const answer = data.reply?.trim();
    if (!answer) throw new Error("ULTRON returned an empty response.");
    return answer;
  }, []);

  const runDocsSearch = useCallback(
    async (query: string, history: ChatMessage[]) => {
      setThinking(true);
      try {
        const res = await fetch(`/api/docs?q=${encodeURIComponent(query)}`);
        const data = (await res.json().catch(() => ({}))) as { results?: DocHit[]; files?: string[] };
        if (!res.ok) throw new Error("Documentation search failed.");
        const hits = data.results ?? [];
        setDocQuery(query);
        setDocHits(hits);
        setDocFiles(data.files?.length ?? 0);
        if (!hits.length) {
          const msg = `I couldn't find anything about ${query} in the project documentation.`;
          pushMessage("assistant", msg);
          speak(msg);
          return;
        }
        const context = hits
          .slice(0, 4)
          .map((h) => `[${h.file} - ${h.heading}]\n${h.snippet}`)
          .join("\n\n");
        let answer: string;
        try {
          answer = await callChat(`Using the documentation excerpts, answer this: ${query}`, history, context);
        } catch {
          // AI unavailable: still give the best raw match
          answer = `The best match is in ${hits[0].file}, section ${hits[0].heading}: ${hits[0].snippet}`;
        }
        pushMessage("assistant", answer);
        speak(answer);
      } finally {
        setThinking(false);
      }
    },
    [callChat, pushMessage, speak],
  );

  const openSite = useCallback((url: string): boolean => {
    const win = window.open(url, "_blank");
    if (!win) return false; // pop-up blocked (common for voice-triggered opens)
    try {
      win.opener = null;
    } catch {
      /* ignore */
    }
    return true;
  }, []);

  const launchApp = useCallback((key: string) => {
    const target = findSite(key);
    if (target) openSite(target.url);
    setAppLauncherOpen(false);
    setAppPointer(null);
    setHoveredApp(null);
  }, [openSite]);

  useEffect(() => {
    if (!appLauncherOpen || !appPointer) {
      setHoveredApp(null);
      setDwellProgress(0);
      return;
    }
    const x = appPointer.x * window.innerWidth;
    const y = appPointer.y * window.innerHeight;
    let hit: string | null = null;
    APP_SHORTCUTS.forEach((app, index) => {
      const [px, py] = APP_ICON_POSITIONS[index];
      const dx = x - (window.innerWidth * px) / 100;
      const dy = y - (window.innerHeight * py) / 100;
      if (Math.hypot(dx, dy) < Math.min(76, Math.max(42, window.innerWidth * 0.035))) hit = app.key;
    });
    setHoveredApp(hit);
  }, [appLauncherOpen, appPointer]);

  useEffect(() => {
    if (!hoveredApp || !appLauncherOpen) {
      setDwellProgress(0);
      return;
    }
    const started = performance.now();
    const timer = window.setInterval(() => {
      const progress = Math.min(1, (performance.now() - started) / APP_DWELL_MS);
      setDwellProgress(progress);
      if (progress >= 1) {
        window.clearInterval(timer);
        launchApp(hoveredApp);
      }
    }, 60);
    return () => window.clearInterval(timer);
  }, [hoveredApp, appLauncherOpen, launchApp]);

  const applyLocal = useCallback(
    async (local: AssistantResult, history: ChatMessage[]) => {
      let reply = local.reply;
      let silent = false;
      let docsQuery: string | null = null;

      for (const action of local.actions) {
        switch (action.type) {
          case "open":
            if (openSite(action.url)) setPendingLink(null);
            else {
              setPendingLink({ url: action.url, label: action.label });
              setPanel("chat");
              reply += " Your browser blocked the pop-up, so use the link below to open it.";
            }
            break;
          case "data":
            refreshData();
            break;
          case "panel":
            panelRef.current = action.panel;
            setPanel(action.panel);
            break;
          case "clearHistory":
            clearMessages();
            break;
          case "stopSpeaking":
            cancelSpeech();
            silent = true;
            break;
          case "docs":
            docsQuery = action.query;
            break;
        }
      }
      pushMessage("assistant", reply);
      if (!silent) speak(reply);
      if (docsQuery) await runDocsSearch(docsQuery, history);
    },
    [cancelSpeech, clearMessages, openSite, pushMessage, refreshData, runDocsSearch, speak],
  );

  const processInput = useCallback(
    async (input: string, via: InputSource) => {
      const text = input.trim();
      if (!text || busyRef.current) return;
      busyRef.current = true;
      const historyBefore = messagesRef.current;
      pushMessage("user", text);
      setPrompt("");
      setError(null);
      setPendingLink(null);
      try {
        const local = runLocalCommand(text, { store: browserStore, now: new Date() });
        if (local) {
          await applyLocal(local, historyBefore);
          return;
        }
        setThinking(true);
        const answer = await callAgent(text, historyBefore);
        pushMessage("assistant", answer);
        speak(answer);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Something went wrong.";
        setError(message.toUpperCase());
        pushMessage("assistant", `I could not get an answer: ${message}`);
        flashError();
        if (via === "voice") speak("Sorry, I could not reach the AI service.");
      } finally {
        setThinking(false);
        busyRef.current = false;
      }
    },
    [applyLocal, callAgent, flashError, pushMessage, speak],
  );

  useEffect(() => {
    processRef.current = (text, via) => void processInput(text, via);
  }, [processInput]);

  /* ───────────── microphone: push-to-talk ───────────── */

  const startListening = useCallback(() => {
    const Recognition = getRecognitionCtor();
    if (!Recognition) {
      setError("VOICE INPUT IS NOT SUPPORTED HERE. TRY CHROME OR TYPE YOUR MESSAGE.");
      return;
    }
    if (pausedRef.current) return;
    cancelSpeech();
    wakeRef.current?.pause(); // two recognizers can't share the mic
    pttRef.current = true;
    const recognition = new Recognition();
    recognition.lang = "en-IN";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) processRef.current(transcript, "voice");
    };
    recognition.onerror = () => {
      setError("MICROPHONE INPUT FAILED. CHECK YOUR BROWSER PERMISSIONS.");
      flashError();
    };
    recognition.onend = () => {
      pttRef.current = false;
      pttRecRef.current = null;
      setListening(false);
      resumeWakeIfNeeded();
    };
    pttRecRef.current = recognition;
    setListening(true);
    try {
      recognition.start();
    } catch {
      pttRef.current = false;
      setListening(false);
      resumeWakeIfNeeded();
    }
  }, [cancelSpeech, flashError, resumeWakeIfNeeded]);

  /* ───────────── wake word ───────────── */

  const stopWake = useCallback(() => {
    wakeRef.current?.stop();
    wakeRef.current = null;
    wakeOnRef.current = false;
    setWakeOn(false);
    setWakeState("off");
  }, []);

  const startWake = useCallback(() => {
    if (wakeRef.current) return;
    const listener = new WakeWordListener({
      lang: "en-IN",
      onWake: () => {
        beep(880, 0.09);
        sceneRef.current?.pulse(1);
      },
      onCommand: (text) => processRef.current(text, "voice"),
      onCaptureEnd: () => {},
      onState: setWakeState,
      onError: (message) => {
        setError(message);
        flashError();
        if (!wakeRef.current || message.includes("PERMISSION") || message.includes("NO MICROPHONE") || message.includes("LANGUAGE")) {
          wakeRef.current = null;
          wakeOnRef.current = false;
          setWakeOn(false);
        }
      },
    });
    if (!listener.supported) {
      setError("WAKE WORD NEEDS CHROME OR EDGE (SPEECH RECOGNITION IS NOT AVAILABLE HERE)");
      return;
    }
    wakeRef.current = listener;
    wakeOnRef.current = true;
    setWakeOn(true);
    setError(null);
    if (pausedRef.current || speakingRef.current || pttRef.current) {
      listener.start();
      listener.pause();
    } else listener.start();
  }, [flashError]);

  const toggleWake = useCallback(() => {
    if (wakeRef.current) stopWake();
    else startWake();
  }, [startWake, stopWake]);

  /* ───────────── pause / resume ───────────── */

  const togglePause = useCallback(() => setPaused((p) => !p), []);

  useEffect(() => {
    pausedRef.current = paused;
    if (firstPauseRef.current) {
      firstPauseRef.current = false;
      return;
    }
    if (paused) {
      cancelSpeech();
      pttRecRef.current?.abort();
      wakeRef.current?.pause();
      showToast("PAUSED");
    } else {
      showToast("RESUMED");
      resumeWakeIfNeeded();
    }
  }, [paused, cancelSpeech, resumeWakeIfNeeded, showToast]);

  /* ───────────── scene lifecycle ───────────── */

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = createOrbScene(container);
    sceneRef.current = scene;
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      wakeRef.current?.stop();
      wakeRef.current = null;
      pttRecRef.current?.abort();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setState(orbState);
  }, [orbState]);

  useEffect(() => {
    sceneRef.current?.setTheme(orbTheme);
  }, [orbTheme]);

  /* ───────────── load saved data, voice, timers ───────────── */

  useEffect(() => {
    try {
      const raw = browserStore.get(HISTORY_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        const valid = (parsed as ChatMessage[]).filter(
          (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string",
        );
        messagesRef.current = valid.slice(-MAX_STORED_MESSAGES);
        setMessages(messagesRef.current);
      }
    } catch {
      /* ignore corrupt history */
    }
    historyLoadedRef.current = true;
    refreshData();
  }, [refreshData]);

  useEffect(() => {
    if (!historyLoadedRef.current) return;
    browserStore.set(HISTORY_KEY, JSON.stringify(messages));
    const el = chatListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, panel, thinking]);

  // Prefer a voice installed on the system (works offline, no key)
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    const pick = () => {
      const voices = synth.getVoices();
      voiceRef.current =
        voices.find((v) => v.lang === "en-IN" && v.localService) ??
        voices.find((v) => v.lang.startsWith("en") && v.localService) ??
        voices.find((v) => v.lang.startsWith("en")) ??
        null;
    };
    pick();
    synth.addEventListener("voiceschanged", pick);
    return () => synth.removeEventListener("voiceschanged", pick);
  }, []);

  // Timer heartbeat: fires finished timers, keeps countdowns moving
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      if (timersRef.current.length) setNow(t);
      const expired = popExpiredTimers(browserStore, t);
      if (!expired.length) return;
      refreshData();
      for (const timer of expired) {
        const msg = timer.label
          ? `Reminder: ${timer.label}.`
          : `Your ${formatDuration(timer.durationMs)} timer is done.`;
        pushMessage("assistant", msg);
        beep(988, 0.15, 0);
        beep(988, 0.15, 0.22);
        beep(1319, 0.3, 0.44);
        speak(msg);
        showToast(msg.toUpperCase());
      }
    }, 500);
    return () => clearInterval(id);
  }, [pushMessage, refreshData, showToast, speak]);

  // Load the documentation file count the first time the Docs panel opens
  useEffect(() => {
    panelRef.current = panel;
    if (panel !== "docs" || docFiles !== null) return;
    fetch("/api/docs")
      .then((r) => r.json())
      .then((d: { files?: string[] }) => setDocFiles(d.files?.length ?? 0))
      .catch(() => setDocFiles(0));
  }, [panel, docFiles]);

  useEffect(() => {
    if (panel === "memory") void refreshMemories();
  }, [panel, refreshMemories]);

  /* ───────────── hand gestures ───────────── */

  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCamera("off");
    setStatus({ hands: 0, mode: "idle", palm: 0 });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: (next) => { if (mountedRef.current) setStatus(next); },
      // Safe actions only: nothing here can delete data or send anything anywhere.
      onOpenPalmHold: () => setPaused((p) => !p),
      onSwipe: (direction) => {
        const next = cyclePanel(panelRef.current, direction === "left" ? 1 : -1);
        panelRef.current = next;
        setPanel(next);
        showToast(`SWIPE ${direction.toUpperCase()} · ${next.toUpperCase()}`);
      },
      onSixFingerGesture: () => {
        setOrbTheme((current) => {
          const currentIndex = THEME_OPTIONS.findIndex((option) => option.id === current);
          return THEME_OPTIONS[(currentIndex + 1) % THEME_OPTIONS.length].id;
        });
        showToast("SIX FINGERS · ORB THEME");
      },
      onAppLauncherGesture: () => {
        if (sceneRef.current?.isZoomedToCore()) setAppLauncherOpen(true);
        else showToast("ZOOM INTO THE CORE, THEN USE LEFT 3 FINGERS + RIGHT PINCH");
      },
      onAppLauncherPointer: (point) => {
        if (!mountedRef.current) return;
        const previous = appPointerRef.current;
        if (!point) {
          if (previous) {
            appPointerRef.current = null;
            setAppPointer(null);
          }
          return;
        }
        if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.003) return;
        appPointerRef.current = point;
        setAppPointer(point);
      },
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      if (!mountedRef.current || trackerRef.current !== tracker) {
        tracker.stop();
        return;
      }
      setCamera("on");
    } catch (err) {
      if (!mountedRef.current || trackerRef.current !== tracker) {
        tracker.stop();
        return;
      }
      trackerRef.current = null;
      tracker.stop();
      setCamera("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED",
      );
    }
  }, [showToast]);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  const openStudyPosition = useCallback(() => {
    const fields = studyFen.trim().split(/\s+/);
    if (fields.length !== 6 || !fields[0].includes("/")) {
      setError("ENTER A COMPLETE SIX-FIELD FEN POSITION TO OPEN CHESS STUDY.");
      return;
    }
    window.open(`https://lichess.org/analysis/${studyFen.trim().replace(/\s+/g, "_")}`, "_blank", "noopener,noreferrer");
  }, [studyFen]);

  /* ───────────── chess mode ───────────── */

  // Chess is a dedicated full-window view: it replaces the orb HUD, so switch the camera,
  // wake word, mic and speech off while it is open instead of leaving them running unseen.
  const chessMode = panel === "chess";

  const exitChess = useCallback(() => {
    panelRef.current = "chat";
    setPanel("chat");
  }, []);

  useEffect(() => {
    if (!chessMode) return;
    stopGestures();
    stopWake();
    const rec = pttRecRef.current;
    if (rec) {
      rec.onerror = null; // aborting is deliberate, don't surface it as a mic failure
      rec.onresult = null;
      rec.abort();
    }
    cancelSpeech();
    setAppLauncherOpen(false);
    setAppPointer(null);
    setError(null);
  }, [chessMode, stopGestures, stopWake, cancelSpeech]);

  /* ───────────── keyboard ───────────── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't treat typing in the message box as shortcuts
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (panelRef.current === "chess") {
        // Orb shortcuts (G / W / P / T / R / zoom) are disabled in chess mode
        if (e.key === "Escape") exitChess();
        return;
      }
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
        case "w":
        case "W":
          toggleWake();
          break;
        case "p":
        case "P":
          togglePause();
          break;
        case "t":
        case "T":
          setTextPanelOpen((open) => !open);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures, toggleWake, togglePause, exitChess]);

  /* ───────────── render ───────────── */

  const cameraOn = camera === "on";
  const nextTimer = timers.length ? [...timers].sort((a, b) => a.endsAt - b.endsAt)[0] : null;
  const palmText =
    status.palm >= 1 ? "PALM ✓" : status.palm > 0 ? `OPEN PALM ${Math.round(status.palm * 100)}%` : null;

  return (
    <div className={`app-shell${chessMode ? " chess-mode" : ""}`} data-theme={orbTheme}>
      <div ref={containerRef} className="orb-root" />

      {appLauncherOpen && (
        <section className="app-launcher" aria-label="Floating application launcher">
          <div className="app-launcher-heading"><span>FLOATING APPS · HOLD TO SELECT</span>
            <button type="button" aria-label="Close app launcher" onClick={() => { setAppLauncherOpen(false); setAppPointer(null); }}>×</button>
          </div>
          <div className="app-launcher-field">
            {APP_SHORTCUTS.map((app) => (
              <button
                type="button"
                className={`app-launcher-item${hoveredApp === app.key ? " is-hovered" : ""}`}
                key={app.key}
                style={{ "--app-color": app.color, "--app-x": `${APP_ICON_POSITIONS[APP_SHORTCUTS.indexOf(app)]?.[0] ?? 50}%`, "--app-y": `${APP_ICON_POSITIONS[APP_SHORTCUTS.indexOf(app)]?.[1] ?? 50}%`, "--dwell": hoveredApp === app.key ? dwellProgress : 0 } as React.CSSProperties}
                onClick={() => launchApp(app.key)}
                aria-label={`Open ${app.name}`}
              >
                <span className="app-launcher-icon">{app.glyph}</span>
                <span>{app.name}</span>
              </button>
            ))}
          </div>
          {appPointer && <span className="app-hand-cursor" style={{ left: `${appPointer.x * 100}%`, top: `${appPointer.y * 100}%` }} aria-hidden="true" />}
          <p>{hoveredApp ? `HOLD ${APP_SHORTCUTS.find((app) => app.key === hoveredApp)?.name} · ${Math.ceil((1 - dwellProgress) * 4.5)}s` : "Move your right pinched hand over an icon; hold for 4.5 seconds."}</p>
        </section>
      )}

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="hud hud-title">U.L.T.R.O.N.</div>
      <details className="hud hud-theme-picker">
        <summary aria-label={`Choose orb color; current color is ${THEME_OPTIONS.find((option) => option.id === orbTheme)?.label}`}>
          <span className="theme-indicator" style={{ "--swatch-color": THEME_OPTIONS.find((option) => option.id === orbTheme)?.color } as React.CSSProperties} />
          COLOR · {THEME_OPTIONS.find((option) => option.id === orbTheme)?.label.toUpperCase()}
        </summary>
        <div className="theme-menu" role="group" aria-label="Orb color">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className="theme-swatch"
              style={{ "--swatch-color": option.color } as React.CSSProperties}
              aria-label={`Use ${option.label} color`}
              aria-pressed={orbTheme === option.id}
              title={option.label}
              onClick={(event) => {
                setOrbTheme(option.id);
                event.currentTarget.closest("details")?.removeAttribute("open");
              }}
            />
          ))}
        </div>
      </details>

      <div className="hud hud-status" data-state={orbState} aria-live="polite">
        <span className="state-dot" />
        {STATE_LABEL[orbState]}
        {wakeOn && wakeState !== "off" && (
          <span className="wake-chip">
            {wakeState === "capturing" ? "· LISTENING FOR COMMAND" : wakeState === "paused" ? "· WAKE WORD PAUSED" : "· SAY “HEY ULTRON”"}
          </span>
        )}
      </div>

      {nextTimer && (
        <div className="hud hud-timer">
          TIMER {formatClock(nextTimer.endsAt - now)}
          {nextTimer.label ? ` · ${nextTimer.label.toUpperCase()}` : ""}
        </div>
      )}

      {toast && <div className="hud hud-toast">{toast}</div>}
      {paused && <div className="hud hud-paused">PAUSED · HOLD OPEN PALM OR PRESS P TO RESUME</div>}

      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn ? (
          <>
            <div>
              <span className="key">PINCH + MOVE</span> spin&nbsp;&nbsp;
              <span className="key">PINCH BOTH HANDS ± SPREAD</span> zoom
            </div>
            <div>
              <span className="key">OPEN PALM · HOLD 1s</span> pause/resume&nbsp;&nbsp;
              <span className="key">6 FINGERS</span> orb color&nbsp;&nbsp;
              <span className="key">T</span> text panel
            </div>
          </>
        ) : (
          <div>
            <span className="key">G</span> gestures&nbsp;&nbsp;
            <span className="key">W</span> wake word&nbsp;&nbsp;
            <span className="key">P</span> pause&nbsp;&nbsp;
            <span className="key">T</span> text panel&nbsp;&nbsp;
            <span className="key">R</span> reset&nbsp;&nbsp;
            <span className="key">+/−</span> zoom
          </div>
        )}
      </div>

      {textPanelOpen && !chessMode && (
      <section className="hud voice-panel" aria-label="Talk to ULTRON">
        <button className="panel-close" type="button" onClick={() => setTextPanelOpen(false)} aria-label="Close text panel" title="Close text panel">×</button>
        <div className="voice-top">
          <div className="voice-heading">ULTRON VOICE LINK</div>
          <div className="panel-tabs" role="tablist">
            {PANELS.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={panel === p}
                className="panel-tab"
                onClick={() => {
                  panelRef.current = p;
                  setPanel(p);
                }}
              >
                {p.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {panel === "chat" && (
          <>
            <div className="panel-body" ref={chatListRef}>
              {messages.length === 0 && !thinking && (
                <div className="panel-empty">
                  Press WAKE WORD and say “Hey ULTRON”, or type below. Try: “what time is it”, “set a timer for five
                  minutes”, “take a note: …”, “open YouTube”, or ask anything.
                </div>
              )}
              {messages.map((m) => (
                <div key={m.id} className={`msg msg-${m.role}`}>
                  <span className="msg-who">{m.role === "user" ? "YOU" : "ULTRON"}</span>
                  <span className="msg-text">{m.text}</span>
                </div>
              ))}
              {thinking && (
                <div className="msg msg-assistant">
                  <span className="msg-who">ULTRON</span>
                  <span className="msg-text msg-dots">thinking</span>
                </div>
              )}
              {pendingLink && (
                <a className="msg-link" href={pendingLink.url} target="_blank" rel="noopener noreferrer">
                  OPEN {pendingLink.label.toUpperCase()} ↗
                </a>
              )}
            </div>
            <div className="panel-actions">
              <span>{messages.length} MESSAGES REMEMBERED</span>
              <button
                type="button"
                className="mini-btn"
                onClick={clearMessages}
                disabled={messages.length === 0}
              >
                CLEAR HISTORY
              </button>
            </div>
          </>
        )}

        {panel === "tasks" && (
          <div className="panel-body">
            <div className="list-heading">TIMERS</div>
            {timers.length === 0 && <div className="panel-empty">No timers. Say “set a timer for 5 minutes”.</div>}
            {timers.map((t) => (
              <div key={t.id} className="list-row">
                <span className="list-text">
                  {formatClock(t.endsAt - now)} {t.label ? `· ${t.label}` : `· ${formatDuration(t.durationMs)}`}
                </span>
                <button
                  type="button"
                  className="mini-btn"
                  aria-label="Cancel timer"
                  onClick={() => {
                    removeTimer(browserStore, t.id);
                    refreshData();
                  }}
                >
                  ×
                </button>
              </div>
            ))}

            <div className="list-heading">TO-DO</div>
            {todos.length === 0 && <div className="panel-empty">Empty. Say “add buy milk to my to-do list”.</div>}
            {todos.map((t, i) => (
              <div key={t.id} className="list-row">
                <button
                  type="button"
                  className="mini-btn"
                  aria-label={t.done ? "Mark not done" : "Mark done"}
                  onClick={() => {
                    toggleTodo(browserStore, t.id);
                    refreshData();
                  }}
                >
                  {t.done ? "☑" : "☐"}
                </button>
                <span className={`list-text${t.done ? " done" : ""}`}>
                  {i + 1}. {t.text}
                </span>
                <button
                  type="button"
                  className="mini-btn"
                  aria-label="Delete to-do"
                  onClick={() => {
                    removeTodo(browserStore, t.id);
                    refreshData();
                  }}
                >
                  ×
                </button>
              </div>
            ))}

            <div className="list-heading">NOTES</div>
            {notes.length === 0 && <div className="panel-empty">No notes. Say “take a note: …”.</div>}
            {[...notes].reverse().map((n) => (
              <div key={n.id} className="list-row">
                <span className="list-text">
                  {n.text}
                  <span className="list-date"> · {new Date(n.at).toLocaleDateString()}</span>
                </span>
                <button
                  type="button"
                  className="mini-btn"
                  aria-label="Delete note"
                  onClick={() => {
                    removeNote(browserStore, n.id);
                    refreshData();
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {panel === "docs" && (
          <div className="panel-body">
            <div className="panel-empty">
              Say or type “search the docs for …”.{" "}
              {docFiles === null ? "" : `${docFiles} file${docFiles === 1 ? "" : "s"} indexed (README.md, /knowledge, /docs).`}
            </div>
            {docQuery && <div className="list-heading">RESULTS FOR “{docQuery.toUpperCase()}”</div>}
            {docQuery && docHits.length === 0 && <div className="panel-empty">No matches.</div>}
            {docHits.map((h, i) => (
              <div key={`${h.file}-${i}`} className="doc-hit">
                <div className="doc-file">
                  {h.file} <span className="list-date">› {h.heading}</span>
                </div>
                <div className="doc-snippet">{h.snippet}</div>
              </div>
            ))}
          </div>
        )}

        {panel === "memory" && (
          <div className="panel-body memory-panel">
            <div className="list-heading">LONG-TERM MEMORY</div>
            <p className="panel-empty">ULTRON saves a memory only when you ask. It searches these memories when they may help answer you.</p>
            <form
              className="memory-form"
              onSubmit={async (event) => {
                event.preventDefault();
                const content = memoryDraft.trim();
                if (!content) return;
                setMemoryError(null);
                try {
                  const response = await fetch("/api/memories", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ content, category: "general", source: "user" }),
                  });
                  const data = await response.json().catch(() => ({})) as { memory?: MemoryRecord; error?: string };
                  if (!response.ok || !data.memory) throw new Error(data.error || "Memory could not be saved.");
                  setMemories((current) => [data.memory!, ...current.filter((item) => item.id !== data.memory!.id)]);
                  setMemoryDraft("");
                } catch (error) {
                  setMemoryError(error instanceof Error ? error.message : "Memory could not be saved.");
                }
              }}
            >
              <textarea
                className="voice-input memory-input"
                value={memoryDraft}
                onChange={(event) => setMemoryDraft(event.target.value.slice(0, 2000))}
                placeholder="What should ULTRON remember?"
                aria-label="Memory to save"
                maxLength={2000}
                rows={2}
              />
              <button type="submit" className="hud-btn" disabled={!memoryDraft.trim()}>SAVE MEMORY</button>
            </form>
            {memoryError && <div className="memory-error" role="status">{memoryError}</div>}
            {memoryLoading && <div className="panel-empty">Loading saved memories…</div>}
            {!memoryLoading && !memoryError && memories.length === 0 && <div className="panel-empty">No saved memories yet.</div>}
            {memories.map((memory) => (
              <article className="memory-card" key={memory.id}>
                <div className="memory-card-meta">
                  <span>{memory.category.toUpperCase()}</span>
                  <time dateTime={memory.updatedAt}>{new Date(memory.updatedAt).toLocaleDateString()}</time>
                </div>
                <p>{memory.content}</p>
                {memory.tags.length > 0 && <div className="memory-tags">{memory.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
                <button
                  type="button"
                  className="mini-btn memory-delete"
                  onClick={async () => {
                    if (!window.confirm("Permanently forget this memory?")) return;
                    setMemoryError(null);
                    try {
                      const response = await fetch("/api/memories", {
                        method: "DELETE",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: memory.id }),
                      });
                      const data = await response.json().catch(() => ({})) as { error?: string };
                      if (!response.ok) throw new Error(data.error || "Memory could not be deleted.");
                      setMemories((current) => current.filter((item) => item.id !== memory.id));
                    } catch (error) {
                      setMemoryError(error instanceof Error ? error.message : "Memory could not be deleted.");
                    }
                  }}
                >
                  FORGET
                </button>
              </article>
            ))}
          </div>
        )}

        {panel === "study" && (
          <div className="panel-body chess-study">
            <div className="list-heading">CHESS STUDY · POST-GAME ANALYSIS</div>
            <p className="panel-empty">Paste a FEN position from a completed game to open Lichess analysis with its browser-based Stockfish engine.</p>
            <textarea
              className="voice-input chess-fen"
              value={studyFen}
              onChange={(event) => setStudyFen(event.target.value)}
              aria-label="Chess position in FEN notation"
              rows={3}
              spellCheck={false}
            />
            <button type="button" className="hud-btn" onClick={openStudyPosition}>ANALYZE POSITION ↗</button>
          </div>
        )}

        <form
          className="voice-form"
          onSubmit={(event) => {
            event.preventDefault();
            void processInput(prompt, "typed");
          }}
        >
          <input
            className="voice-input"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Ask ULTRON something..."
            aria-label="Message for ULTRON"
            maxLength={2000}
          />
          <button className="hud-btn" type="submit" disabled={thinking || !prompt.trim()}>
            {thinking ? "..." : "SEND"}
          </button>
        </form>
      </section>
      )}

      {chessMode && (
        <ChessPanel
          theme={orbTheme}
          onToggleTheme={() => setOrbTheme((current) => {
            const currentIndex = THEME_OPTIONS.findIndex((option) => option.id === current);
            return THEME_OPTIONS[(currentIndex + 1) % THEME_OPTIONS.length].id;
          })}
          onExit={exitChess}
        />
      )}

      <div className="hud hud-controls">
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          {/* Mirrored preview so it behaves like a mirror */}
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {palmText ??
              (status.hands > 0
                ? `${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}`
                : "SHOW HANDS")}
          </div>
        </div>

        {error && <div className="hud-error">{error}</div>}

        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={listening}
            onClick={() => { setTextPanelOpen(true); startListening(); }}
            disabled={listening || thinking || paused}
          >
            {listening ? "LISTENING…" : "MIC INPUT"}
          </button>
          <button type="button" className="hud-btn" onClick={cancelSpeech}>
            STOP VOICE
          </button>
        </div>
        <div className="hud-row">
          <button type="button" className="hud-btn" aria-pressed={wakeOn} onClick={toggleWake}>
            {wakeOn ? "WAKE WORD ON" : "WAKE WORD OFF"}
          </button>
          <button type="button" className="hud-btn" aria-pressed={paused} onClick={togglePause}>
            {paused ? "RESUME" : "PAUSE"}
          </button>
        </div>
        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={camera === "starting"}
          >
            {camera === "starting" ? "INITIALIZING…" : cameraOn ? "GESTURES ON" : "GESTURES OFF"}
          </button>
        </div>
        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.resetView()}>
            RESET VIEW
          </button>
        </div>
      </div>
    </div>
  );
}
