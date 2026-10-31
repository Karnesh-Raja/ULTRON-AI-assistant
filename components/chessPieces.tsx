import type { ReactElement } from "react";

/**
 * Hand-drawn SVG chess set. Every piece lives in a 100×100 box, is filled with
 * theme-aware gradients (see <PieceDefs/>), and gets a second "sheen" pass for volume.
 * Colours come from CSS variables set on .chess-stage, so the orange/blue themes restyle them.
 */

export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

type Shape = { d?: string; c?: [number, number, number] };
interface Def { shapes: Shape[]; lines: [string, number][]; dots: [number, number, number][] }

const BASE: Shape[] = [
  { d: "M20 90 Q20 85 25 85 H75 Q80 85 80 90 V92 Q80 95 75 95 H25 Q20 95 20 92 Z" },
  { d: "M27 85 V80 Q27 77 30 77 H70 Q73 77 73 80 V85 Z" },
];

const DEFS: Record<PieceType, Def> = {
  p: {
    shapes: [
      { d: "M39 77 C41 68 45 62 45 54 H55 C55 62 59 68 61 77 Z" },
      { d: "M37 54 Q37 49 42 49 H58 Q63 49 63 54 Z" },
      { c: [50, 36, 11] },
    ],
    lines: [],
    dots: [],
  },
  r: {
    shapes: [
      { d: "M29 17 H40 V24 H45 V17 H55 V24 H60 V17 H71 V35 Q71 38 68 38 H32 Q29 38 29 35 Z" },
      { d: "M35 38 H65 L67 66 H33 Z" },
      { d: "M30 69 Q30 66 33 66 H67 Q70 66 70 69 V77 H30 Z" },
    ],
    lines: [["M35 38 H65", 1.4]],
    dots: [],
  },
  n: {
    shapes: [
      { d: "M27 77 C27 70 31 64 38 58 C41 55 42 52 40 50 C36 52 30 52 25 49 C22 47 22 42 25 39 C29 33 33 27 36 20 L40 15 L44 21 C50 17 58 19 64 26 C73 36 76 52 72 64 C70 70 70 74 72 77 Z" },
    ],
    lines: [["M50 24 C60 32 66 46 64 62", 1.6], ["M45 31 C54 39 58 51 56 63", 1.4], ["M31 42 C34 44 37 44 40 43", 1.2]],
    dots: [[36, 31, 2.3], [25, 43, 1.3]],
  },
  b: {
    shapes: [
      { d: "M50 12 C60 20 66 30 63 40 C62 44 58 46 55 47 H45 C42 46 38 44 37 40 C34 30 40 20 50 12 Z" },
      { c: [50, 10, 3.6] },
      { d: "M35 53 Q35 48 40 48 H60 Q65 48 65 53 Z" },
      { d: "M42 53 C42 64 38 70 34 77 H66 C62 70 58 64 58 53 Z" },
    ],
    lines: [["M45 25 L56 37", 2.4]],
    dots: [],
  },
  q: {
    shapes: [
      { d: "M26 26 L35 46 L38 24 L45 44 L50 22 L55 44 L62 24 L65 46 L74 26 L70 54 H30 Z" },
      { c: [26, 23, 3.3] },
      { c: [38, 20, 3.3] },
      { c: [50, 18, 3.6] },
      { c: [62, 20, 3.3] },
      { c: [74, 23, 3.3] },
      { d: "M29 54 H71 V60 Q71 62 69 62 H31 Q29 62 29 60 Z" },
      { d: "M34 62 H66 C64 68 64 72 68 77 H32 C36 72 36 68 34 62 Z" },
    ],
    lines: [],
    dots: [],
  },
  k: {
    shapes: [
      { d: "M47 5 H53 V12 H60 V18 H53 V26 H47 V18 H40 V12 H47 Z" },
      { d: "M30 40 C30 32 38 27 50 27 C62 27 70 32 70 40 L69 54 H31 Z" },
      { d: "M29 54 H71 V60 Q71 62 69 62 H31 Q29 62 29 60 Z" },
      { d: "M34 62 H66 C64 68 64 72 68 77 H32 C36 72 36 68 34 62 Z" },
    ],
    lines: [["M35 41 C42 36 58 36 65 41", 1.6]],
    dots: [],
  },
};

function ShapeEl({ s }: { s: Shape }): ReactElement {
  return s.d ? <path d={s.d} /> : <circle cx={s.c![0]} cy={s.c![1]} r={s.c![2]} />;
}

/** Render once per board: gradients shared by every piece. */
export function PieceDefs(): ReactElement {
  return (
    <svg className="pc-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="pc-fill-w" gradientUnits="userSpaceOnUse" x1="22" y1="10" x2="80" y2="90">
          <stop offset="0" style={{ stopColor: "var(--pw1)" }} />
          <stop offset="0.5" style={{ stopColor: "var(--pw2)" }} />
          <stop offset="1" style={{ stopColor: "var(--pw3)" }} />
        </linearGradient>
        <linearGradient id="pc-fill-b" gradientUnits="userSpaceOnUse" x1="22" y1="10" x2="80" y2="90">
          <stop offset="0" style={{ stopColor: "var(--pb1)" }} />
          <stop offset="0.5" style={{ stopColor: "var(--pb2)" }} />
          <stop offset="1" style={{ stopColor: "var(--pb3)" }} />
        </linearGradient>
        <linearGradient id="pc-sheen" gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="80" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="0.28" stopColor="#fff" stopOpacity="0.12" />
          <stop offset="0.6" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.32" />
        </linearGradient>
        <linearGradient id="pc-gloss" gradientUnits="userSpaceOnUse" x1="0" y1="8" x2="0" y2="60">
          <stop offset="0" stopColor="#fff" stopOpacity="0.38" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** A single chess piece. `color` is "w" or "b". */
export function Piece({ type, color }: { type: PieceType; color: "w" | "b" }): ReactElement {
  const def = DEFS[type];
  const shapes = [...BASE, ...def.shapes];
  const white = color === "w";
  return (
    <svg className={`pc-svg ${white ? "pc-w" : "pc-b"}`} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <g className="pc-body" fill={white ? "url(#pc-fill-w)" : "url(#pc-fill-b)"}>
        {shapes.map((s, i) => <ShapeEl key={i} s={s} />)}
      </g>
      <g className="pc-sheen" fill="url(#pc-sheen)" stroke="none">
        {shapes.map((s, i) => <ShapeEl key={i} s={s} />)}
      </g>
      <g className="pc-gloss" fill="url(#pc-gloss)" stroke="none">
        {def.shapes.map((s, i) => <ShapeEl key={i} s={s} />)}
      </g>
      <g className="pc-lines" fill="none">
        {def.lines.map(([d, w], i) => <path key={i} d={d} strokeWidth={w} />)}
        <path className="pc-foot-line" d="M25 88.5 H75" />
      </g>
      {def.dots.map(([cx, cy, r], i) => <circle key={i} className="pc-dot" cx={cx} cy={cy} r={r} />)}
    </svg>
  );
}
