"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Position, START_FEN } from "@/lib/chess/engine";
import type { ChessRequest, ChessResponse } from "@/lib/chess/worker";
import { Piece, PieceDefs, type PieceType } from "./chessPieces";

type Side = "w" | "b";
type Level = "easy" | "medium" | "hard";

const LEVELS: Record<Level, { depth: number; ms: number; label: string }> = {
  easy: { depth: 3, ms: 400, label: "EASY" },
  medium: { depth: 5, ms: 1500, label: "MEDIUM" },
  hard: { depth: 9, ms: 4000, label: "HARD" },
};

const FILES = "abcdefgh";
const STORE_KEY = "ultron.chess";
const INITIAL_COUNT: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const CAPTURE_ORDER = ["q", "r", "b", "n", "p"];

const sqName = (file: number, rank: number) => FILES[file] + (rank + 1);
const isWhitePiece = (p: string) => p === p.toUpperCase();

function formatEval(score: number, mate: number | null): string {
  if (mate !== null) return mate > 0 ? `M${mate}` : `-M${-mate}`;
  const v = score / 100;
  return (v > 0 ? "+" : "") + v.toFixed(2);
}

/** 0–100: share of the eval bar that belongs to White. */
function evalPercent(e: { score: number; mate: number | null } | null): number {
  if (!e) return 50;
  if (e.mate !== null) return e.mate > 0 ? 100 : 0;
  return Math.max(4, Math.min(96, 50 + 50 * Math.tanh(e.score / 500)));
}

/** Pieces of each colour that are no longer on the board (derived from the position). */
function missingPieces(board: (string | null)[][]) {
  const have: Record<string, number> = {};
  for (const row of board) for (const p of row) if (p) have[p] = (have[p] ?? 0) + 1;
  const result: Record<Side, string[]> = { w: [], b: [] };
  for (const t of CAPTURE_ORDER) {
    for (const color of ["w", "b"] as Side[]) {
      const key = color === "w" ? t.toUpperCase() : t;
      const gone = Math.max(0, INITIAL_COUNT[t] - (have[key] ?? 0));
      for (let i = 0; i < gone; i++) result[color].push(t);
    }
  }
  return result;
}

interface Props {
  theme: string;
  onToggleTheme: () => void;
  onExit: () => void;
}

export default function ChessPanel({ theme, onToggleTheme, onExit }: Props) {
  const [side, setSide] = useState<Side>("w"); // the human's colour
  const [level, setLevel] = useState<Level>("medium");
  const [moves, setMoves] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [evalNum, setEvalNum] = useState<{ score: number; mate: number | null; depth: number } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [hintMove, setHintMove] = useState<{ from: string; to: string } | null>(null);
  const [hintBusy, setHintBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [anim, setAnim] = useState<{ n: number; uci: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const reqId = useRef(0);
  const pending = useRef<Map<number, (r: ChessResponse) => void>>(new Map());
  const movesBoxRef = useRef<HTMLDivElement>(null);

  // Rebuild the position from the move list (cheap, keeps state simple and undo trivial)
  const { pos, board, status, lastMove, legalFrom, turn, sans, checkSq } = useMemo(() => {
    const p = new Position(START_FEN);
    const sanList: string[] = [];
    for (const u of moves) {
      const m = p.moveFromUci(u);
      if (m) {
        sanList.push(p.san(m));
        p.make(m);
      }
    }
    const legal = p.legalMoves().map((m) => p.uci(m));
    const grid: (string | null)[][] = [];
    for (let r = 0; r < 8; r++) {
      const row: (string | null)[] = [];
      for (let f = 0; f < 8; f++) row.push(p.pieceAt(sqName(f, r)));
      grid.push(row);
    }
    let check: string | null = null;
    if (p.inCheck()) {
      const king = p.sideToMove === "w" ? "K" : "k";
      for (let r = 0; r < 8 && !check; r++)
        for (let f = 0; f < 8; f++) if (grid[r][f] === king) check = sqName(f, r);
    }
    return {
      pos: p,
      board: grid,
      status: p.status(),
      lastMove: moves.length ? moves[moves.length - 1] : null,
      legalFrom: legal,
      turn: p.sideToMove,
      sans: sanList,
      checkSq: check,
    };
  }, [moves]);

  /* resume the last game (and choices) from this browser */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as { side?: Side; level?: Level; moves?: string[] };
        const p = new Position(START_FEN);
        const ok: string[] = [];
        for (const u of Array.isArray(s.moves) ? s.moves : []) {
          const m = typeof u === "string" ? p.moveFromUci(u) : null;
          if (!m) break;
          p.make(m);
          ok.push(u);
        }
        if (s.side === "w" || s.side === "b") setSide(s.side);
        if (s.level && s.level in LEVELS) setLevel(s.level);
        setMoves(ok);
      }
    } catch {
      /* storage unavailable or corrupt: start fresh */
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ side, level, moves }));
    } catch {
      /* ignore */
    }
  }, [loaded, side, level, moves]);

  /* worker lifecycle */
  useEffect(() => {
    const w = new Worker(new URL("../lib/chess/worker.ts", import.meta.url));
    workerRef.current = w;
    w.onmessage = (e: MessageEvent<ChessResponse>) => {
      const cb = pending.current.get(e.data.id);
      if (cb) {
        pending.current.delete(e.data.id);
        cb(e.data);
      }
    };
    const map = pending.current;
    return () => {
      w.terminate();
      map.clear();
    };
  }, []);

  const ask = useCallback((moveList: string[], depth: number, ms: number) => {
    return new Promise<ChessResponse>((resolve) => {
      const id = ++reqId.current;
      pending.current.set(id, resolve);
      const req: ChessRequest = { id, startFen: START_FEN, moves: moveList, depth, ms };
      workerRef.current?.postMessage(req);
    });
  }, []);

  /* AI replies when it is its turn */
  useEffect(() => {
    if (!loaded || status.over || turn === side || thinking) return;
    let cancelled = false;
    setThinking(true);
    setHint(null);
    setHintMove(null);
    const cfg = LEVELS[level];
    ask(moves, cfg.depth, cfg.ms).then((r) => {
      if (cancelled) return;
      setThinking(false);
      if (r.error || !r.move) {
        setNotice(r.error ? "Engine error: " + r.error : "");
        return;
      }
      setEvalNum({ score: r.score, mate: r.mate, depth: r.depth });
      setAnim({ n: moves.length + 1, uci: r.move });
      setMoves((prev) => [...prev, r.move!]);
    });
    return () => {
      cancelled = true;
      setThinking(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, moves, side, status.over]);

  const playHuman = useCallback(
    (uci: string) => {
      const m = pos.moveFromUci(uci);
      if (!m) return;
      setAnim({ n: moves.length + 1, uci });
      setMoves((prev) => [...prev, uci]);
      setSelected(null);
      setHint(null);
      setHintMove(null);
      setNotice("");
    },
    [pos, moves.length],
  );

  const onSquare = (file: number, rank: number) => {
    if (status.over || thinking || turn !== side) return;
    const name = sqName(file, rank);
    const piece = board[rank][file];
    const mine = piece && (side === "w" ? isWhitePiece(piece) : !isWhitePiece(piece));
    if (selected) {
      const candidates = legalFrom.filter((u) => u.startsWith(selected) && u.slice(2, 4) === name);
      if (candidates.length) {
        // auto-queen on promotion
        const uci = candidates.find((u) => u.length === 5 && u[4] === "q") ?? candidates[0];
        playHuman(uci);
        return;
      }
    }
    setSelected(mine ? name : null);
  };

  const targets = useMemo(
    () => (selected ? legalFrom.filter((u) => u.startsWith(selected)).map((u) => u.slice(2, 4)) : []),
    [selected, legalFrom],
  );

  const newGame = (s: Side = side) => {
    pending.current.clear();
    setSide(s);
    setMoves([]);
    setSelected(null);
    setHint(null);
    setHintMove(null);
    setEvalNum(null);
    setAnim(null);
    setNotice("");
  };

  const undo = () => {
    if (thinking || !moves.length) return;
    // take back to the human's previous turn
    const drop = turn === side ? 2 : 1;
    setMoves(moves.slice(0, Math.max(0, moves.length - drop)));
    setSelected(null);
    setHint(null);
    setHintMove(null);
    setAnim(null);
  };

  const getHint = async () => {
    if (hintBusy || thinking || status.over || turn !== side) return;
    setHintBusy(true);
    const r = await ask(moves, 7, 2000);
    setHintBusy(false);
    if (r.move) {
      const m = pos.moveFromUci(r.move);
      setHint(m ? `${pos.san(m)}  (${formatEval(r.score, r.mate)})` : r.move);
      setHintMove({ from: r.move.slice(0, 2), to: r.move.slice(2, 4) });
      setSelected(r.move.slice(0, 2));
    }
  };

  // keep the newest move in view
  useEffect(() => {
    const box = movesBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [sans.length]);

  const flipped = side === "b";
  const rows = flipped ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const cols = flipped ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];

  const aiColor: Side = side === "w" ? "b" : "w";
  const missing = useMemo(() => missingPieces(board), [board]);
  // what each side has taken = the opponent's missing pieces
  const takenBy: Record<Side, string[]> = { w: missing.b, b: missing.w };
  const sum = (list: string[]) => list.reduce((a, t) => a + VALUE[t], 0);
  const lead = sum(takenBy.w) - sum(takenBy.b); // >0 White ahead

  const statusLine = status.over
    ? `${status.reason} · ${status.result}`
    : thinking
      ? "ULTRON is thinking…"
      : turn === side
        ? `Your move (${side === "w" ? "White" : "Black"})`
        : "ULTRON to move";

  const pairs: { n: number; w: string; b?: string }[] = [];
  for (let i = 0; i < sans.length; i += 2) pairs.push({ n: i / 2 + 1, w: sans[i], b: sans[i + 1] });

  const pct = status.over ? (status.result === "1-0" ? 100 : status.result === "0-1" ? 0 : 50) : evalPercent(evalNum);

  const animActive = anim && anim.n === moves.length ? anim : null;

  const renderStrip = (who: Side, human: boolean) => {
    const colorName = who === "w" ? "WHITE" : "BLACK";
    const adv = who === "w" ? lead : -lead;
    return (
      <div className={`cs-strip${turn === who && !status.over ? " active" : ""}`}>
        <span className={`cs-chip ${who === "w" ? "chip-w" : "chip-b"}`} aria-hidden="true" />
        <div className="cs-strip-name">
          {human ? "YOU" : "ULTRON AI"}
          <small>
            {colorName}
            {!human && ` · ${LEVELS[level].label}`}
          </small>
        </div>
        {!human && thinking && (
          <span className="cs-think" aria-label="thinking">
            <i /><i /><i />
          </span>
        )}
        <div className="cs-captured" aria-label={`Pieces captured by ${colorName.toLowerCase()}`}>
          {takenBy[who].map((t, i) => (
            <span className="cs-cap" key={i}>
              <Piece type={t as PieceType} color={who === "w" ? "b" : "w"} />
            </span>
          ))}
          {adv > 0 && <b className="cs-adv">+{adv}</b>}
        </div>
      </div>
    );
  };

  return (
    <section className="chess-stage" data-theme={theme} aria-label="Chess game">
      <PieceDefs />

      <header className="cs-head">
        <div className="cs-title">
          <span className="cs-logo" aria-hidden="true">
            <Piece type="n" color="b" />
          </span>
          <span>
            U.L.T.R.O.N <em>CHESS</em>
          </span>
        </div>
        <div className="cs-head-actions">
          <button type="button" className="cs-btn" onClick={onToggleTheme}>
            CYCLE COLOR
          </button>
          <button type="button" className="cs-btn cs-exit" onClick={onExit} title="Back to ULTRON (Esc)">
            ✕ EXIT CHESS
          </button>
        </div>
      </header>

      <div className="cs-body">
        <div className="cs-board-col">
          {renderStrip(aiColor, false)}

          <div className="cs-board-wrap">
            <div className={`cs-eval${flipped ? " flip" : ""}`} style={{ "--w": `${pct}%` } as CSSProperties} title="Engine evaluation">
              <div className="cs-eval-fill" />
            </div>

            <div className="cs-board" aria-label="Chess board">
              {rows.map((r) =>
                cols.map((f) => {
                  const name = sqName(f, r);
                  const piece = board[r][f];
                  const dark = (r + f) % 2 === 0;
                  const isLast = lastMove && (lastMove.slice(0, 2) === name || lastMove.slice(2, 4) === name);
                  const classes = [
                    "cs-sq",
                    dark ? "dark" : "light",
                    selected === name ? "sel" : "",
                    isLast ? "last" : "",
                    checkSq === name ? "chk" : "",
                    hintMove && (hintMove.from === name || hintMove.to === name) ? "hint" : "",
                    targets.includes(name) ? (piece ? "cap" : "dot") : "",
                  ]
                    .filter(Boolean)
                    .join(" ");

                  let pcStyle: CSSProperties | undefined;
                  let slide = false;
                  if (piece && animActive && animActive.uci.slice(2, 4) === name) {
                    const from = animActive.uci.slice(0, 2);
                    const dx = cols.indexOf(FILES.indexOf(from[0])) - cols.indexOf(f);
                    const dy = rows.indexOf(Number(from[1]) - 1) - rows.indexOf(r);
                    pcStyle = { "--dx": dx, "--dy": dy } as CSSProperties;
                    slide = true;
                  }

                  return (
                    <button key={name} type="button" className={classes} onClick={() => onSquare(f, r)} aria-label={name}>
                      {piece && (
                        <span
                          key={slide ? `${name}-${moves.length}` : name}
                          className={`pc${slide ? " slide" : ""}`}
                          style={pcStyle}
                        >
                          <Piece type={piece.toLowerCase() as PieceType} color={isWhitePiece(piece) ? "w" : "b"} />
                        </span>
                      )}
                      {cols[0] === f && <i className="rk">{r + 1}</i>}
                      {rows[rows.length - 1] === r && <i className="fl">{FILES[f]}</i>}
                    </button>
                  );
                }),
              )}

              {status.over && (
                <div className="cs-over" role="status">
                  <div className="cs-over-title">{status.reason.toUpperCase()}</div>
                  <div className="cs-over-result">{status.result}</div>
                  <button type="button" className="cs-btn cs-primary" onClick={() => newGame()}>
                    PLAY AGAIN
                  </button>
                </div>
              )}
            </div>
          </div>

          {renderStrip(side, true)}
        </div>

        <aside className="cs-side">
          <div className="cs-card cs-status">
            <div className={`cs-status-line${thinking ? " busy" : ""}`}>{statusLine}</div>
            {evalNum && (
              <div className="cs-eval-text">
                EVAL {formatEval(evalNum.score, evalNum.mate)} · DEPTH {evalNum.depth}
              </div>
            )}
            {hint && <div className="cs-hint">Suggested: {hint}</div>}
            {notice && <div className="cs-hint">{notice}</div>}
          </div>

          <div className="cs-actions">
            <button type="button" className="cs-btn" onClick={() => newGame()}>NEW GAME</button>
            <button type="button" className="cs-btn" onClick={undo} disabled={thinking || !moves.length}>UNDO</button>
            <button
              type="button"
              className="cs-btn"
              onClick={getHint}
              disabled={hintBusy || thinking || status.over || turn !== side}
            >
              {hintBusy ? "…" : "HINT"}
            </button>
          </div>

          <div className="cs-card cs-controls">
            <div className="cs-label">PLAY AS</div>
            <div className="cs-seg" role="group" aria-label="Choose your colour">
              <button type="button" aria-pressed={side === "w"} onClick={() => newGame("w")}>WHITE</button>
              <button type="button" aria-pressed={side === "b"} onClick={() => newGame("b")}>BLACK</button>
            </div>
            <div className="cs-label">AI STRENGTH</div>
            <div className="cs-seg" role="group" aria-label="AI strength">
              {(Object.keys(LEVELS) as Level[]).map((l) => (
                <button key={l} type="button" aria-pressed={level === l} onClick={() => setLevel(l)}>
                  {LEVELS[l].label}
                </button>
              ))}
            </div>
          </div>


          <div className="cs-card cs-moves-card">
            <div className="cs-label">MOVES</div>
            <div className="cs-moves" ref={movesBoxRef} aria-label="Move list">
              {pairs.length ? (
                pairs.map((p, i) => (
                  <div className="cs-move-row" key={p.n}>
                    <span className="cs-move-n">{p.n}.</span>
                    <span className={i === pairs.length - 1 && !p.b ? "cs-move now" : "cs-move"}>{p.w}</span>
                    <span className={i === pairs.length - 1 && p.b ? "cs-move now" : "cs-move"}>{p.b ?? ""}</span>
                  </div>
                ))
              ) : (
                <div className="cs-empty">Moves will appear here.</div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
