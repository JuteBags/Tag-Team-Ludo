// Undo (#143): the bookkeeping (src/ui/undo.ts) and the fairness it rests on, on real engine games.
import { describe, expect, it } from 'vitest';
import { createGame, mixSeed, move, moveEvent, positionKey, replay, roll, rollEvent, seeded, type GameState, type Seat } from '../src/engine';
import { UndoBook, windowAfter, type UndoFrame } from '../src/ui/undo';

const SEATS: Seat[] = [
  { color: 'blue', owner: 0, bot: false },
  { color: 'red', owner: 1, bot: true, level: 'normal' },
];
/** The game screen's dice: seeded by the game seed and the position (gameScreen rngFor). */
const rollAt = (seed: number, s: GameState, forced?: number) => roll(s, seeded(mixSeed(seed, 'dice' + positionKey(s))), forced);
const withTokens = (s: GameState, tokens: Record<string, number[]>): GameState => ({ ...s, players: s.players.map((p) => ({ ...p, tokens: tokens[p.color] ?? p.tokens })) });
const frame = (s: GameState, owner = 0, picked = true, logLen: number | null = 0): UndoFrame<{ kills: number }> => ({ owner, state: s, logLen, counters: { kills: 0 }, picked });

describe('undo bookkeeping', () => {
  it('restores the exact state from before the move, a capture included', () => {
    // Blue 20 (track 7) with a 3 lands on red's single at track 10 (red 49), a plain square: a capture.
    let s = withTokens(createGame(SEATS, 'blue'), { blue: [20, -1, -1, -1], red: [49, -1, -1, -1] });
    s = rollAt(1, s, 3);
    const cap = s.moves.find((m) => m.captures.length)!;
    expect(cap).toBeDefined();
    const book = new UndoBook<{ kills: number }>(2, [0]);
    book.push({ ...frame(s), counters: { kills: 4 } });
    const after = move(s, cap);
    expect(after.players.find((p) => p.color === 'red')!.tokens[0]).toBe(-1);
    const f = book.undo(0)!;
    expect(f.state).toBe(s); // the very state: immutable, so nothing to copy
    expect(f.state.players.find((p) => p.color === 'red')!.tokens[0]).toBe(49);
    expect(f.counters).toEqual({ kills: 4 });
    expect(book.left(0)).toBe(1);
  });

  it('is not offered after any roll: new dice end it', () => {
    const book = new UndoBook(2, [0]);
    book.push(frame(createGame(SEATS, 'blue')));
    expect(book.canUndo(0)).toBe(true);
    book.clear(); // the game screen clears on every roll: the extra roll, or the next player's
    expect(book.canUndo(0)).toBe(false);
    expect(book.undo(0)).toBeNull();
    expect(book.left(0)).toBe(2); // nothing was spent
  });

  it('counts per person; bots never undo; 0 turns it off; used counts survive a save', () => {
    const s = createGame(SEATS, 'blue');
    const book = new UndoBook(1, [0, 2]);
    book.push(frame(s, 1)); // a bot's move is never kept
    expect(book.canUndo(1)).toBe(false);
    book.push(frame(s, 0));
    expect(book.undo(0)).not.toBeNull();
    expect(book.left(0)).toBe(0);
    expect(book.left(2)).toBe(1);
    book.push(frame(s, 0));
    expect(book.canUndo(0)).toBe(false); // none left
    expect(book.usedCounts()).toEqual({ 0: 1 });
    expect(new UndoBook(2, [0], { 0: 2 }).left(0)).toBe(0);
    expect(new UndoBook(0, [0]).left(0)).toBe(0);
  });

  it('several undos in one turn step back move by move; a move with nothing to choose goes with the one before', () => {
    const s = createGame(SEATS, 'blue');
    const a = { ...s, turnCount: 1 }, b = { ...s, turnCount: 2 }, c = { ...s, turnCount: 3 };
    const book = new UndoBook(2, [0]);
    book.push(frame(a));
    book.push(frame(b));
    book.push(frame(c, 0, false)); // an automatic follow-up move
    expect(book.undo(0)!.state).toBe(b);
    expect(book.undo(0)!.state).toBe(a);
    expect(book.left(0)).toBe(0);
  });

  it("another person's move ends what was kept", () => {
    const s = createGame(SEATS, 'blue');
    const book = new UndoBook(2, [0, 1]);
    book.push(frame(s, 0));
    book.push(frame(s, 1));
    expect(book.canUndo(0)).toBe(false);
    expect(book.canUndo(1)).toBe(true);
  });
});

describe('the turn-ends window', () => {
  it('opens when the move hands the turn on, ends the game or finishes the person; not within their own turn', () => {
    let s = withTokens(createGame(SEATS, 'blue'), { blue: [10, 20, -1, -1] });
    s = rollAt(3, s, 4);
    const m = s.moves[0]!;
    const after = move(s, m);
    expect(after.players[after.current]!.color).toBe('red'); // a 4 alone: the turn passes
    expect(windowAfter(s, after, 0, true)).toBe(true);
    expect(windowAfter(s, after, 0, false)).toBe(false); // nothing left to undo: no window, no wait
    // Still their turn (an extra roll or dice left): no window.
    expect(windowAfter(s, { ...after, current: s.current }, 0, true)).toBe(false);
    expect(windowAfter(s, { ...after, phase: 'over' }, 0, true)).toBe(true);
  });
});

describe('fairness', () => {
  it('undo and the same move again: the same next dice', () => {
    let s = withTokens(createGame(SEATS, 'blue'), { blue: [10, 20, -1, -1] });
    s = rollAt(7, s, 4);
    const m = s.moves[0]!;
    const first = rollAt(7, move(s, m)).dice;
    // Undo (back to s), the same move: the position is the same, so the dice are the same.
    const again = rollAt(7, move(s, m)).dice;
    expect(again).toBe(first);
    // A different move is a different position: its dice come from another stream (fair: none were seen).
    expect(positionKey(move(s, s.moves[1]!))).not.toBe(positionKey(move(s, m)));
  });

  it('the record keeps only the moves that stood: a whole game with undos replays exactly, its dice checked', () => {
    // A real game from the start: every few person moves are taken back once and replaced by another.
    const seed = 21;
    let s = createGame(SEATS, 'blue');
    let log = '';
    let undos = 0;
    for (let n = 0; s.phase !== 'over' && n < 4000; n++) {
      if (s.phase === 'roll') {
        s = rollAt(seed, s);
        log += rollEvent(s.dice!);
        continue;
      }
      const person = s.players[s.current]!.owner === 0;
      if (person && s.moves.length > 1 && n % 7 === 0) {
        const before = s, len = log.length;
        log += moveEvent(s.moves[0]!);
        s = move(s, s.moves[0]!);
        s = before; // undo
        log = log.slice(0, len);
        undos++;
        const m = s.moves.at(-1)!;
        log += moveEvent(m);
        s = move(s, m);
        continue;
      }
      const m = s.moves[0]!;
      log += moveEvent(m);
      s = move(s, m);
    }
    expect(undos).toBeGreaterThan(3);
    const r = replay({ v: 1, seats: SEATS, first: 'blue', seed, events: log }, { checkDice: true });
    expect(r.ok).toBe(true);
    expect(r.states.at(-1)!.phase).toBe('over');
  });
});
