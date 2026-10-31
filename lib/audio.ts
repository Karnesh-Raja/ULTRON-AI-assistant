let ctx: AudioContext | null = null;

/** Short UI beep (wake-word acknowledged, timer finished). Silent if the browser blocks audio. */
export function beep(freq = 880, seconds = 0.12, when = 0): void {
  try {
    if (typeof window === "undefined") return;
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = ctx ?? new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
    const start = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + seconds + 0.02);
  } catch {
    /* ignore */
  }
}
