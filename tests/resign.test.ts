// A side resigning (online: its person left the game; game.ts resign, RULES.md section K).
import { describe, expect, it } from 'vitest';
import { BASE, FINISHED, RESIGN, applyEvent, createGame, eventLength, finalRanking, isDone, move, moveEvent, ownerRanking, replay, resign, resignEvent, roll, rollEvent, seeded, type GameState, type Seat } from '../src/engine';

const seats = (n: number): Seat[] => (['blue', 'green', 'red', 'yellow'] as const).slice(0, n).map((color, owner) => ({ color, owner, bot: false }));
const two: Seat[] = [{ color: 'blue', owner: 0, bot: false }, { color: 'red', owner: 1, bot: false }];

/** Plays `steps` random rolls and moves. */
function play(s: GameState, rng: () => number, steps: number, log: string[] = []): GameState {
  for (let i = 0; i < steps && s.phase !== 'over'; i++) {
    if (s.phase === 'roll') {
      s = roll(s, rng);
      log.push(rollEvent(s.dice!));
    } else {
      const m = s.moves[Math.floor(rng() * s.moves.length)]!;
      log.push(moveEvent(m));
      s = move(s, m);
    }
  }
  return s;
}

describe('resign', () => {
  it('1v1: the other side wins at once, even when the leaver was ahead', () => {
    let s = createGame(two, 'blue');
    s = { ...s, players: s.players.map((p) => (p.owner === 0 ? { ...p, tokens: [FINISHED, FINISHED, FINISHED, 40] } : p)) };
    const r = resign(s, 0);
    expect(r.phase).toBe('over');
    expect(r.event).toEqual({ type: 'resigned', owner: 0, over: true });
    expect(ownerRanking(r)).toEqual([1, 0]);
    expect(finalRanking(r)).toEqual(['red', 'blue']);
    // Its tokens not yet home leave the board.
    expect(r.players[0]!.tokens).toEqual([FINISHED, FINISHED, FINISHED, BASE]);
  });

  it('1v1v1v1: the game goes on without the side, which takes no more turns and ranks last', () => {
    const rng = seeded(4);
    let s = play(createGame(seats(4), 'blue'), rng, 60);
    s = resign(s, 2);
    expect(s.phase).not.toBe('over');
    expect(s.players[2]!.tokens.every((t) => t === BASE || t === FINISHED)).toBe(true);
    for (let i = 0; i < 3000 && s.phase !== 'over'; i++) {
      expect(s.players[s.current]!.owner).not.toBe(2);
      s = play(s, rng, 1);
    }
    expect(s.phase).toBe('over');
    expect(ownerRanking(s).at(-1)).toBe(2);
  });

  it('on its own turn: the turn passes, with its tray', () => {
    let s = createGame(seats(3), 'green');
    s = roll(s, () => 0, 6);
    expect(s.rolls).toEqual([6]);
    const r = resign(s, 1);
    expect(r.players[r.current]!.color).toBe('red');
    expect(r.phase).toBe('roll');
    expect(r.rolls).toEqual([]);
  });

  it('two sides leaving: the last to leave ranks above the first', () => {
    let s = createGame(seats(4), 'blue');
    s = resign(s, 1);
    s = resign(s, 3);
    expect(s.phase).not.toBe('over');
    s = resign(s, 0);
    expect(s.phase).toBe('over');
    expect(ownerRanking(s)).toEqual([2, 0, 3, 1]);
  });

  it('a two-house side resigns as one (2v2: the team forfeits)', () => {
    const team: Seat[] = [
      { color: 'blue', owner: 0, bot: false },
      { color: 'green', owner: 1, bot: false },
      { color: 'red', owner: 0, bot: false },
      { color: 'yellow', owner: 1, bot: false },
    ];
    const r = resign(createGame(team, 'blue'), 1);
    expect(r.phase).toBe('over');
    expect(ownerRanking(r)).toEqual([0, 1]);
  });

  it('can not resign twice, or after the end', () => {
    const s = resign(createGame(seats(3), 'blue'), 1);
    expect(() => resign(s, 1)).toThrow();
    expect(() => resign(resign(s, 2), 0)).toThrow();
  });

  it('records: a resign replays, in either phase, and its length is 2', () => {
    const rng = seeded(9);
    const log: string[] = [];
    let s = play(createGame(seats(4), 'blue'), rng, 41, log);
    log.push(resignEvent(1));
    s = resign(s, 1);
    s = play(s, rng, 30, log);
    const events = log.join('');
    const r = replay({ v: 1, seats: seats(4), first: 'blue', events });
    expect(r.ok).toBe(true);
    expect(r.states.at(-1)).toEqual(s);
    expect(applyEvent(createGame(seats(2), 'blue'), 'q0').phase).toBe('over');
    expect(eventLength('q1', 0, createGame(seats(2), 'blue'))).toBe(2);
    expect(RESIGN).toBe('q');
  });

  it('random games with random resigns always end, with legal states', () => {
    for (let g = 0; g < 300; g++) {
      const rng = seeded(1000 + g);
      const n = 2 + (g % 3);
      let s = createGame(seats(n), 'blue');
      for (let i = 0; i < 20000 && s.phase !== 'over'; i++) {
        if (rng() < 0.002) {
          const live = [...new Set(s.players.filter((p) => !isDone(p) && !s.out?.includes(p.owner)).map((p) => p.owner))];
          s = resign(s, live[Math.floor(rng() * live.length)]!);
          continue;
        }
        s = play(s, rng, 1);
      }
      expect(s.phase).toBe('over');
      expect(new Set(ownerRanking(s)).size).toBe(n);
      for (const o of s.out ?? []) expect(ownerRanking(s).indexOf(o)).toBeGreaterThanOrEqual(n - s.out!.length);
    }
  });
});
