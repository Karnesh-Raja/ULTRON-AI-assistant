/** Minimal types for the browser Web Speech API (not in TypeScript's DOM lib everywhere). */

export interface SpeechAlternativeLike { transcript: string }
export interface SpeechResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechAlternativeLike;
}
export interface SpeechEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechResultLike };
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}
