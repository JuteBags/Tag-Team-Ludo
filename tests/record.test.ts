// The game record (src/engine/record.ts): a recorded game replays exactly, every move's code is unique in its
// position, the share string round-trips, and damaged or hostile input is turned away cleanly.
import { describe, expect, it } from 'vitest';
import { STOP_EVENT, chooseMove, createGame, ownerRanking, decodeRecord, encodeRecord, move, MAX_LINK, moveEvent, replay, roll, rollEvent, seededDie, seeded, type Color, type GameRecord, type GameState, type Seat } from '../src/engine';

const LAYOUTS: Record<string, Seat[]> = {
  '2p': [{ color: 'blue', owner: 0, bot: true }, { color: 'red', owner: 1, bot: true }],
  '3p': [{ color: 'blue', owner: 0, bot: true }, { color: 'green', owner: 1, bot: true }, { color: 'red', owner: 2, bot: true }],
  '4p': (['blue', 'green', 'red', 'yellow'] as Color[]).map((color, owner) => ({ color, owner, bot: true })),
  '2h-opposite': (['blue', 'green', 'red', 'yellow'] as Color[]).map((color, i) => ({ color, owner: i % 2, bot: true })),
  '2h-side': (['blue', 'green', 'red', 'yellow'] as Color[]).map((color, i) => ({ color, owner: i < 2 ? 0 : 1, bot: true })),
};

/** Plays a bot game the way the app does (dice from the game's seed and the position), recording it. */
function play(seats: Seat[], seed: number, singles = false): { rec: GameRecord; states: GameState[] } {
  const rng = seeded(seed * 7 + 1);
  // The quick Easy bot: the record doesn't care how moves are chosen.
  let s = createGame(seats, seats[0]!.color, singles);
  const states = [s];
  let events = '';
  for (let n = 0; s.phase !== 'over' && n < 5000; n++) {
    if (s.phase === 'roll') {
      const face = seededDie(seed, s);
      events += rollEvent(face);
      s = roll(s, () => 0, face);
    } else {
      // Every legal move has its own code, or the record would be ambiguous.
      expect(new Set(s.moves.map(moveEvent)).size).toBe(s.moves.length);
      const m = chooseMove(s, rng, 'easy');
      events += moveEvent(m);
      s = move(s, m);
    }
    states.push(s);
  }
  return { rec: { v: 1, seats, first: seats[0]!.color, singles, seed, events }, states };
}

describe('game record', () => {
  it('replays every recorded game exactly, in every layout, with and without doubles', () => {
    let games = 0;
    for (const [name, seats] of Object.entries(LAYOUTS))
      for (const singles of [false, true])
        for (let seed = 1; seed <= 8; seed++) {
          const { rec, states } = play(seats, seed + name.length * 1000, singles);
          expect(states.at(-1)!.phase).toBe('over');
          const r = replay(rec, { checkDice: true });
          expect(r.ok).toBe(true);
          expect(r.states.length).toBe(states.length);
          expect(JSON.stringify(r.states.at(-1))).toBe(JSON.stringify(states.at(-1)));
          games++;
        }
    expect(games).toBe(80);
  }, 120_000);

  it('round-trips through the share string, and the string is short', async () => {
    const { rec } = play(LAYOUTS['4p']!, 42);
    const s = await encodeRecord({ ...rec, meta: { mode: 'pvc', names: ['You', 'Aarav', 'Meera', 'Kabir'] } });
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBeLessThan(2500);
    expect(await decodeRecord(s)).toEqual({ ...rec, meta: { mode: 'pvc', names: ['You', 'Aarav', 'Meera', 'Kabir'] } });
  });

  it('says why a record does not replay, keeping what it could', () => {
    const { rec } = play(LAYOUTS['2p']!, 3);
    const old = replay({ ...rec, v: 2 } as unknown as GameRecord);
    expect(old.ok).toBe(false);
    expect(!old.ok && old.error).toMatch(/different version/);
    // A changed die: with checkDice the seed catches it at once; without, play goes on until something doesn't fit.
    const firstDie = rec.events[0] === '6' ? '5' : '6';
    expect(replay({ ...rec, events: firstDie + rec.events.slice(1) }, { checkDice: true })).toMatchObject({ ok: false, states: [expect.anything()] });
    const cut = replay({ ...rec, events: rec.events.slice(0, 40) + 'zz' + rec.events.slice(40) });
    expect(cut.ok).toBe(false);
    expect(cut.states.length).toBeGreaterThan(1);
  });

  it('ends a game stopped by vote with the places as they stood', () => {
    const { rec, states } = play(LAYOUTS['4p']!, 9);
    // Cut the game after event k, at a roll phase, as the vote would.
    let k = 0;
    const seen = replay(rec);
    for (let n = 0, i = 0; i < rec.events.length; n++) {
      i += seen.ok && seen.states[n]!.phase === 'move' ? 2 : 1;
      if (n > 150 && seen.ok && seen.states[n + 1]!.phase === 'roll') {
        k = i;
        break;
      }
    }
    const stopped = replay({ ...rec, events: rec.events.slice(0, k) + STOP_EVENT });
    expect(stopped).toMatchObject({ ok: true, stopped: true });
    const last = stopped.states.at(-1)!;
    expect(states.map((x) => JSON.stringify(x))).toContain(JSON.stringify(last));
    expect(ownerRanking(last)).toEqual(ownerRanking(states[stopped.states.length - 1]!));
    // Only as the last event, and only between turns.
    expect(replay({ ...rec, events: rec.events.slice(0, k) + STOP_EVENT + '3' }).ok).toBe(false);
    expect(replay({ ...rec, events: rec.events + STOP_EVENT }).ok).toBe(false);
  });

  it('turns away damaged and hostile share strings', async () => {
    expect(await decodeRecord('not base64!')).toBeNull();
    expect(await decodeRecord('A'.repeat(MAX_LINK + 1))).toBeNull();
    expect(await decodeRecord('AAAA')).toBeNull();
    // A tiny string that inflates to megabytes (a zip bomb) stops at the cap.
    const bomb = await encodeRecord({ v: 1, seats: [], first: 'blue', events: '1'.repeat(3_000_000) } as GameRecord);
    expect(bomb.length).toBeLessThan(MAX_LINK);
    expect(await decodeRecord(bomb)).toBeNull();
    // Valid JSON that isn't a record.
    const notRec = await encodeRecord({ hello: 'world' } as unknown as GameRecord);
    expect(await decodeRecord(notRec)).toBeNull();
  });
});
