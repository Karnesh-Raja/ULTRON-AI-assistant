import { SEARCH_URLS, findSite, siteNames } from "./sites";

/* ───────────── storage (injected so this file also works outside the browser) ───────────── */

export interface KVStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const browserStore: KVStore = {
  get(key) {
    try {
      return typeof window === "undefined" ? null : window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(key, value);
    } catch {
      /* storage full or blocked - ignore */
    }
  },
};

export interface Note { id: string; text: string; at: number }
export interface Todo { id: string; text: string; done: boolean; at: number }
export interface TimerItem { id: string; label: string; endsAt: number; durationMs: number }

const KEYS = { notes: "ultron.notes", todos: "ultron.todos", timers: "ultron.timers" } as const;
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

function readList<T>(store: KVStore, key: string): T[] {
  try {
    const raw = store.get(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
function writeList<T>(store: KVStore, key: string, list: T[]): void {
  store.set(key, JSON.stringify(list));
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export const getNotes = (s: KVStore) => readList<Note>(s, KEYS.notes);
export const getTodos = (s: KVStore) => readList<Todo>(s, KEYS.todos);
export const getTimers = (s: KVStore) => readList<TimerItem>(s, KEYS.timers);

/** Agent tools use these narrow operations instead of accepting arbitrary storage keys. */
export function createNote(s: KVStore, text: string, at = Date.now()): Note | null {
  const clean = text.trim().slice(0, 2000);
  if (!clean) return null;
  const note = { id: newId(), text: clean, at };
  writeList(s, KEYS.notes, [...getNotes(s), note]);
  return note;
}

export function createTodo(s: KVStore, text: string, at = Date.now()): Todo | null {
  const clean = text.trim().slice(0, 500);
  if (!clean) return null;
  const todo = { id: newId(), text: clean, done: false, at };
  writeList(s, KEYS.todos, [...getTodos(s), todo]);
  return todo;
}

export function completeTodo(s: KVStore, number: number): Todo | null {
  const todos = getTodos(s);
  const index = number - 1;
  if (!Number.isInteger(number) || index < 0 || index >= todos.length) return null;
  const completed = { ...todos[index], done: true };
  writeList(s, KEYS.todos, todos.map((todo, i) => (i === index ? completed : todo)));
  return completed;
}

export function createTimer(s: KVStore, durationText: string, label = "", nowMs = Date.now()): TimerItem | null {
  const durationMs = parseDuration(durationText);
  if (!durationMs || durationMs > MAX_TIMER_MS) return null;
  const timer = { id: newId(), label: label.trim().slice(0, 300), endsAt: nowMs + durationMs, durationMs };
  writeList(s, KEYS.timers, [...getTimers(s), timer]);
  return timer;
}

export function toggleTodo(s: KVStore, id: string): void {
  writeList(s, KEYS.todos, getTodos(s).map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
}
export function removeTodo(s: KVStore, id: string): void {
  writeList(s, KEYS.todos, getTodos(s).filter((t) => t.id !== id));
}
export function removeNote(s: KVStore, id: string): void {
  writeList(s, KEYS.notes, getNotes(s).filter((n) => n.id !== id));
}
export function clearNotes(s: KVStore): void {
  writeList(s, KEYS.notes, []);
}
export function removeTimer(s: KVStore, id: string): void {
  writeList(s, KEYS.timers, getTimers(s).filter((t) => t.id !== id));
}
/** Removes and returns timers whose time is up. */
export function popExpiredTimers(s: KVStore, nowMs: number): TimerItem[] {
  const all = getTimers(s);
  const expired = all.filter((t) => t.endsAt <= nowMs);
  if (expired.length) writeList(s, KEYS.timers, all.filter((t) => t.endsAt > nowMs));
  return expired;
}

/* ───────────── result types ───────────── */

export type PanelId = "chat" | "tasks" | "docs" | "study" | "chess";

export type AssistantAction =
  | { type: "open"; url: string; label: string }
  | { type: "data" } // notes / todos / timers changed -> refresh the UI
  | { type: "docs"; query: string }
  | { type: "clearHistory" }
  | { type: "panel"; panel: PanelId }
  | { type: "stopSpeaking" };

export interface AssistantResult {
  reply: string;
  actions: AssistantAction[];
}

export interface CommandContext {
  store: KVStore;
  now: Date;
}

/* ───────────── small helpers ───────────── */

const NUM_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const TENS = new Set(["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]);

/** "5", "five", "a", "an", "twenty five" -> number. */
export function toNumber(word: string): number | null {
  const w = word.toLowerCase().trim();
  if (/^\d+(\.\d+)?$/.test(w)) return parseFloat(w);
  if (w === "a" || w === "an") return 1;
  if (w in NUM_WORDS) return NUM_WORDS[w];
  const parts = w.split(/[\s-]+/);
  if (parts.length === 2 && TENS.has(parts[0]) && parts[1] in NUM_WORDS && NUM_WORDS[parts[1]] < 10) {
    return NUM_WORDS[parts[0]] + NUM_WORDS[parts[1]];
  }
  return null;
}

const UNIT_MS: Record<string, number> = {
  hour: 3_600_000, hours: 3_600_000, hr: 3_600_000, hrs: 3_600_000,
  minute: 60_000, minutes: 60_000, min: 60_000, mins: 60_000,
  second: 1000, seconds: 1000, sec: 1000, secs: 1000,
};

/** "1 hour 30 minutes", "five minutes", "half an hour" -> milliseconds (or null). */
export function parseDuration(text: string): number | null {
  const tokens = text.toLowerCase().replace(/-/g, " ").replace(/[^a-z0-9.\s]/g, " ").split(/\s+/).filter(Boolean);
  let total = 0;
  let found = false;
  for (let i = 0; i < tokens.length; i++) {
    const unit = UNIT_MS[tokens[i]];
    if (!unit) continue;
    const prev = tokens[i - 1];
    const prev2 = tokens[i - 2];
    let n: number | null = null;
    if (prev === "half" || (prev === "an" && prev2 === "half") || (prev === "a" && prev2 === "half")) n = 0.5;
    else if (prev !== undefined) {
      n = toNumber(prev);
      if (prev2 !== undefined) {
        const two = toNumber(`${prev2} ${prev}`);
        if (two !== null && TENS.has(prev2)) n = two;
      }
    }
    if (n === null) continue;
    let add = n * unit;
    if (tokens[i + 1] === "and" && tokens[i + 2] === "a" && tokens[i + 3] === "half") add += unit / 2;
    total += add;
    found = true;
  }
  return found && total > 0 ? Math.round(total) : null;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  if (s && !h) parts.push(`${s} second${s === 1 ? "" : "s"}`);
  return parts.join(" ") || "0 seconds";
}

export function formatClock(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\bto[\s-]do\b/g, "todo")
    .replace(/[^a-z0-9.:\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanRaw(text: string): string {
  return text
    .trim()
    .replace(/^(?:(?:hey|hi|ok|okay)[\s,]+)?ultron[\s,:-]*/i, "")
    .replace(/^(?:(?:please|can you|could you|would you|will you|kindly)[\s,]+)+/i, "")
    .replace(/[\s.!?]+$/g, "")
    .replace(/\s+please$/i, "")
    .replace(/\bto[\s-]do\b/gi, "todo")
    .trim();
}

function titleCase(s: string): string {
  const special: Record<string, string> = { youtube: "YouTube", github: "GitHub", linkedin: "LinkedIn", whatsapp: "WhatsApp", stackoverflow: "Stack Overflow", "ai studio": "AI Studio", npm: "npm", mdn: "MDN", x: "X", nextjs: "Next.js", "next js": "Next.js", threejs: "Three.js", "three js": "Three.js" };
  if (special[s]) return special[s];
  return s.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function pickIndex(word: string, length: number): number | null {
  const n = toNumber(word);
  if (n === null || !Number.isInteger(n) || n < 1 || n > length) return null;
  return n - 1;
}

function listText(items: string[], max = 5): string {
  return items.slice(0, max).map((t, i) => `${i + 1}. ${t}`).join(". ");
}

const HELP_TEXT =
  "I can tell you the time and date, open websites like YouTube or GitHub, take notes, manage a to-do list, set timers and reminders, and search your project documentation. For anything else I'll answer with AI, and I remember this conversation so you can ask follow-up questions.";

/* ───────────── the command router ───────────── */

/**
 * Tries to handle a sentence locally (no AI call).
 * Returns null when the sentence is not a built-in command, so it can go to Gemini.
 */
export function runLocalCommand(input: string, ctx: CommandContext): AssistantResult | null {
  const c = cleanRaw(input);
  if (!c) return null;
  const n = normalize(c);
  const { store, now } = ctx;
  const done = (reply: string, ...actions: AssistantAction[]): AssistantResult => ({ reply, actions });
  let m: RegExpMatchArray | null;

  /* stop talking */
  if (/^(?:stop|stop talking|be quiet|quiet|silence|shut up|enough|cancel)$/.test(n)) {
    return done("Okay.", { type: "stopSpeaking" });
  }

  /* help */
  if (/^(?:help|what can you do|what are your (?:commands|features|capabilities)|list (?:your )?commands)$/.test(n)) {
    return done(HELP_TEXT);
  }

  /* conversation */
  if (/^(?:clear|reset|forget|delete) (?:the |our |this |my )?(?:conversation|chat|history|chat history|conversation history)$/.test(n)
    || /^(?:start over|new conversation|forget everything)$/.test(n)) {
    return done("Conversation history cleared.", { type: "clearHistory" });
  }

  /* panels */
  if ((m = n.match(/^(?:switch to|go to|show|open) (?:the |my )?(chat|conversation|history|docs|documentation)(?: panel| tab)?$/))) {
    const panel: PanelId = /docs|documentation/.test(m[1]) ? "docs" : "chat";
    return done(panel === "docs" ? "Showing the documentation panel." : "Showing the conversation.", { type: "panel", panel });
  }

  /* ── timers & reminders ── */
  if (/\b(?:cancel|stop|clear|delete|remove|dismiss)\b.*\btimers?\b/.test(n)) {
    const count = getTimers(store).length;
    writeList(store, KEYS.timers, []);
    return done(count ? `Cancelled ${count} timer${count === 1 ? "" : "s"}.` : "You have no active timers.", { type: "data" });
  }
  if (/\b(?:how much|how long|time left|timer status|check (?:the |my )?timers?|remaining)\b.*\btimers?\b|\btimers? (?:status|left|remaining)\b|\bhow much time (?:is )?left\b/.test(n)) {
    const timers = getTimers(store).sort((a, b) => a.endsAt - b.endsAt);
    if (!timers.length) return done("You have no active timers.");
    const t = timers[0];
    return done(`${formatDuration(t.endsAt - now.getTime())} left on ${t.label ? `your reminder to ${t.label}` : "your timer"}.`, { type: "panel", panel: "tasks" });
  }
  const addTimer = (ms: number, label: string): AssistantResult => {
    if (ms > MAX_TIMER_MS) return done("I can set timers up to 24 hours.");
    const timer: TimerItem = { id: newId(), label, endsAt: now.getTime() + ms, durationMs: ms };
    writeList(store, KEYS.timers, [...getTimers(store), timer]);
    const reply = label
      ? `Okay, I'll remind you in ${formatDuration(ms)} to ${label}.`
      : `Timer set for ${formatDuration(ms)}.`;
    return done(reply, { type: "data" });
  };
  if ((m = c.match(/^remind me in (.+?)\s+(?:to|about|that)\s+(.+)$/i))) {
    const ms = parseDuration(m[1]);
    if (ms) return addTimer(ms, m[2].trim());
  }
  if ((m = c.match(/^remind me (?:to|about|that)\s+(.+?)\s+in\s+(.+)$/i))) {
    const ms = parseDuration(m[2]);
    if (ms) return addTimer(ms, m[1].trim());
  }
  if (/\btimer\b/.test(n) && /\b(?:set|start|create|begin|make|run|put)\b|^timer\b|\btimer (?:for|of)\b/.test(n)) {
    const ms = parseDuration(n);
    if (ms) return addTimer(ms, "");
    return done("For how long? Say, for example, set a timer for five minutes.");
  }

  /* ── news ── */
  if (/^(?:(?:what(?:s| is) )?(?:the )?(?:latest|todays|today|current) (?:news|headlines)|(?:news|headlines) (?:today|right now|latest)|(?:todays|today) (?:top )?(?:news|headlines))$/.test(n)) {
    return done("Opening today's latest news.", {
      type: "open",
      url: "https://news.google.com/search?q=latest%20news%20today",
      label: "Today's news",
    });
  }

  /* ── time & date ── */
  const asksTime = /\b(?:what time(?: is it)?|whats? the time|tell me (?:the )?time|give me the time|current time|time right now|the time now|time and (?:the )?date|date and (?:the )?time)\b/.test(n);
  const asksDate = /\b(?:todays date|what is the date|whats the date|tell me the date|current date|what day is (?:it|today)|which day is (?:it|today)|todays day|what is today|whats today|and the date|time and (?:the )?date|date and (?:the )?time)\b/.test(n);
  if (asksTime || asksDate) {
    const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const date = now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    if (asksTime && asksDate) return done(`It is ${time} on ${date}.`);
    return done(asksTime ? `It is ${time}.` : `Today is ${date}.`);
  }

  /* ── to-do list ── */
  const addTodo = (text: string): AssistantResult => {
    const t = text.trim().replace(/^to\s+/i, "");
    if (!t) return done("What should I add to your to-do list?");
    writeList(store, KEYS.todos, [...getTodos(store), { id: newId(), text: t, done: false, at: now.getTime() }]);
    return done(`Added to your to-do list: ${t}.`, { type: "data" }, { type: "panel", panel: "tasks" });
  };
  if ((m = c.match(/^(?:add|put|create)\s+(.+?)\s+(?:to|on|onto|in)\s+(?:my |the |our )?(?:todos?|tasks?)(?:\s+list)?$/i))) return addTodo(m[1]);
  if ((m = c.match(/^(?:add|create|new)\s+(?:a |an |another )?(?:todo|task)(?:\s+(?:to|that|called|named))?\s*[:,-]?\s*(.+)$/i))) return addTodo(m[1]);
  if ((m = c.match(/^todo\b\s*[:,-]?\s*(.+)$/i))) return addTodo(m[1]);
  if ((m = c.match(/^remind me to\s+(.+)$/i))) return addTodo(m[1]);

  if (/^(?:show|read|list|open|give me|tell me|whats|what is|what are|what do i have on)\b.*\b(?:todos?|tasks?)\b/.test(n)) {
    const open = getTodos(store).filter((t) => !t.done);
    if (!open.length) return done("Your to-do list is empty.", { type: "panel", panel: "tasks" });
    return done(`You have ${open.length} open item${open.length === 1 ? "" : "s"}. ${listText(open.map((t) => t.text))}.`, { type: "panel", panel: "tasks" });
  }
  if ((m = n.match(/^(?:mark|complete|finish|check off|tick off)\s+(?:todo|task)\s+(?:number\s+)?(\S+?)(?:\s+as)?(?:\s+(?:done|complete|completed|finished))?$/))) {
    const todos = getTodos(store);
    const idx = pickIndex(m[1], todos.length);
    if (idx === null) return done("I couldn't find that to-do number.");
    writeList(store, KEYS.todos, todos.map((t, i) => (i === idx ? { ...t, done: true } : t)));
    return done(`Marked done: ${todos[idx].text}.`, { type: "data" }, { type: "panel", panel: "tasks" });
  }
  if ((m = n.match(/^mark (.+?) as (?:done|complete|completed|finished)$/))) {
    const todos = getTodos(store);
    const idx = todos.findIndex((t) => !t.done && normalize(t.text).includes(m![1]));
    if (idx === -1) return done("I couldn't find a matching open to-do.");
    writeList(store, KEYS.todos, todos.map((t, i) => (i === idx ? { ...t, done: true } : t)));
    return done(`Marked done: ${todos[idx].text}.`, { type: "data" }, { type: "panel", panel: "tasks" });
  }
  if ((m = n.match(/^(?:remove|delete)\s+(?:todo|task)\s+(?:number\s+)?(\S+)$/))) {
    const todos = getTodos(store);
    const idx = pickIndex(m[1], todos.length);
    if (idx === null) return done("I couldn't find that to-do number.");
    writeList(store, KEYS.todos, todos.filter((_, i) => i !== idx));
    return done(`Removed: ${todos[idx].text}.`, { type: "data" });
  }
  if (/^clear (?:all )?(?:completed|done|finished) (?:todos?|tasks?)$/.test(n)) {
    const todos = getTodos(store);
    const left = todos.filter((t) => !t.done);
    writeList(store, KEYS.todos, left);
    return done(`Cleared ${todos.length - left.length} completed item${todos.length - left.length === 1 ? "" : "s"}.`, { type: "data" });
  }

  /* ── notes ── */
  const addNote = (text: string): AssistantResult => {
    const t = text.trim();
    if (!t) return done("What should the note say?");
    writeList(store, KEYS.notes, [...getNotes(store), { id: newId(), text: t, at: now.getTime() }]);
    return done("Note saved.", { type: "data" }, { type: "panel", panel: "tasks" });
  };
  if ((m = c.match(/^(?:take|make|create|add|save|write|jot)(?:\s+down)?\s+(?:a |an |another |new )*note(?:\s+(?:that|to|saying|says|about))?\s*[:,-]?\s*(.*)$/i))) return addNote(m[1]);
  if ((m = c.match(/^note\b(?:\s+down)?\s*(?:that\s+)?[:,-]?\s*(.+)$/i))) return addNote(m[1]);
  if (/^(?:delete|remove)\s+(?:the\s+)?last\s+note$/.test(n)) {
    const notes = getNotes(store);
    if (!notes.length) return done("You have no notes.");
    writeList(store, KEYS.notes, notes.slice(0, -1));
    return done("Deleted your last note.", { type: "data" });
  }
  if (/^(?:show|read|list|open|give me|tell me|whats|what is|what are)\b.*\bnotes?\b/.test(n)) {
    const notes = getNotes(store);
    if (!notes.length) return done("You have no notes yet.", { type: "panel", panel: "tasks" });
    const latest = notes.slice(-5).reverse();
    return done(`You have ${notes.length} note${notes.length === 1 ? "" : "s"}. Latest: ${listText(latest.map((x) => x.text))}.`, { type: "panel", panel: "tasks" });
  }

  /* ── project documentation search ── */
  const docsRes: RegExp[] = [
    /^(?:search|look|find|check)\s+(?:through\s+)?(?:my |the |our )?(?:project\s+)?(?:docs|documentation|knowledge base|knowledge)\s*(?:for|about|on)?\s*(.*)$/i,
    /^(?:search|look up|look|find|check)\s+(.+?)\s+(?:in|on|from|inside)\s+(?:my |the |our )?(?:project\s+)?(?:docs|documentation|knowledge base)$/i,
    /^what (?:do|does) (?:my |the |our )?(?:project\s+)?(?:docs|documentation) say about\s+(.+)$/i,
    /^(?:docs|documentation)\s*[:,-]\s*(.+)$/i,
  ];
  for (const re of docsRes) {
    if ((m = c.match(re))) {
      const query = m[1].trim();
      if (!query) return done("What should I search for in the documentation?");
      return done(`Searching the project documentation for ${query}.`, { type: "docs", query }, { type: "panel", panel: "docs" });
    }
  }

  /* ── open websites / web search ── */
  if ((m = c.match(/^(?:search\s+(?:for\s+)?|google\s+(?!(?:is|was|are|has|does|can|will)\b)(?:for\s+)?)(.+?)(?:\s+(?:on|in|at)\s+(google maps|google|youtube|wikipedia|github|stack ?overflow|amazon|maps))?$/i))) {
    let site = (m[2] || "google").toLowerCase().replace(/\s/g, "");
    if (site === "maps") site = "googlemaps";
    const key = Object.keys(SEARCH_URLS).find((k) => k.replace(/\s/g, "") === site) ?? "google";
    const query = m[1].trim();
    return done(`Searching ${titleCase(key)} for ${query}.`, { type: "open", url: SEARCH_URLS[key](query), label: `${key}: ${query}` });
  }
  if ((m = c.match(/^(?:open|launch|go to|goto|take me to|pull up|visit)\s+(.+)$/i))) {
    const target = m[1]
      .toLowerCase()
      .replace(/^(?:the|my|a)\s+/, "")
      .replace(/\s+(?:website|site|app|page|please)$/, "")
      .replace(/\s*(?:dot com|\.com)$/, "")
      .trim();
    const site = findSite(target);
    if (site) return done(`Opening ${titleCase(site.label)}.`, { type: "open", url: site.url, label: titleCase(site.label) });
    return done(
      `I don't have a shortcut for ${titleCase(target)} yet. I can open web apps such as ${siteNames().join(", ")}. This browser can't launch installed desktop apps.`,
    );
  }

  return null; // not a built-in command -> ask the AI
}
