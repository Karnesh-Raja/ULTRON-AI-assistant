# ULTRON Orb UI

**Project presentation by C. Karnesh Raja**  
First-year student, Department of Artificial Intelligence & Data Science  
SRM Valliammai Engineering College

## About this project

ULTRON Orb UI is an Iron Man–inspired interactive holographic orb interface. It is built with **Next.js**, **Three.js**, and **MediaPipe** hand tracking, and can be controlled with a mouse, touch, keyboard, or webcam-based hand gestures.

I am a first-year student exploring artificial intelligence, software development, and interactive interfaces. I prepared this project README to present the features and setup of the ULTRON Orb UI project as part of my learning. The original ULTRON project and its underlying work are credited to their respective creators; this interface should not be mistaken for an AI system created entirely by me.

> ULTRON is described by its original creator as an open-source interface for an AI assistant.
![ULTRON orb UI](docs/screenshot.png)

https://github.com/user-attachments/assets/91578a83-9a27-44e8-84b0-96defcfd7366

## Getting started

Install the dependencies, copy `.env.local.example` to `.env.local`, and fill in its values privately. Never commit `.env.local` or paste its contents into chat. The Google Cloud OAuth setup is described below.

For local PostgreSQL, apply the local schema using the migration account, then start the development server:

```bash
npm install
npm run db:migrate
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Controls

### Mouse and touch

| Input | Action |
| --- | --- |
| Drag | Spin the orb |
| Scroll or pinch | Zoom in and out |

### Hand gestures (webcam)

Click **GESTURES OFF** (or press `G`) and allow camera access.

| Gesture | Action |
| --- | --- |
| Pinch thumb and index finger with one hand, then move | Spin the orb |
| Pinch with both hands and spread them apart or bring them together | Zoom in or out |

### Keyboard

| Key | Action |
| --- | --- |
| `G` | Toggle hand gestures |
| `T` | Show or hide the text and chat panel (use its × button to close) |
| `R` | Reset the view |
| `+` / `−` | Zoom in or out |

## Voice assistant features

Create `.env.local` from `.env.local.example` and add your `GEMINI_API_KEY`. Start the app with `npm run dev`, then open it in **Chrome or Edge**.

| Feature | Example |
| --- | --- |
| **Wake word** | Click **WAKE WORD** (or press `W`), allow microphone access, then say “Hey ULTRON, what time is it?” |
| **Time and date** | “What time is it?” or “What's today's date?” |
| **Timers and reminders** | “Set a timer for 5 minutes,” “Remind me in 10 minutes to call mom,” “How much time is left?” |
| **Notes** | “Take a note: demo is on Friday,” “Show my notes,” or “Delete the last note” |
| **To-do list** | “Add buy milk to my to-do list,” “Show my to-do list,” or “Mark todo 2 as done” |
| **Open apps and websites** | “Open WhatsApp,” “Open Spotify,” or “Search for python decorators on YouTube.” Supported sites are listed in `lib/sites.ts`. |
| **Project docs search** | “Search the docs for gestures” searches `README.md`, `/knowledge`, and `/docs`. |
| **Conversation memory** | Ask a follow-up such as “Explain that with another example.” Say “Clear history” to reset. |
| **Long-term memory** | Ask ULTRON to remember a preference or useful fact. Open the **MEMORY** panel to review or forget saved items. Memory is stored in PostgreSQL, not browser storage. |
| **Gmail and Calendar** | Connect the allowlisted Google account from **INTEGRATIONS**. Ask ULTRON to search requested email or events. It asks you to approve each email send and each new calendar event. |
| **Orb states** | Idle (amber), listening (blue), thinking (fast spin), speaking (pulses per word), error (red), and paused (dim). |
| **Orb colors** | Choose orange, blue, violet, teal, or rose from the color menu beside the ULTRON title. |
| **Gesture actions** | Hold an open palm for about one second to pause or resume. Swipe an open hand left or right to change panels. Zoom into the core, then hold three fingers up on your left hand and pinch with your right hand to show app shortcuts. Hold the right-hand pinch cursor over an icon for 4.5 seconds to open it. |

Other shortcuts: `P` pause, `W` wake word, `G` gestures, `T` text panel, and `R` reset view.

### Known limits

- Wake word detection uses browser speech recognition. It works in Chrome and Edge, needs internet access, and requires the tab to stay open; it is not an offline always-on hot-word engine.
- Voice commands open supported web versions of apps in a new tab. A browser cannot launch arbitrary installed desktop apps. Add web shortcuts in `lib/sites.ts` to support more web apps.
- Notes, to-dos, timers, and chat history are stored in this browser's `localStorage`. Timers stop if the tab is closed. Long-term memories use PostgreSQL when database credentials and the schema migration are configured.
- Notes, to-dos, timers, and chat history still live in each browser. Long-term memories and encrypted Google refresh tokens live in PostgreSQL.
- Gmail excerpts and Calendar event details are sent to Gemini only when you ask ULTRON to use those integrations. Attachments are not read. ULTRON never sends email or creates a Calendar event without your approval of the exact details.
- Google OAuth uses a single allowlisted account and requests Gmail read/send plus access to events on calendars you own. Keep the Google OAuth app in Testing for personal use; add your account as a test user. Google documents limited refresh-token lifetime in Testing mode, so you may need to reconnect periodically.
- The local PostgreSQL server is only for local development. The hosted Netlify app uses Netlify Database; existing local memory rows are not copied automatically.
- The Netlify project is private behind team login. On a phone, sign into your Netlify account in the browser, then open the deployed ULTRON URL. This is a responsive web app, not a native mobile app.
- Documentation search checks only `README.md`, `/knowledge`, and `/docs` in the project. It uses keyword matching rather than semantic search.

## How it works

- **`lib/orbScene.ts`** — Three.js scene with layered wireframe shells, a spiral inner core, floating code-text sprites, orbiting debris, dust particles, scan rings, and bloom and chromatic-aberration post-processing.
- **`lib/handTracker.ts`** — MediaPipe HandLandmarker runs on the webcam feed. One pinched hand spins the orb; two pinched hands zoom by moving apart or together.
- **`components/JarvisOrb.tsx`** — HUD and connections between the scene, tracker, voice, chat memory, and user input.
- **`lib/assistant.ts`** — Local command router for time, timers, notes, to-dos, websites, and documentation search.
- **`app/api/agent/route.ts`** — Authenticated Gemini function-calling endpoint with bounded tools for local tasks, documentation, PostgreSQL memory, Gmail, and Calendar.
- **`app/api/memories/route.ts`** — Read, search, create, update, and forget long-term memory records in PostgreSQL.
- **`lib/server/auth.ts`** — Allowlisted Google sign-in; app sessions never expose OAuth tokens to browser JavaScript.
- **`lib/server/google.ts`** — Gmail/Calendar API calls and AES-GCM encryption for refresh tokens stored in PostgreSQL.
- **`lib/server/database.ts`** — Reused PostgreSQL connection pool using local `DATABASE_URL` or the Netlify Database connection.
- **`db/migrations/0001_create_memories.sql`** — Creates the memory table, search index, and least-privilege runtime grants.
- **`netlify/database/migrations/`** — Netlify applies the hosted database schema migrations during deployment.
- **`lib/wakeWord.ts`** — “Hey ULTRON” listener built on the Web Speech API.
- **`app/api/chat/route.ts`** — Gemini proxy with model fallback and conversation history.

### Local PostgreSQL and Google OAuth setup

Put local PostgreSQL URLs and OAuth values in ignored `.env.local`. Use `ultron_app` for `DATABASE_URL` and `ultron_migrator` for `DATABASE_MIGRATION_URL`. URL-encode special characters in passwords. Generate a random `NEXTAUTH_SECRET` of at least 32 characters; do not reuse your Gemini key or PostgreSQL password.

In Google Cloud Console:

1. Create or select a project and enable **Gmail API** and **Google Calendar API**.
2. Configure the OAuth consent screen as an external testing app and add the same Google account used in `ULTRON_ALLOWED_EMAIL` to the test users.
3. Create an OAuth Client ID of type **Web application**.
4. Add this local authorized redirect URI: `http://localhost:3000/api/auth/callback/google`.
5. Put the client ID and client secret in `.env.local` as `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`.

For the hosted site, add the production redirect URI `https://ultron-personal.netlify.app/api/auth/callback/google` to that same Google OAuth client. Put the Google client ID/secret, `NEXTAUTH_SECRET`, `ULTRON_ALLOWED_EMAIL`, `NEXTAUTH_URL`, and `GEMINI_API_KEY` into Netlify's site environment settings as secrets. Set hosted `NEXTAUTH_URL` to `https://ultron-personal.netlify.app`.

The requested OAuth scopes are `gmail.readonly`, `gmail.send`, and `calendar.events.owned`. ULTRON only exposes search, send, event listing, and event creation; it does not expose message deletion or event deletion. See Google's [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), and [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

The local migration script applies the files in `db/migrations/`:

```bash
npm run db:migrate
```

For Netlify, the SQL files under `netlify/database/migrations/` create the hosted schema during deployment. Do not point `npm run db:migrate` at Netlify Database. The hosted database starts with a new schema; copy local memory rows only if you want them in the cloud. Keep local PostgreSQL bound to `localhost` and never expose port 5432 to the public internet.
- **`app/api/docs/route.ts`** — Keyword search over project documentation.

## Updates in this build

- Gesture callbacks avoid redundant pointer state updates and stop cleanly when the component unmounts or camera startup is cancelled.
- Push-to-talk is available from the always-visible controls as **MIC INPUT**.
- The **STUDY** panel accepts a FEN position and opens Lichess analysis for post-game study.

## Chess mode

Open the text panel and select the **CHESS** tab (or say or type an action that opens it). Chess opens in a dedicated full-window view. The orb HUD, gesture camera, wake word, microphone, and voice controls are hidden and switched off while you play. The board adapts to the window size: wide windows show the board with a side panel, while narrow or half-screen windows stack them.

- Choose **WHITE** or **BLACK**, select **EASY / MEDIUM / HARD**, click a piece, then click a highlighted square.
- **HINT** highlights the engine's suggestion, **UNDO** takes back your last move, and **NEW GAME** restarts.
- Includes hand-drawn SVG pieces, move animation, check highlighting, captured pieces and material lead, an evaluation bar, and a move list.
- The theme button switches between orange and blue. Select **EXIT CHESS** or press `Esc` to return to ULTRON. The game is saved in this browser.
- Orb shortcuts such as `G`, `W`, `P`, and `T` are disabled while chess is open.

Chess code: `lib/chess/engine.ts` (rules and search, no dependencies), `lib/chess/worker.ts` (runs search in a Web Worker), `components/ChessPanel.tsx` (board UI), and `components/chessPieces.tsx` (SVG piece set).

