import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

const WASM_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Landmark indices (MediaPipe hand model)
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const INDEX_MCP = 5;
// [tip, pip] pairs for index, middle, ring, pinky
const FINGERS: Array<[number, number]> = [
  [8, 6],
  [12, 10],
  [16, 14],
  [20, 18],
];

// ——— Safe-action gestures ———
// Open palm held still this long -> onOpenPalmHold (pause / resume ULTRON)
const PALM_HOLD_MS = 900;
// The palm may drift this far (normalized) while "holding" before the timer restarts
const PALM_DRIFT = 0.07;
// Palm must disappear this long before another hold can fire (prevents re-triggering)
const PALM_REARM_MS = 600;
// Swipe: open hand travels this far horizontally within this window
const SWIPE_DISTANCE = 0.3;
const SWIPE_WINDOW_MS = 450;
const SWIPE_COOLDOWN_MS = 1000;

// Pinch hysteresis: thumb–index distance relative to hand size
const PINCH_ON = 0.32;
const PINCH_OFF = 0.45;

// How strongly hand movement rotates the orb (radians per normalized unit)
const ROTATE_SPEED = 5.0;
// Smoothing factor for grab-point tracking (0..1, higher = snappier)
const SMOOTHING = 0.4;

export type GestureMode = "idle" | "spin" | "zoom";

export interface TrackerStatus {
  hands: number;
  mode: GestureMode;
  /** Open-palm hold progress, 0..1 in steps of 0.1 (1 = just triggered). */
  palm: number;
}

export interface HandTrackerCallbacks {
  /** Called when a single pinched hand drags: deltas in mirrored normalized coords. */
  onRotate(deltaTheta: number, deltaPhi: number): void;
  /** Called when both hands pinch and spread/close: multiply camera distance by factor. */
  onZoom(factor: number): void;
  onStatus(status: TrackerStatus): void;
  /** Open palm held still for ~1s (fires once per hold). */
  onOpenPalmHold?(): void;
  /** Open hand swiped sideways. Direction is from the user's point of view. */
  onSwipe?(direction: "left" | "right"): void;
  /** Both hands showing thumb, index, and middle fingers: change the orb theme. */
  onSixFingerGesture?(): void;
  /** Left hand three-finger pose plus right-hand pinch. */
  onAppLauncherGesture?(): void;
  /** Mirrored right-hand pinch position while the app-launcher pose is active. */
  onAppLauncherPointer?(point: Point | null): void;
}

interface Point {
  x: number;
  y: number;
}

interface HandState {
  pinching: boolean;
  grab: Point; // smoothed pinch midpoint, mirrored
}

export class HandTracker {
  private video: HTMLVideoElement;
  private overlay: HTMLCanvasElement;
  private callbacks: HandTrackerCallbacks;
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private rafId = 0;
  private running = false;
  private lastVideoTime = -1;

  // keyed by handedness label so state survives re-ordering between frames
  private handStates = new Map<string, HandState>();
  private prevMode: GestureMode = "idle";
  private prevSpinGrab: Point | null = null;
  private prevZoomDist: number | null = null;
  private lastStatus: TrackerStatus = { hands: 0, mode: "idle", palm: 0 };

  // open-palm hold + swipe state
  private palmStart = 0;
  private palmAnchor: Point | null = null;
  private palmArmed = true;
  private palmLostAt = 0;
  private palmFired = false;
  private swipeTrail: Array<{ t: number; x: number; y: number }> = [];
  private lastSwipeAt = 0;
  private sixFingerGestureActive = false;
  private appLauncherGestureActive = false;
  private lastLauncherPointerAt = 0;

  constructor(
    video: HTMLVideoElement,
    overlay: HTMLCanvasElement,
    callbacks: HandTrackerCallbacks,
  ) {
    this.video = video;
    this.overlay = overlay;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
    const options = {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" as const },
      runningMode: "VIDEO" as const,
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    };
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options);
    } catch {
      // Some browsers/GPUs reject the GPU delegate — fall back to CPU
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: "CPU" as const },
      });
    }

    this.running = true;
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.handStates.clear();
    this.prevMode = "idle";
    this.prevSpinGrab = null;
    this.prevZoomDist = null;
    const ctx = this.overlay.getContext("2d");
    ctx?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.resetPalm();
    this.swipeTrail = [];
    this.sixFingerGestureActive = false;
    this.emitStatus({ hands: 0, mode: "idle", palm: 0 });
  }

  private loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    if (!this.landmarker || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    const result = this.landmarker.detectForVideo(this.video, performance.now());
    this.processHands(result.landmarks, result.handedness.map((h) => h[0]?.categoryName ?? "?"));
    this.drawOverlay(result.landmarks);
  };

  private processHands(
    landmarks: NormalizedLandmark[][],
    labels: string[],
  ): void {
    const pinchedGrabs: Point[] = [];
    const palms: Point[] = [];
    const threeFingerHands: Point[] = [];
    let leftThreeFinger = false;
    let rightPinch = false;
    let rightPinchPoint: Point | null = null;
    const seen = new Set<string>();

    landmarks.forEach((lm, i) => {
      const label = labels[i];
      seen.add(label);

      const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
      if (handScale < 1e-6) return;
      const pinchRatio = dist2d(lm[THUMB_TIP], lm[INDEX_TIP]) / handScale;

      // Mirrored so hand-right = screen-right from the user's perspective
      const raw: Point = {
        x: 1 - (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2,
        y: (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2,
      };

      let state = this.handStates.get(label);
      if (!state) {
        state = { pinching: false, grab: raw };
        this.handStates.set(label, state);
      }

      // Hysteresis so the pinch doesn't flicker on/off at the threshold
      if (state.pinching && pinchRatio > PINCH_OFF) state.pinching = false;
      else if (!state.pinching && pinchRatio < PINCH_ON) state.pinching = true;

      state.grab = {
        x: state.grab.x + (raw.x - state.grab.x) * SMOOTHING,
        y: state.grab.y + (raw.y - state.grab.y) * SMOOTHING,
      };

      if (state.pinching) pinchedGrabs.push(state.grab);
      else if (isThreeFingerPose(lm, handScale)) {
        // Three extended digits (thumb, index, middle) select the color-theme gesture.
        threeFingerHands.push({ x: 1 - lm[WRIST].x, y: lm[WRIST].y });
      } else if (isOpenPalm(lm, handScale)) {
        // wrist position, mirrored like the grab point
        palms.push({ x: 1 - lm[WRIST].x, y: lm[WRIST].y });
      }
      if (label.toLowerCase() === "left" && !state.pinching && isThreeFingerPose(lm, handScale)) leftThreeFinger = true;
      if (label.toLowerCase() === "right" && state.pinching) {
        rightPinch = true;
        rightPinchPoint = state.grab;
      }
    });

    // Drop state for hands that left the frame
    for (const key of this.handStates.keys()) {
      if (!seen.has(key)) this.handStates.delete(key);
    }

    const appLauncherPose = landmarks.length === 2 && leftThreeFinger && rightPinch;
    const mode: GestureMode = appLauncherPose
      ? "idle"
      : pinchedGrabs.length >= 2 ? "zoom" : pinchedGrabs.length === 1 ? "spin" : "idle";

    // Reset reference points on any mode change to avoid jumps
    if (mode !== this.prevMode) {
      this.prevSpinGrab = null;
      this.prevZoomDist = null;
      this.prevMode = mode;
    }

    if (mode === "spin") {
      const grab = pinchedGrabs[0];
      if (this.prevSpinGrab) {
        const dx = grab.x - this.prevSpinGrab.x;
        const dy = grab.y - this.prevSpinGrab.y;
        if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) {
          this.callbacks.onRotate(dx * ROTATE_SPEED, dy * ROTATE_SPEED);
        }
      }
      this.prevSpinGrab = grab;
    } else if (mode === "zoom") {
      const d = Math.hypot(
        pinchedGrabs[0].x - pinchedGrabs[1].x,
        pinchedGrabs[0].y - pinchedGrabs[1].y,
      );
      if (this.prevZoomDist && d > 1e-4) {
        // Spread hands apart -> factor < 1 -> camera moves closer
        const factor = Math.min(1.18, Math.max(0.85, this.prevZoomDist / d));
        this.callbacks.onZoom(factor);
      }
      this.prevZoomDist = d;
    }

    const sixFingerPose = mode === "idle" && landmarks.length === 2 && threeFingerHands.length === 2;
    if (sixFingerPose && !this.sixFingerGestureActive) {
      this.sixFingerGestureActive = true;
      this.callbacks.onSixFingerGesture?.();
    } else if (!sixFingerPose) {
      this.sixFingerGestureActive = false;
    }
    if (appLauncherPose && !this.appLauncherGestureActive) this.callbacks.onAppLauncherGesture?.();
    this.appLauncherGestureActive = appLauncherPose;
    const now = performance.now();
    if (now - this.lastLauncherPointerAt > 45 || !appLauncherPose) {
      this.callbacks.onAppLauncherPointer?.(appLauncherPose ? rightPinchPoint : null);
      this.lastLauncherPointerAt = now;
    }
    this.updatePalmGestures(mode === "idle" ? palms : []);
    this.emitStatus({ hands: landmarks.length, mode, palm: this.palmProgress() });
  }

  /* ───────── open palm hold + swipe ───────── */

  private palmProgress(): number {
    if (this.palmFired) return 1;
    if (!this.palmAnchor) return 0;
    const p = Math.min(1, (performance.now() - this.palmStart) / PALM_HOLD_MS);
    return Math.floor(p * 10) / 10;
  }

  private resetPalm(): void {
    this.palmAnchor = null;
    this.palmStart = 0;
    this.palmFired = false;
    this.palmArmed = true;
    this.palmLostAt = 0;
  }

  private updatePalmGestures(palms: Point[]): void {
    const now = performance.now();
    const palm = palms[0];

    if (!palm) {
      // No open palm visible
      this.swipeTrail = [];
      this.palmAnchor = null;
      this.palmFired = false;
      if (!this.palmLostAt) this.palmLostAt = now;
      if (now - this.palmLostAt > PALM_REARM_MS) this.palmArmed = true;
      return;
    }
    this.palmLostAt = 0;

    // ——— swipe: fast horizontal travel of the open hand ———
    this.swipeTrail.push({ t: now, x: palm.x, y: palm.y });
    while (this.swipeTrail.length && now - this.swipeTrail[0].t > SWIPE_WINDOW_MS) this.swipeTrail.shift();
    const first = this.swipeTrail[0];
    if (first && now - this.lastSwipeAt > SWIPE_COOLDOWN_MS) {
      const dx = palm.x - first.x;
      const dy = palm.y - first.y;
      if (Math.abs(dx) > SWIPE_DISTANCE && Math.abs(dy) < Math.abs(dx) * 0.6) {
        this.lastSwipeAt = now;
        this.swipeTrail = [];
        this.palmAnchor = null; // moving hand is not a "hold"
        this.palmFired = false;
        this.callbacks.onSwipe?.(dx > 0 ? "right" : "left");
        return;
      }
    }

    // ——— hold: open palm kept (almost) still ———
    if (!this.palmAnchor || Math.hypot(palm.x - this.palmAnchor.x, palm.y - this.palmAnchor.y) > PALM_DRIFT) {
      this.palmAnchor = palm;
      this.palmStart = now;
      this.palmFired = false;
      return;
    }
    if (this.palmArmed && !this.palmFired && now - this.palmStart >= PALM_HOLD_MS) {
      this.palmFired = true;
      this.palmArmed = false;
      this.callbacks.onOpenPalmHold?.();
    }
  }

  private emitStatus(status: TrackerStatus): void {
    if (
      status.hands !== this.lastStatus.hands ||
      status.mode !== this.lastStatus.mode ||
      status.palm !== this.lastStatus.palm
    ) {
      this.lastStatus = status;
      this.callbacks.onStatus(status);
    }
  }

  private drawOverlay(landmarks: NormalizedLandmark[][]): void {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const { width, height } = this.overlay;
    ctx.clearRect(0, 0, width, height);

    for (const lm of landmarks) {
      const thumb = lm[THUMB_TIP];
      const index = lm[INDEX_TIP];
      // Overlay canvas sits on the mirrored video preview, so mirror x here too
      const tx = (1 - thumb.x) * width;
      const ty = thumb.y * height;
      const ix = (1 - index.x) * width;
      const iy = index.y * height;

      const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
      const pinched =
        handScale > 1e-6 && dist2d(thumb, index) / handScale < PINCH_ON;

      ctx.strokeStyle = pinched ? "#ffcc66" : "rgba(255,170,48,0.5)";
      ctx.lineWidth = pinched ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(ix, iy);
      ctx.stroke();

      ctx.fillStyle = pinched ? "#ffcc66" : "rgba(255,170,48,0.7)";
      for (const [x, y] of [
        [tx, ty],
        [ix, iy],
      ]) {
        ctx.beginPath();
        ctx.arc(x, y, pinched ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** Thumb, index and middle extended; ring and pinky folded. */
function isThreeFingerPose(lm: NormalizedLandmark[], handScale: number): boolean {
  const wrist = lm[WRIST];
  const indexExtended = dist2d(lm[8], wrist) > dist2d(lm[6], wrist) * 1.08;
  const middleExtended = dist2d(lm[12], wrist) > dist2d(lm[10], wrist) * 1.08;
  const ringFolded = dist2d(lm[16], wrist) < dist2d(lm[14], wrist) * 1.08;
  const pinkyFolded = dist2d(lm[20], wrist) < dist2d(lm[18], wrist) * 1.08;
  const thumbExtended = dist2d(lm[THUMB_TIP], lm[INDEX_MCP]) > handScale * 0.5;
  const thumbIndexOpen = dist2d(lm[THUMB_TIP], lm[INDEX_TIP]) / Math.max(handScale, 1e-6) > PINCH_OFF;
  return indexExtended && middleExtended && ringFolded && pinkyFolded && thumbExtended && thumbIndexOpen;
}

/** All four fingers straight and the thumb out, hand not pinching. Works at any hand rotation. */
function isOpenPalm(lm: NormalizedLandmark[], handScale: number): boolean {
  const wrist = lm[WRIST];
  for (const [tip, pip] of FINGERS) {
    if (dist2d(lm[tip], wrist) < dist2d(lm[pip], wrist) * 1.1) return false;
  }
  // Thumb tip must be clearly away from the base of the index finger
  return dist2d(lm[THUMB_TIP], lm[INDEX_MCP]) > handScale * 0.55;
}

function dist2d(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
