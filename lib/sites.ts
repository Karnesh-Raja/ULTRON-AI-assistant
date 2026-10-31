/**
 * Web apps ULTRON is allowed to open by voice/text ("open WhatsApp").
 * Only services listed here can be opened from the browser.
 * To add one, add a line: name (lowercase) -> full https URL.
 */
export const SITES: Record<string, string> = {
  youtube: "https://www.youtube.com",
  google: "https://www.google.com",
  gmail: "https://mail.google.com",
  "google drive": "https://drive.google.com",
  "google docs": "https://docs.google.com",
  "google sheets": "https://sheets.google.com",
  "google calendar": "https://calendar.google.com",
  "google maps": "https://maps.google.com",
  "google meet": "https://meet.google.com",
  github: "https://github.com",
  stackoverflow: "https://stackoverflow.com",
  "stack overflow": "https://stackoverflow.com",
  wikipedia: "https://www.wikipedia.org",
  linkedin: "https://www.linkedin.com",
  reddit: "https://www.reddit.com",
  twitter: "https://x.com",
  x: "https://x.com",
  instagram: "https://www.instagram.com",
  whatsapp: "https://web.whatsapp.com",
  "whatsapp web": "https://web.whatsapp.com",
  netflix: "https://www.netflix.com",
  spotify: "https://open.spotify.com",
  amazon: "https://www.amazon.com",
  claude: "https://claude.ai",
  gemini: "https://gemini.google.com",
  "ai studio": "https://aistudio.google.com",
  vercel: "https://vercel.com",
  npm: "https://www.npmjs.com",
  "next js": "https://nextjs.org/docs",
  nextjs: "https://nextjs.org/docs",
  "three js": "https://threejs.org/docs",
  threejs: "https://threejs.org/docs",
  mdn: "https://developer.mozilla.org",
  // Common application web clients. These open the service in a new browser tab.
  chatgpt: "https://chatgpt.com",
  zoom: "https://zoom.us/join",
  discord: "https://discord.com/app",
  telegram: "https://web.telegram.org",
  slack: "https://app.slack.com/client",
  teams: "https://teams.microsoft.com",
  outlook: "https://outlook.office.com/mail",
  word: "https://word.office.com",
  powerpoint: "https://powerpoint.office.com",
  onenote: "https://www.onenote.com",
  notion: "https://www.notion.so",
  trello: "https://trello.com",
  figma: "https://www.figma.com",
  canva: "https://www.canva.com",
  pinterest: "https://www.pinterest.com",
  facebook: "https://www.facebook.com",
  messenger: "https://www.messenger.com",
  tiktok: "https://www.tiktok.com",
  twitch: "https://www.twitch.tv",
  prime: "https://www.primevideo.com",
  "prime video": "https://www.primevideo.com",
  disney: "https://www.disneyplus.com",
  "disney plus": "https://www.disneyplus.com",
  perplexity: "https://www.perplexity.ai",
  copilot: "https://copilot.microsoft.com",
  calendar: "https://calendar.google.com",
};

/** Words people say that mean one of the sites above. */
export const SITE_ALIASES: Record<string, string> = {
  mail: "gmail",
  email: "gmail",
  maps: "google maps",
  drive: "google drive",
  calendar: "google calendar",
  meet: "google meet",
  sheets: "google sheets",
  insta: "instagram",
  "stack overflow": "stackoverflow",
  wiki: "wikipedia",
  "chat gpt": "chatgpt",
  "ms teams": "teams",
  "microsoft teams": "teams",
  "microsoft word": "word",
  "ms word": "word",
  "microsoft powerpoint": "powerpoint",
  "microsoft outlook": "outlook",
  "amazon prime": "prime video",
};

/** Quick links shown in the orb's hand-gesture launcher. */
export const APP_SHORTCUTS = [
  { name: "WhatsApp", key: "whatsapp", glyph: "W", color: "#25d366" },
  { name: "YouTube", key: "youtube", glyph: "▶", color: "#ff3344" },
  { name: "Gmail", key: "gmail", glyph: "M", color: "#f45b52" },
  { name: "Spotify", key: "spotify", glyph: "≋", color: "#1ed760" },
  { name: "Instagram", key: "instagram", glyph: "◎", color: "#e45aa8" },
  { name: "Discord", key: "discord", glyph: "◉", color: "#7289ff" },
  { name: "ChatGPT", key: "chatgpt", glyph: "✳", color: "#60d7ac" },
  { name: "Google Maps", key: "google maps", glyph: "⌖", color: "#58a777" },
] as const;

/** "search <query> on <site>" support. */
export const SEARCH_URLS: Record<string, (q: string) => string> = {
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  youtube: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  wikipedia: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
  github: (q) => `https://github.com/search?q=${encodeURIComponent(q)}`,
  stackoverflow: (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
  "google maps": (q) => `https://www.google.com/maps/search/${encodeURIComponent(q)}`,
  amazon: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
};

export function findSite(name: string): { label: string; url: string } | null {
  let key = name.toLowerCase().trim().replace(/\s+/g, " ");
  if (SITE_ALIASES[key]) key = SITE_ALIASES[key];
  if (SITES[key]) return { label: key, url: SITES[key] };
  const squashed = key.replace(/\s/g, "");
  for (const [k, url] of Object.entries(SITES)) {
    if (k.replace(/\s/g, "") === squashed) return { label: k, url };
  }
  return null;
}

export function siteNames(): string[] {
  return ["WhatsApp", "YouTube", "Gmail", "ChatGPT", "Discord", "Spotify", "Instagram", "GitHub"];
}
