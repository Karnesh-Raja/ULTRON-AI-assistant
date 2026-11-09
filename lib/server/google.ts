import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { getDatabasePool } from "@/lib/server/database";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GOOGLE_SCOPES = {
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  calendarEvents: "https://www.googleapis.com/auth/calendar.events.owned",
} as const;
type CalendarEventItem = {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};
type GmailMimePart = { mimeType?: string; body?: { data?: string }; parts?: GmailMimePart[] };

function encryptionKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("Google integration encryption is not configured.");
  return Buffer.from(hkdfSync("sha256", secret, Buffer.from("ultron-stage3-token-storage"), Buffer.from("google-refresh-token-v1"), 32));
}

function encryptRefreshToken(token: string, email: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(email.toLowerCase()));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decryptRefreshToken(value: string, email: string): string {
  const [version, ivText, tagText, ciphertextText] = value.split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("Stored Google connection is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAAD(Buffer.from(email.toLowerCase()));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}

export async function storeGoogleConnection(input: {
  email: string;
  subject: string;
  refreshToken?: string | null;
  scopes?: string | null;
}) {
  if (!input.refreshToken) return;
  const email = input.email.trim().toLowerCase();
  const scopes = (input.scopes ?? "").split(/\s+/).filter(Boolean);
  await getDatabasePool().query(
    `INSERT INTO public.ultron_google_accounts (email, google_subject, refresh_token_enc, granted_scopes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET google_subject = EXCLUDED.google_subject,
           refresh_token_enc = EXCLUDED.refresh_token_enc,
           granted_scopes = EXCLUDED.granted_scopes,
           updated_at = now()`,
    [email, input.subject, encryptRefreshToken(input.refreshToken, email), scopes],
  );
}

export async function getGoogleConnectionStatus(email: string) {
  const { rows } = await getDatabasePool().query<{ granted_scopes: string[]; updated_at: Date }>(
    "SELECT granted_scopes, updated_at FROM public.ultron_google_accounts WHERE email = $1",
    [email.trim().toLowerCase()],
  );
  return rows[0] ? { connected: true, scopes: rows[0].granted_scopes, updatedAt: rows[0].updated_at } : { connected: false, scopes: [], updatedAt: null };
}

async function refreshGoogleAccessToken(email: string): Promise<string> {
  const normalizedEmail = email.trim().toLowerCase();
  const { rows } = await getDatabasePool().query<{ refresh_token_enc: string }>(
    "SELECT refresh_token_enc FROM public.ultron_google_accounts WHERE email = $1",
    [normalizedEmail],
  );
  if (!rows[0]) throw new Error("Connect your Google account before using Gmail or Calendar.");

  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google integration is not configured.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: decryptRefreshToken(rows[0].refresh_token_enc, normalizedEmail),
        grant_type: "refresh_token",
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({})) as { access_token?: string };
    if (!response.ok || !data.access_token) throw new Error("Google authorization expired. Reconnect your Google account.");
    return data.access_token;
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("Connect ") || error.message.startsWith("Google "))) throw error;
    throw new Error("Could not reach Google. Try again shortly.");
  } finally {
    clearTimeout(timer);
  }
}

async function googleFetch(url: string, accessToken: string, init?: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
      signal: controller.signal,
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("Google access was denied or expired. Reconnect your Google account.");
      throw new Error("Google could not complete that request.");
    }
    return data;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Google ")) throw error;
    throw new Error("Google could not complete that request.");
  } finally {
    clearTimeout(timer);
  }
}

function requireScope(scopes: string[], expected: string) {
  if (!scopes.includes(expected)) throw new Error("Reconnect Google and approve the requested permission to use this feature.");
}

export async function searchGmail(email: string, query: string) {
  const status = await getGoogleConnectionStatus(email);
  requireScope(status.scopes, GOOGLE_SCOPES.gmailRead);
  const accessToken = await refreshGoogleAccessToken(email);
  const searchUrl = new URL(`${GOOGLE_API}/messages`);
  searchUrl.searchParams.set("q", query.slice(0, 200));
  searchUrl.searchParams.set("maxResults", "5");
  const search = await googleFetch(searchUrl.toString(), accessToken) as { messages?: Array<{ id: string }> };
  const messages = await Promise.all((search.messages ?? []).slice(0, 5).map(async ({ id }) => {
    const messageUrl = new URL(`${GOOGLE_API}/messages/${encodeURIComponent(id)}`);
    messageUrl.searchParams.set("format", "full");
    const message = await googleFetch(messageUrl.toString(), accessToken) as {
      id?: string;
      snippet?: string;
      payload?: GmailMimePart & { headers?: Array<{ name: string; value: string }> };
    };
    const header = (name: string) => message.payload?.headers?.find((item) => item.name.toLowerCase() === name)?.value ?? "";
    const bodyParts: string[] = [];
    const collect = (part?: GmailMimePart) => {
      if (!part) return;
      if (part.mimeType === "text/plain" && part.body?.data) bodyParts.push(Buffer.from(part.body.data, "base64url").toString("utf8"));
      for (const nested of part.parts ?? []) collect(nested);
    };
    collect(message.payload);
    const body = (bodyParts.join("\n") || message.snippet || "").replace(/\s+/g, " ").trim().slice(0, 1800);
    return { id: message.id ?? id, from: header("from").slice(0, 180), subject: header("subject").slice(0, 240), date: header("date").slice(0, 100), snippet: (message.snippet ?? "").slice(0, 400), excerpt: body };
  }));
  return messages;
}

export async function listCalendarEvents(email: string, start: Date, end: Date) {
  const status = await getGoogleConnectionStatus(email);
  requireScope(status.scopes, GOOGLE_SCOPES.calendarEvents);
  const accessToken = await refreshGoogleAccessToken(email);
  const url = new URL(CALENDAR_API);
  url.searchParams.set("timeMin", start.toISOString());
  url.searchParams.set("timeMax", end.toISOString());
  url.searchParams.set("maxResults", "20");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  const data = await googleFetch(url.toString(), accessToken) as { items?: CalendarEventItem[] };
  return (data.items ?? []).slice(0, 20).map((event) => ({
    id: event.id,
    title: (event.summary ?? "Untitled event").slice(0, 200),
    description: event.description?.slice(0, 500) ?? "",
    location: event.location?.slice(0, 200) ?? "",
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
  }));
}

export async function createCalendarEvent(email: string, input: { title: string; description?: string; start: string; end: string; timeZone?: string }) {
  const status = await getGoogleConnectionStatus(email);
  requireScope(status.scopes, GOOGLE_SCOPES.calendarEvents);
  const accessToken = await refreshGoogleAccessToken(email);
  const payload = {
    summary: input.title.trim().slice(0, 200),
    description: input.description?.trim().slice(0, 2000) ?? "",
    start: { dateTime: input.start, ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
    end: { dateTime: input.end, ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
  };
  return googleFetch(CALENDAR_API, accessToken, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

export async function sendGmail(email: string, input: { to: string; subject: string; body: string }) {
  const status = await getGoogleConnectionStatus(email);
  requireScope(status.scopes, GOOGLE_SCOPES.gmailSend);
  const accessToken = await refreshGoogleAccessToken(email);
  const content = [
    `To: ${input.to.trim()}`,
    `Subject: ${input.subject.trim().replace(/[\r\n]/g, " ").slice(0, 240)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    input.body.trim().slice(0, 8000),
  ].join("\r\n");
  const raw = Buffer.from(content, "utf8").toString("base64url");
  return googleFetch(`${GOOGLE_API}/messages/send`, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
}

export async function disconnectGoogle(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const { rows } = await getDatabasePool().query<{ refresh_token_enc: string }>(
    "SELECT refresh_token_enc FROM public.ultron_google_accounts WHERE email = $1",
    [normalizedEmail],
  );
  if (rows[0]) {
    const token = decryptRefreshToken(rows[0].refresh_token_enc, normalizedEmail);
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      cache: "no-store",
    }).catch(() => {});
  }
  await getDatabasePool().query("DELETE FROM public.ultron_google_accounts WHERE email = $1", [normalizedEmail]);
}

export { GOOGLE_SCOPES };
