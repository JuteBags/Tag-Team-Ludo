// The replay's frames and the share link (src/ui/replay.ts): one frame per move, safe names from links, and
// people's names left out of what's shared.
import { describe, expect, it } from 'vitest';
import { chooseMove, createGame, decodeRecord, move, moveEvent, replay, roll, rollEvent, seeded, seededDie, type GameRecord, type Seat } from '../src/engine';
import { forSharing, framesOf, linkPayload, namesOf, shareLink } from '../src/ui/replay';

const SEATS: Seat[] = [
  { color: 'blue', owner: 0, bot: false },
  { color: 'green', owner: 1, bot: true, level: 'hard' },
  { color: 'red', owner: 2, bot: true, level: 'hard' },
];

function played(seed: number, names: string[], mode = 'pvc'): GameRecord {
  const rng = seeded(seed);
  let s = createGame(SEATS, 'blue');
  let events = '';
  let moves = 0;
  while (s.phase !== 'over') {
    if (s.phase === 'roll') {
      const f = seededDie(seed, s);
      events += rollEvent(f);
      s = roll(s, () => 0, f);
    } else {
      const m = chooseMove(s, rng, 'easy');
      events += moveEvent(m);
      s = move(s, m);
      moves++;
    }
  }
  expect(moves).toBeGreaterThan(20);
  return { v: 1, seats: SEATS, first: 'blue', seed, meta: { mode, names }, events };
}

describe('replay frames', () => {
  it('has the start, one frame per move or stuck turn, and the winner', () => {
    const rec = played(5, ['You', 'Aarav', 'Meera']);
    const { frames, error, stopped } = framesOf(rec);
    expect(error).toBeUndefined();
    expect(stopped).toBe(false);
    expect(frames[0]!.caption).toBe('You play first');
    expect(frames.at(-1)!.caption).toMatch(/ wins?$/);
    expect(frames.filter((f) => f.move).length).toBe(replay(rec).states.filter((x) => x.event?.type === 'moved').length);
    // Every move frame says who moved, and shows the dice it was played from.
    for (const f of frames.filter((x) => x.move)) {
      expect(f.caption).toMatch(/^(You|Aarav|Meera) /);
      expect(f.dice).toContain(f.move!.roll);
    }
  });

  it('shows how far a damaged record got, and why it stopped', () => {
    const rec = played(6, ['You', 'Aarav', 'Meera']);
    const { frames, error } = framesOf({ ...rec, events: rec.events.slice(0, 60) + 'j6' });
    expect(error).toBeTruthy();
    expect(frames.length).toBeGreaterThan(3);
  });
});

describe('names in a replay', () => {
  it('cleans names that came from a link and falls back to the colour', () => {
    const rec = played(7, ['<img src=x onerror=alert(1)>', '', 'A very long name indeed']);
    expect(namesOf(rec)).toEqual(['img src=x on', 'Green', 'A very long']);
    expect(namesOf({ ...rec, meta: { names: [42, null] } })).toEqual(['Blue', 'Green', 'Red']);
  });

  it("leaves people's names out of a shared game, keeping the bots'", async () => {
    const rec = played(8, ['Shaurya', 'Aarav', 'Meera']);
    expect(namesOf(forSharing(rec))).toEqual(['Blue', 'Aarav', 'Meera']);
    const two = forSharing({ ...rec, seats: [{ color: 'blue', owner: 0, bot: false }, { color: 'red', owner: 0, bot: false }, { color: 'green', owner: 1, bot: true }] });
    expect(two.meta!.names).toEqual(['Blue & Red', 'Aarav']);
    const url = await shareLink(rec, 'https://example.test/');
    expect(url.startsWith('https://example.test/play/#game=')).toBe(true);
    const back = await decodeRecord(linkPayload(new URL(url).hash)!);
    expect(back?.meta?.names).toEqual(['Blue', 'Aarav', 'Meera']);
    expect(back?.events).toBe(rec.events);
  });

  it('reads only #game= fragments', () => {
    expect(linkPayload('#game=abc')).toBe('abc');
    expect(linkPayload('#other')).toBeNull();
    expect(linkPayload('')).toBeNull();
  });
});
