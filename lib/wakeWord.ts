import { getRecognitionCtor, type SpeechEventLike, type SpeechRecognitionLike } from "./speech";

/**
 * "Hey ULTRON" detector built on the browser's SpeechRecognition (Chrome / Edge).
 *
 * How it works: recognition runs continuously; every transcript is scanned for the wake phrase.
 * Speech recognizers often mis-hear the name, so several spellings are accepted - add more to
 * WAKE_REGEX if your accent produces something else (the browser console logs what it heard).
 */
export const WAKE_REGEX =
  /\b(?:hey|hay|hi|hello|ok|okay|yo)[\s,.!-]+(?:ultron|ultra\s?on|ultran|ultrawn|ultrone|altron|oltron|all\s?tron|ultra\s?n|ultra\s?one)\b[\s,.!:?-]*/i;

const CAPTURE_TIMEOUT_MS = 10_000;

export type WakeState = "off" | "waiting" | "capturing" | "paused";

export interface WakeOptions {
  lang?: string;
  /** Wake phrase heard; the user is about to speak a command. */
  onWake(): void;
  /** A full command was heard (wake phrase removed). */
  onCommand(text: string): void;
  /** Capture window ended without a command. */
  onCaptureEnd(): void;
  onState(state: WakeState): void;
  onError(message: string): void;
}

export class WakeWordListener {
  readonly supported: boolean;
  private opts: WakeOptions;
  private rec: SpeechRecognitionLike | null = null;
  private shouldRun = false;
  private paused = false;
  private capturing = false;
  private captureTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private state: WakeState = "off";

  constructor(opts: WakeOptions) {
    this.opts = opts;
    this.supported = getRecognitionCtor() !== null;
  }

  start(): void {
    if (!this.supported) return;
    this.shouldRun = true;
    this.paused = false;
    this.failures = 0;
    this.spawn();
  }

  stop(): void {
    this.shouldRun = false;
    this.endCapture(false);
    this.clearRestart();
    this.killRec();
    this.setState("off");
  }

  /** Stop listening temporarily (e.g. while ULTRON is speaking so it doesn't hear itself). */
  pause(): void {
    if (!this.shouldRun) return;
    this.paused = true;
    this.endCapture(false);
    this.clearRestart();
    this.killRec();
    this.setState("paused");
  }

  resume(): void {
    if (!this.shouldRun || !this.paused) return;
    this.paused = false;
    this.clearRestart();
    this.restartTimer = setTimeout(() => this.spawn(), 350);
  }

  /* ───────── internals ───────── */

  private setState(s: WakeState) {
    if (s === this.state) return;
    this.state = s;
    this.opts.onState(s);
  }

  private clearRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private killRec() {
    const r = this.rec;
    this.rec = null;
    if (!r) return;
    r.onresult = r.onerror = r.onend = r.onstart = null;
    try { r.abort(); } catch { /* already stopped */ }
  }

  private spawn() {
    if (!this.shouldRun || this.paused || this.rec) return;
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = this.opts.lang ?? "en-IN";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      this.failures = 0;
      this.setState(this.capturing ? "capturing" : "waiting");
    };
    rec.onresult = (e) => this.handleResult(e);
    rec.onerror = (e) => this.handleError(e.error);
    rec.onend = () => {
      this.rec = null;
      // Chrome ends sessions on its own every so often - quietly start a new one.
      if (this.shouldRun && !this.paused) {
        this.clearRestart();
        const delay = Math.min(5000, 300 + this.failures * 700);
        this.restartTimer = setTimeout(() => this.spawn(), delay);
      }
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.rec = null;
      this.failures++;
      this.restartTimer = setTimeout(() => this.spawn(), 1000);
    }
  }

  private handleError(code: string) {
    switch (code) {
      case "not-allowed":
      case "service-not-allowed":
        this.fatal("MICROPHONE PERMISSION DENIED - ALLOW THE MIC FOR THIS SITE");
        break;
      case "audio-capture":
        this.fatal("NO MICROPHONE FOUND");
        break;
      case "language-not-supported":
        this.fatal("SPEECH LANGUAGE NOT SUPPORTED IN THIS BROWSER");
        break;
      case "network":
        this.failures++;
        this.opts.onError("WAKE WORD NEEDS INTERNET (CHROME'S SPEECH SERVICE)");
        break;
      default:
        // "no-speech" and "aborted" are normal - onend restarts the session.
        break;
    }
  }

  private fatal(message: string) {
    this.shouldRun = false;
    this.endCapture(false);
    this.clearRestart();
    this.killRec();
    this.setState("off");
    this.opts.onError(message);
  }

  private handleResult(event: SpeechEventLike) {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = (result[0]?.transcript ?? "").trim();
      if (!text) continue;
      const final = result.isFinal;
      if (final) console.debug("[wake] heard:", text);

      const match = WAKE_REGEX.exec(text);

      if (!this.capturing) {
        if (!match) continue;
        this.beginCapture();
      }

      // Capturing: the command is whatever follows the wake phrase, or the next sentence.
      const command = (match ? text.slice(match.index + match[0].length) : text).trim();
      if (final) {
        if (command.length >= 2) {
          this.endCapture(false);
          this.opts.onCommand(command);
        }
        // else: only "hey ultron" was heard - keep waiting for the actual command
      }
    }
  }

  private beginCapture() {
    this.capturing = true;
    this.setState("capturing");
    this.opts.onWake();
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(() => this.endCapture(true), CAPTURE_TIMEOUT_MS);
  }

  private endCapture(notify: boolean) {
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = null;
    const was = this.capturing;
    this.capturing = false;
    if (this.shouldRun && !this.paused) this.setState("waiting");
    if (was && notify) this.opts.onCaptureEnd();
  }
}
