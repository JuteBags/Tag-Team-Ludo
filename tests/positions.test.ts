// Crafted positions in tools/ai/positions (transcribed from screenshots, for the engine to review on CI).
import { describe, expect, it } from 'vitest';
import { FINISHED, SAFE_SQUARES, squareOf, trayMoves, type Color, type PlayerState } from '../src/engine';
import move87 from '../tools/ai/positions/move87.json';

interface Position { seats: { color: Color; owner: number; bot: boolean }[]; tokens: Record<string, number[]>; current: Color; tray: number[]; played: { token: number; from: number; to: number }; best: { token: number; from: number; to: number } }

describe('move 87 (2.5.0 demo, #97)', () => {
  const p = move87 as Position;
  const players: PlayerState[] = p.seats.map((s) => ({ ...s, tokens: p.tokens[s.color]! }));
  it('is a legal position: four tokens each, a die 1-6, the mover seated', () => {
    for (const pl of players) {
      expect(pl.tokens).toHaveLength(4);
      for (const t of pl.tokens) expect(t >= -1 && t <= FINISHED).toBe(true);
    }
    expect(players.some((pl) => pl.color === p.current)).toBe(true);
    for (const d of p.tray) expect(d >= 1 && d <= 6).toBe(true);
    // The yellow pair and the green single on it share a normal square; the played token starts on a star.
    expect(squareOf('yellow', 17)).toBe(squareOf('green', 43));
    expect(SAFE_SQUARES.has(squareOf('green', 43)!)).toBe(false);
    expect(SAFE_SQUARES.has(squareOf('green', 13)!)).toBe(true);
  });
  it('has the played move and the best move among the legal ones', () => {
    const moves = trayMoves(players, p.current, p.tray);
    const has = (m: { token: number; from: number; to: number }) => moves.some((x) => x.tokens.length === 1 && x.tokens[0] === m.token && x.from === m.from && x.to === m.to);
    expect(has(p.played)).toBe(true);
    expect(has(p.best)).toBe(true);
  });
});
