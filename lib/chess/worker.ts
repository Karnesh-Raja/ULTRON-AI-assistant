/// <reference lib="webworker" />
import { Position } from "./engine";

export interface ChessRequest {
  id: number;
  startFen: string;
  moves: string[]; // UCI moves played since startFen
  depth: number;
  ms: number;
}
export interface ChessResponse {
  id: number;
  move: string | null;
  score: number; // centipawns, white's point of view
  depth: number;
  mate: number | null; // + = white mates, - = black mates (in moves)
  error?: string;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<ChessRequest>) => {
  const { id, startFen, moves, depth, ms } = event.data;
  try {
    const pos = new Position(startFen);
    for (const u of moves) {
      const m = pos.moveFromUci(u);
      if (!m) throw new Error(`Illegal move in history: ${u}`);
      pos.make(m);
    }
    const whiteToMove = pos.sideToMove === "w";
    const r = pos.search(depth, ms);
    const sign = whiteToMove ? 1 : -1;
    const res: ChessResponse = {
      id,
      move: r.move,
      score: r.score * sign,
      depth: r.depth,
      mate: r.mate === null ? null : r.mate * sign,
    };
    ctx.postMessage(res);
  } catch (err) {
    ctx.postMessage({ id, move: null, score: 0, depth: 0, mate: null, error: String(err) } satisfies ChessResponse);
  }
};
