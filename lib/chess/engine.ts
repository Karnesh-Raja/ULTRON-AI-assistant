/* Self-contained chess engine: 0x88 board, legal move generation,
   iterative-deepening alpha-beta search with quiescence. No dependencies. */

export type Color = "w" | "b";

const WHITE = 0;
const BLACK = 8;
const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;

const PIECE_CHARS = ".PNBRQK";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const F_CAPTURE = 1;
const F_EP = 2;
const F_DOUBLE = 4;
const F_CASTLE = 8;
const F_PROMO = 16;

export interface Move {
  from: number;
  to: number;
  promo: number; // piece type (N,B,R,Q) or 0
  flags: number;
}

interface Undo {
  move: Move;
  captured: number;
  castle: number;
  ep: number;
  half: number;
  key: number;
}

const KNIGHT_DIRS = [33, 31, 18, 14, -33, -31, -18, -14];
const KING_DIRS = [1, -1, 16, -16, 17, 15, -17, -15];
const BISHOP_DIRS = [17, 15, -17, -15];
const ROOK_DIRS = [1, -1, 16, -16];

const sqName = (s: number) => "abcdefgh"[s & 7] + (((s >> 4) + 1).toString());
const sqFromName = (n: string) => (n.charCodeAt(0) - 97) + (parseInt(n[1], 10) - 1) * 16;
const onBoard = (s: number) => (s & 0x88) === 0;

/* ───────── Zobrist-style hashing (32-bit, enough for repetition + TT) ───────── */
let seed = 0x9e3779b9;
const rnd = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return seed >>> 0;
};
const ZP: number[][] = Array.from({ length: 16 }, () => Array.from({ length: 128 }, () => rnd()));
const ZSIDE = rnd();
const ZCASTLE = Array.from({ length: 16 }, () => rnd());
const ZEP = Array.from({ length: 8 }, () => rnd());

/* ───────── evaluation tables (simplified piece-square tables, white's view, a1 = index 0) ───────── */
const VALUE = [0, 100, 320, 330, 500, 900, 0];

// Tables are written rank 8 -> rank 1 for readability, then flipped.
const PST_RAW: Record<number, number[]> = {
  [P]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  [N]: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  [B]: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  [R]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  [Q]: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  [K]: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
};
const KING_END: number[] = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10, 0, 0, -10, -20, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -30, 0, 0, 0, 0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
];

// PST[piece][sq0x88] from white's perspective (rank 1 at the bottom)
const PST: number[][] = Array.from({ length: 7 }, () => new Array(128).fill(0));
const PST_END_K: number[] = new Array(128).fill(0);
for (let t = 1; t <= 6; t++) {
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const idx = r * 16 + f;
      const rawIdx = (7 - r) * 8 + f;
      PST[t][idx] = PST_RAW[t][rawIdx];
      if (t === K) PST_END_K[idx] = KING_END[rawIdx];
    }
  }
}

const MATE = 30000;
const INF = 32000;

/* ───────── Position ───────── */
export class Position {
  board = new Int8Array(128);
  turn: number = WHITE;
  castle = 0; // bits: 1 = K, 2 = Q, 4 = k, 8 = q
  ep = -1;
  half = 0;
  full = 1;
  kingSq = [0, 0];
  key = 0;
  private stack: Undo[] = [];
  /** keys of positions seen earlier in the game (for repetition) */
  history: number[] = [];

  constructor(fen: string = START_FEN) {
    this.load(fen);
  }

  load(fen: string): void {
    this.board.fill(0);
    this.stack = [];
    this.history = [];
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 2) throw new Error("Invalid FEN");
    const rows = parts[0].split("/");
    if (rows.length !== 8) throw new Error("Invalid FEN board");
    let kings = [0, 0];
    for (let i = 0; i < 8; i++) {
      const rank = 7 - i;
      let file = 0;
      for (const ch of rows[i]) {
        if (/\d/.test(ch)) {
          file += parseInt(ch, 10);
        } else {
          const lower = ch.toLowerCase();
          const t = PIECE_CHARS.indexOf(lower.toUpperCase());
          if (t < 1 || file > 7) throw new Error("Invalid FEN piece");
          const color = ch === lower ? BLACK : WHITE;
          this.board[rank * 16 + file] = t | color;
          if (t === K) {
            this.kingSq[color === WHITE ? 0 : 1] = rank * 16 + file;
            kings[color === WHITE ? 0 : 1]++;
          }
          file++;
        }
      }
      if (file !== 8) throw new Error("Invalid FEN rank");
    }
    if (kings[0] !== 1 || kings[1] !== 1) throw new Error("FEN needs exactly one king per side");
    this.turn = parts[1] === "b" ? BLACK : WHITE;
    this.castle = 0;
    const c = parts[2] ?? "-";
    if (c.includes("K")) this.castle |= 1;
    if (c.includes("Q")) this.castle |= 2;
    if (c.includes("k")) this.castle |= 4;
    if (c.includes("q")) this.castle |= 8;
    this.ep = parts[3] && parts[3] !== "-" ? sqFromName(parts[3]) : -1;
    this.half = parseInt(parts[4] ?? "0", 10) || 0;
    this.full = parseInt(parts[5] ?? "1", 10) || 1;
    this.key = this.computeKey();
  }

  private computeKey(): number {
    let k = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) continue;
      const p = this.board[s];
      if (p) k ^= ZP[p][s];
    }
    if (this.turn === BLACK) k ^= ZSIDE;
    k ^= ZCASTLE[this.castle];
    if (this.ep >= 0) k ^= ZEP[this.ep & 7];
    return k >>> 0;
  }

  fen(): string {
    let out = "";
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.board[r * 16 + f];
        if (!p) { empty++; continue; }
        if (empty) { out += empty; empty = 0; }
        const ch = PIECE_CHARS[p & 7];
        out += p & BLACK ? ch.toLowerCase() : ch;
      }
      if (empty) out += empty;
      if (r) out += "/";
    }
    const cs = (this.castle & 1 ? "K" : "") + (this.castle & 2 ? "Q" : "") + (this.castle & 4 ? "k" : "") + (this.castle & 8 ? "q" : "");
    return `${out} ${this.turn === WHITE ? "w" : "b"} ${cs || "-"} ${this.ep >= 0 ? sqName(this.ep) : "-"} ${this.half} ${this.full}`;
  }

  get sideToMove(): Color { return this.turn === WHITE ? "w" : "b"; }

  /** piece at an algebraic square, e.g. "e4" -> "P" | "p" | null */
  pieceAt(name: string): string | null {
    const p = this.board[sqFromName(name)];
    if (!p) return null;
    const ch = PIECE_CHARS[p & 7];
    return p & BLACK ? ch.toLowerCase() : ch;
  }

  /* attack detection */
  isAttacked(sq: number, byColor: number): boolean {
    const b = this.board;
    // pawns
    const pawnDir = byColor === WHITE ? -16 : 16;
    for (const d of [pawnDir + 1, pawnDir - 1]) {
      const s = sq + d;
      if (onBoard(s) && b[s] === (P | byColor)) return true;
    }
    for (const d of KNIGHT_DIRS) {
      const s = sq + d;
      if (onBoard(s) && b[s] === (N | byColor)) return true;
    }
    for (const d of KING_DIRS) {
      const s = sq + d;
      if (onBoard(s) && b[s] === (K | byColor)) return true;
    }
    for (const d of BISHOP_DIRS) {
      let s = sq + d;
      while (onBoard(s)) {
        const p = b[s];
        if (p) {
          if ((p & 8) === byColor && ((p & 7) === B || (p & 7) === Q)) return true;
          break;
        }
        s += d;
      }
    }
    for (const d of ROOK_DIRS) {
      let s = sq + d;
      while (onBoard(s)) {
        const p = b[s];
        if (p) {
          if ((p & 8) === byColor && ((p & 7) === R || (p & 7) === Q)) return true;
          break;
        }
        s += d;
      }
    }
    return false;
  }

  inCheck(color: number = this.turn): boolean {
    return this.isAttacked(this.kingSq[color === WHITE ? 0 : 1], color ^ 8);
  }

  /** Pseudo-legal moves; captureOnly for quiescence. */
  private gen(captureOnly = false): Move[] {
    const moves: Move[] = [];
    const b = this.board;
    const us = this.turn;
    const them = us ^ 8;
    const push = (from: number, to: number, flags = 0, promo = 0) => moves.push({ from, to, promo, flags });
    for (let from = 0; from < 128; from++) {
      if (from & 0x88) { from += 7; continue; }
      const p = b[from];
      if (!p || (p & 8) !== us) continue;
      const t = p & 7;
      if (t === P) {
        const dir = us === WHITE ? 16 : -16;
        const startRank = us === WHITE ? 1 : 6;
        const promoRank = us === WHITE ? 6 : 1;
        const rank = from >> 4;
        const one = from + dir;
        if (!captureOnly || rank === promoRank) {
          if (onBoard(one) && !b[one]) {
            if (rank === promoRank) {
              for (const pr of [Q, R, B, N]) push(from, one, F_PROMO, pr);
            } else if (!captureOnly) {
              push(from, one);
              const two = one + dir;
              if (rank === startRank && !b[two]) push(from, two, F_DOUBLE);
            }
          }
        }
        for (const d of [dir + 1, dir - 1]) {
          const to = from + d;
          if (!onBoard(to)) continue;
          const tp = b[to];
          if (tp && (tp & 8) === them) {
            if (rank === promoRank) {
              for (const pr of [Q, R, B, N]) push(from, to, F_CAPTURE | F_PROMO, pr);
            } else push(from, to, F_CAPTURE);
          } else if (to === this.ep && !tp) {
            push(from, to, F_CAPTURE | F_EP);
          }
        }
      } else if (t === N || t === K) {
        const dirs = t === N ? KNIGHT_DIRS : KING_DIRS;
        for (const d of dirs) {
          const to = from + d;
          if (!onBoard(to)) continue;
          const tp = b[to];
          if (!tp) { if (!captureOnly) push(from, to); }
          else if ((tp & 8) === them) push(from, to, F_CAPTURE);
        }
        if (t === K && !captureOnly) {
          const home = us === WHITE ? 4 : 0x74;
          if (from === home && !this.inCheck(us)) {
            const ks = us === WHITE ? 1 : 4;
            const qs = us === WHITE ? 2 : 8;
            if ((this.castle & ks) && !b[home + 1] && !b[home + 2] && b[home + 3] === (R | us) &&
              !this.isAttacked(home + 1, them) && !this.isAttacked(home + 2, them)) push(home, home + 2, F_CASTLE);
            if ((this.castle & qs) && !b[home - 1] && !b[home - 2] && !b[home - 3] && b[home - 4] === (R | us) &&
              !this.isAttacked(home - 1, them) && !this.isAttacked(home - 2, them)) push(home, home - 2, F_CASTLE);
          }
        }
      } else {
        const dirs = t === B ? BISHOP_DIRS : t === R ? ROOK_DIRS : KING_DIRS;
        for (const d of dirs) {
          let to = from + d;
          while (onBoard(to)) {
            const tp = b[to];
            if (!tp) {
              if (!captureOnly) push(from, to);
            } else {
              if ((tp & 8) === them) push(from, to, F_CAPTURE);
              break;
            }
            to += d;
          }
        }
      }
    }
    return moves;
  }

  make(m: Move): void {
    const b = this.board;
    const us = this.turn;
    const piece = b[m.from];
    const captured = m.flags & F_EP ? b[m.to + (us === WHITE ? -16 : 16)] : b[m.to];
    this.stack.push({ move: m, captured, castle: this.castle, ep: this.ep, half: this.half, key: this.key });
    this.history.push(this.key);

    let k = this.key;
    k ^= ZCASTLE[this.castle];
    if (this.ep >= 0) k ^= ZEP[this.ep & 7];
    k ^= ZP[piece][m.from];
    b[m.from] = 0;
    if (m.flags & F_EP) {
      const cs = m.to + (us === WHITE ? -16 : 16);
      k ^= ZP[b[cs]][cs];
      b[cs] = 0;
    } else if (captured) {
      k ^= ZP[captured][m.to];
    }
    const placed = m.flags & F_PROMO ? (m.promo | us) : piece;
    b[m.to] = placed;
    k ^= ZP[placed][m.to];

    if ((piece & 7) === K) this.kingSq[us === WHITE ? 0 : 1] = m.to;
    if (m.flags & F_CASTLE) {
      const kingSide = m.to > m.from;
      const rf = kingSide ? m.from + 3 : m.from - 4;
      const rt = kingSide ? m.from + 1 : m.from - 1;
      const rook = b[rf];
      k ^= ZP[rook][rf]; k ^= ZP[rook][rt];
      b[rt] = rook; b[rf] = 0;
    }
    // castle rights
    const lose = (sq: number) => {
      if (sq === 0) this.castle &= ~2;
      else if (sq === 7) this.castle &= ~1;
      else if (sq === 0x70) this.castle &= ~8;
      else if (sq === 0x77) this.castle &= ~4;
      else if (sq === 4) this.castle &= ~3;
      else if (sq === 0x74) this.castle &= ~12;
    };
    lose(m.from); lose(m.to);
    this.ep = m.flags & F_DOUBLE ? (m.from + m.to) >> 1 : -1;
    this.half = (piece & 7) === P || captured ? 0 : this.half + 1;
    if (us === BLACK) this.full++;
    this.turn = us ^ 8;
    k ^= ZSIDE;
    k ^= ZCASTLE[this.castle];
    if (this.ep >= 0) k ^= ZEP[this.ep & 7];
    this.key = k >>> 0;
  }

  unmake(): void {
    const u = this.stack.pop()!;
    this.history.pop();
    const m = u.move;
    const b = this.board;
    this.turn ^= 8;
    const us = this.turn;
    if (us === BLACK) this.full--;
    const placed = b[m.to];
    const piece = m.flags & F_PROMO ? (P | us) : placed;
    b[m.from] = piece;
    if (m.flags & F_EP) {
      b[m.to] = 0;
      b[m.to + (us === WHITE ? -16 : 16)] = u.captured;
    } else {
      b[m.to] = u.captured;
    }
    if ((piece & 7) === K) this.kingSq[us === WHITE ? 0 : 1] = m.from;
    if (m.flags & F_CASTLE) {
      const kingSide = m.to > m.from;
      const rf = kingSide ? m.from + 3 : m.from - 4;
      const rt = kingSide ? m.from + 1 : m.from - 1;
      b[rf] = b[rt]; b[rt] = 0;
    }
    this.castle = u.castle; this.ep = u.ep; this.half = u.half; this.key = u.key;
  }

  legalMoves(): Move[] {
    const out: Move[] = [];
    const us = this.turn;
    for (const m of this.gen()) {
      this.make(m);
      if (!this.inCheck(us)) out.push(m);
      this.unmake();
    }
    return out;
  }

  /* ── notation ── */
  uci(m: Move): string {
    return sqName(m.from) + sqName(m.to) + (m.promo ? PIECE_CHARS[m.promo].toLowerCase() : "");
  }

  moveFromUci(uci: string): Move | null {
    if (uci.length < 4) return null;
    const from = sqFromName(uci.slice(0, 2));
    const to = sqFromName(uci.slice(2, 4));
    const promo = uci[4] ? PIECE_CHARS.indexOf(uci[4].toUpperCase()) : 0;
    for (const m of this.legalMoves()) {
      if (m.from === from && m.to === to && (m.promo === promo || (!m.promo && !promo))) return m;
    }
    return null;
  }

  san(m: Move): string {
    const p = this.board[m.from];
    const t = p & 7;
    let s: string;
    if (m.flags & F_CASTLE) s = m.to > m.from ? "O-O" : "O-O-O";
    else {
      s = "";
      if (t !== P) {
        s += PIECE_CHARS[t];
        const rivals = this.legalMoves().filter((o) => o.to === m.to && o.from !== m.from && (this.board[o.from] & 7) === t);
        if (rivals.length) {
          const sameFile = rivals.some((o) => (o.from & 7) === (m.from & 7));
          const sameRank = rivals.some((o) => (o.from >> 4) === (m.from >> 4));
          if (!sameFile) s += "abcdefgh"[m.from & 7];
          else if (!sameRank) s += ((m.from >> 4) + 1).toString();
          else s += sqName(m.from);
        }
      } else if (m.flags & F_CAPTURE) s += "abcdefgh"[m.from & 7];
      if (m.flags & F_CAPTURE) s += "x";
      s += sqName(m.to);
      if (m.promo) s += "=" + PIECE_CHARS[m.promo];
    }
    this.make(m);
    if (this.inCheck()) s += this.legalMoves().length ? "+" : "#";
    this.unmake();
    return s;
  }

  /* ── game state ── */
  private repetitions(): number {
    let n = 0;
    for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i] === this.key) n++;
    return n;
  }

  insufficientMaterial(): boolean {
    const minors: number[] = [];
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) continue;
      const p = this.board[s];
      if (!p) continue;
      const t = p & 7;
      if (t === P || t === R || t === Q) return false;
      if (t !== K) minors.push(s);
    }
    if (minors.length <= 1) return true;
    if (minors.every((s) => (this.board[s] & 7) === B)) {
      const colors = new Set(minors.map((s) => ((s >> 4) + (s & 7)) & 1));
      return colors.size === 1;
    }
    return false;
  }

  status(): { over: boolean; result: string; reason: string } {
    const moves = this.legalMoves();
    if (!moves.length) {
      if (this.inCheck()) {
        return { over: true, result: this.turn === WHITE ? "0-1" : "1-0", reason: "Checkmate" };
      }
      return { over: true, result: "1/2-1/2", reason: "Stalemate" };
    }
    if (this.insufficientMaterial()) return { over: true, result: "1/2-1/2", reason: "Insufficient material" };
    if (this.half >= 100) return { over: true, result: "1/2-1/2", reason: "Fifty-move rule" };
    if (this.repetitions() >= 2) return { over: true, result: "1/2-1/2", reason: "Threefold repetition" };
    return { over: false, result: "*", reason: "" };
  }

  /* ── evaluation (centipawns, from side to move's view) ── */
  evaluate(): number {
    const b = this.board;
    let score = 0;
    let material = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = b[s];
      if (!p) continue;
      const t = p & 7;
      if (t !== K && t !== P) material += VALUE[t];
    }
    const endgame = material < 2600;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = b[s];
      if (!p) continue;
      const t = p & 7;
      const white = (p & 8) === WHITE;
      const idx = white ? s : s ^ 0x70;
      let v = VALUE[t];
      v += t === K && endgame ? PST_END_K[idx] : PST[t][idx];
      score += white ? v : -v;
    }
    return this.turn === WHITE ? score : -score;
  }

  /* ── search ── */
  private nodes = 0;
  private deadline = 0;
  private stopped = false;
  private killers: Move[][] = [];
  private tt = new Map<number, { depth: number; score: number; flag: number; best: string }>();

  private orderScore(m: Move, ttBest: string, ply: number): number {
    if (ttBest && this.uci(m) === ttBest) return 1_000_000;
    if (m.flags & F_CAPTURE) {
      const victim = m.flags & F_EP ? P : this.board[m.to] & 7;
      const attacker = this.board[m.from] & 7;
      return 100_000 + VALUE[victim] * 10 - VALUE[attacker] + (m.promo ? VALUE[m.promo] : 0);
    }
    if (m.promo) return 90_000 + VALUE[m.promo];
    const k = this.killers[ply];
    if (k && ((k[0] && k[0].from === m.from && k[0].to === m.to) || (k[1] && k[1].from === m.from && k[1].to === m.to))) return 80_000;
    return 0;
  }

  private quiesce(alpha: number, beta: number, ply: number): number {
    this.nodes++;
    if ((this.nodes & 2047) === 0 && Date.now() > this.deadline) this.stopped = true;
    if (this.stopped) return 0;
    const inCheck = this.inCheck();
    if (!inCheck) {
      const stand = this.evaluate();
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
    }
    let moves = this.gen(!inCheck);
    moves = moves.map((m) => ({ m, s: this.orderScore(m, "", ply) })).sort((a, b) => b.s - a.s).map((x) => x.m);
    let legal = 0;
    for (const m of moves) {
      const us = this.turn;
      this.make(m);
      if (this.inCheck(us)) { this.unmake(); continue; }
      legal++;
      const score = -this.quiesce(-beta, -alpha, ply + 1);
      this.unmake();
      if (this.stopped) return 0;
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    if (inCheck && legal === 0) return -MATE + ply;
    return alpha;
  }

  private negamax(depth: number, alpha: number, beta: number, ply: number): number {
    this.nodes++;
    if ((this.nodes & 2047) === 0 && Date.now() > this.deadline) this.stopped = true;
    if (this.stopped) return 0;

    if (ply > 0) {
      if (this.half >= 100 || this.repetitions() >= 1 || this.insufficientMaterial()) return 0;
    }
    const inCheck = this.inCheck();
    if (inCheck) depth++;
    if (depth <= 0) return this.quiesce(alpha, beta, ply);

    const alphaOrig = alpha;
    const entry = this.tt.get(this.key);
    let ttBest = "";
    if (entry) {
      ttBest = entry.best;
      if (entry.depth >= depth && ply > 0) {
        if (entry.flag === 0) return entry.score;
        if (entry.flag === 1 && entry.score >= beta) return entry.score;
        if (entry.flag === 2 && entry.score <= alpha) return entry.score;
      }
    }

    // null-move pruning
    if (!inCheck && depth >= 3 && ply > 0 && this.hasNonPawnMaterial(this.turn)) {
      const savedEp = this.ep, savedKey = this.key;
      this.turn ^= 8;
      this.key = (this.key ^ ZSIDE ^ (savedEp >= 0 ? ZEP[savedEp & 7] : 0)) >>> 0;
      this.ep = -1;
      this.history.push(savedKey);
      const score = -this.negamax(depth - 3, -beta, -beta + 1, ply + 1);
      this.history.pop();
      this.turn ^= 8;
      this.ep = savedEp; this.key = savedKey;
      if (this.stopped) return 0;
      if (score >= beta) return beta;
    }

    let moves = this.gen();
    const scored = moves.map((m) => ({ m, s: this.orderScore(m, ttBest, ply) }));
    scored.sort((a, b) => b.s - a.s);
    let best = -INF;
    let bestMove = "";
    let legal = 0;
    for (const { m } of scored) {
      const us = this.turn;
      this.make(m);
      if (this.inCheck(us)) { this.unmake(); continue; }
      legal++;
      let score: number;
      if (legal > 4 && depth >= 3 && !inCheck && !(m.flags & (F_CAPTURE | F_PROMO))) {
        score = -this.negamax(depth - 2, -alpha - 1, -alpha, ply + 1);
        if (score > alpha) score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      } else {
        score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      }
      this.unmake();
      if (this.stopped) return 0;
      if (score > best) { best = score; bestMove = this.uci(m); }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (!(m.flags & F_CAPTURE)) {
          const k = (this.killers[ply] ||= []);
          if (!(k[0] && k[0].from === m.from && k[0].to === m.to)) { k[1] = k[0]; k[0] = m; }
        }
        break;
      }
    }
    if (legal === 0) return inCheck ? -MATE + ply : 0;
    const flag = best <= alphaOrig ? 2 : best >= beta ? 1 : 0;
    if (this.tt.size > 400_000) this.tt.clear();
    this.tt.set(this.key, { depth, score: best, flag, best: bestMove });
    return best;
  }

  private hasNonPawnMaterial(color: number): boolean {
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = this.board[s];
      if (p && (p & 8) === color && (p & 7) !== P && (p & 7) !== K) return true;
    }
    return false;
  }

  /** Iterative deepening. Returns best move, score (cp, side-to-move view) and principal info. */
  search(maxDepth: number, maxMs: number, onProgress?: (info: SearchInfo) => void): SearchResult {
    this.nodes = 0;
    this.stopped = false;
    this.killers = [];
    this.deadline = Date.now() + maxMs;
    const rootMoves = this.legalMoves();
    if (!rootMoves.length) return { move: null, score: 0, depth: 0, nodes: 0, mate: null };
    let bestUci = this.uci(rootMoves[0]);
    let bestScore = 0;
    let doneDepth = 0;
    for (let d = 1; d <= maxDepth; d++) {
      let alpha = -INF;
      const ordered = rootMoves
        .map((m) => ({ m, s: this.uci(m) === bestUci ? 1e9 : this.orderScore(m, "", 0) }))
        .sort((a, b) => b.s - a.s);
      let iterBest = "";
      let iterScore = -INF;
      for (const { m } of ordered) {
        this.make(m);
        const score = -this.negamax(d - 1, -INF, -alpha, 1);
        this.unmake();
        if (this.stopped) break;
        if (score > iterScore) { iterScore = score; iterBest = this.uci(m); }
        if (score > alpha) alpha = score;
      }
      if (this.stopped) break;
      bestUci = iterBest; bestScore = iterScore; doneDepth = d;
      onProgress?.({ depth: d, score: bestScore, move: bestUci, nodes: this.nodes });
      if (Math.abs(bestScore) > MATE - 100) break;
      if (Date.now() > this.deadline) break;
    }
    const mate = Math.abs(bestScore) > MATE - 100 ? Math.sign(bestScore) * Math.ceil((MATE - Math.abs(bestScore)) / 2) : null;
    return { move: bestUci, score: bestScore, depth: doneDepth, nodes: this.nodes, mate };
  }

  /** Count leaf nodes (for correctness testing). */
  perft(depth: number): number {
    if (depth === 0) return 1;
    let n = 0;
    for (const m of this.legalMoves()) {
      this.make(m);
      n += this.perft(depth - 1);
      this.unmake();
    }
    return n;
  }
}

export interface SearchInfo { depth: number; score: number; move: string; nodes: number }
export interface SearchResult { move: string | null; score: number; depth: number; nodes: number; mate: number | null }
export { START_FEN };
