// The game notation (#164, docs/NOTATION.md): readable, small, stable, and it reads back (tools/notation.ts)
// into a record that replays the very same game.
import { describe, expect, it } from 'vitest';
import { createGame, move, roll, seeded, seededDie, type GameRecord, type GameState, type Seat } from '../src/engine';
import { chooseBotMove } from '../src/engine/ai/levels';
import { moveEvent, NOTATION_LEGEND, replay, rollEvent, squareName, STOP_EVENT, toNotation } from '../src/engine/record';
import { parseNotation } from '../tools/notation';
import golden from './fixtures/notation-2p.json';
import { boardDiagram } from './notationBoard';

const ALL = ['blue', 'green', 'red', 'yellow'] as const;
const LAYOUTS: Record<string, Seat[]> = {
  '2p': [{ color: 'blue', owner: 0, bot: false }, { color: 'red', owner: 1, bot: true, level: 'extreme' }],
  '3p': (['blue', 'green', 'red'] as const).map((color, owner) => ({ color, owner, bot: owner > 0, level: owner > 0 ? ('hard' as const) : undefined })),
  // Red's bot has no level (normal when missing): written as just (Bot).
  '4p': ALL.map((color, owner) => ({ color, owner, bot: owner > 0, ...(owner === 1 || owner === 3 ? { level: 'normal' as const } : {}) })),
  '2h-opposite': ALL.map((color) => ({ color, owner: color === 'blue' || color === 'red' ? 0 : 1, bot: color === 'green' || color === 'yellow', ...(color === 'green' || color === 'yellow' ? { level: 'hard' as const } : {}) })),
};

/** A game the app could have played: the app's dice from the seed, the bots' moves for every seat. */
function game(layout: string, seed: number, singles = false, stopAfter = Infinity): GameRecord {
  const seats = LAYOUTS[layout]!;
  const rng = seeded(seed * 31 + 7);
  const first = seats[seed % seats.length]!.color;
  let s: GameState = createGame(seats.map((x) => ({ ...x, level: x.level ?? 'normal' })), first, singles);
  let events = '';
  for (let k = 0; s.phase !== 'over' && k < 20000; k++) {
    if (k >= stopAfter) {
      events += STOP_EVENT;
      break;
    }
    if (s.phase === 'roll') {
      const f = seededDie(seed, s);
      events += rollEvent(f);
      s = roll(s, () => 0, f);
    } else {
      const m = chooseBotMove(s, rng);
      events += moveEvent(m);
      s = move(s, m);
    }
  }
  const owners = new Set(seats.map((x) => x.owner)).size;
  return { v: 1, seats, first, ...(singles ? { singles: true } : {}), seed, meta: { mode: 'pvc', names: ['Asha', 'Leo', 'Mira', 'Kabir'].slice(0, owners) }, events };
}

const INFO = (r: GameRecord) => ({ app: '3.5.0', date: '2026-11-04', names: (r.meta!.names as string[]) });
const bytes = (s: string) => new TextEncoder().encode(s).length;

const GAMES: [string, number, boolean, number][] = [
  ['2p', 42, false, Infinity],
  ['2p', 7, true, Infinity],
  ['3p', 5, false, Infinity],
  ['4p', 102, false, Infinity],
  ['4p', 13, true, Infinity],
  ['2h-opposite', 9, false, Infinity],
  ['4p', 21, false, 300],
];

describe('the game notation (#164)', () => {
  it('reads back into a record that replays the same game, and writes the same text again', () => {
    for (const [layout, seed, singles, stop] of GAMES) {
      const rec = game(layout, seed, singles, stop);
      const text = toNotation(rec, INFO(rec))!;
      expect(text, `${layout} ${seed}`).toBeTruthy();
      const back = parseNotation(text);
      if (!back.ok) expect.fail(`${layout} ${seed}: ${back.error}`);
      const a = replay(rec);
      const b = replay(back.record);
      expect(b.ok && b.stopped).toBe(a.ok && a.stopped);
      const d = b.states.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(a.states[i]));
      if (d >= 0) expect.fail(`${layout} ${seed} state ${d}: ${JSON.stringify(b.states[d]).slice(0, 400)} vs ${JSON.stringify(a.states[d]).slice(0, 400)}`);
      expect(b.states).toEqual(a.states);
      expect(back.record.events).toBe(rec.events);
      expect(toNotation(back.record, INFO(back.record))).toBe(text);
    }
  });

  it('shows every kind of event: pairs, captures, homes, bonus rolls, unused dice, cancelled 6s', () => {
    const all = GAMES.map(([l, s, d, x]) => toNotation(game(l, s, d, x), INFO(game(l, s, d, x)))!).join('\n');
    expect(all).toMatch(/ [a-dg-jm-ps-v]{2}\+[246] /); // a pair
    expect(all).toMatch(/ x[a-v]/); // a capture
    expect(all).toMatch(/\+\d #/); // a pawn home
    expect(all).toMatch(/ \| /); // a bonus roll
    expect(all).toMatch(/\[\d( \d)*\]/); // unused dice
    expect(all).toContain('6 6 6✕'); // three 6s
    expect(all).toMatch(/^; after 20: /m); // a position line
    expect(all).toContain('(stopped)');
    expect(all).toContain('[Sides "Asha: Blue, Red; Leo: Green, Yellow"]');
  });

  it('is small: a whole 4-player game well under 10 kB, a 2-player game a few kB', () => {
    for (const [layout, seed, singles] of GAMES.filter((g) => g[3] === Infinity)) {
      const n = bytes(toNotation(game(layout, seed, singles), INFO(game(layout, seed, singles)))!);
      expect(n, `${layout} ${seed}`).toBeLessThan(layout === '2p' ? 5000 : 10_000);
    }
  });

  it('is stable: the committed sample game gives exactly its committed text', () => {
    const rec = golden.record as GameRecord;
    expect(toNotation(rec, INFO(rec))).toBe(golden.notation.join('\n'));
    const back = parseNotation(golden.notation.join('\n'));
    expect(back.ok && back.record.events).toBe(rec.events);
  });

  it('puts the legend under the header and names squares board-wide', () => {
    const text = toNotation(game('2p', 42), INFO(game('2p', 42)))!;
    expect(text.split('\n')).toContain(NOTATION_LEGEND);
    expect([squareName('green', 0), squareName('blue', 0), squareName('blue', 13), squareName('red', 51), squareName('red', 56), squareName('yellow', -1)]).toEqual(['G1', 'B1', 'G1', 'RH1', '#', 'base']);
    expect(squareName('yellow', 50)).toBe('R12'); // Yellow's last track square, beside its home column YH1
  });

  it('reads chat-mangled text: collapsed spaces and 666X for 6 6 6✕', () => {
    const rec = game('2p', 42);
    const text = toNotation(rec, INFO(rec))!;
    expect(text).toContain('6 6 6✕');
    const mangled = text.replace(/6 6 6✕/g, '666X').replace(/ {2}/g, ' ');
    const back = parseNotation(mangled);
    expect(back.ok && back.record.events).toBe(rec.events);
  });

  it('refuses a hand-edited game whose square is wrong, or a move that is not legal', () => {
    const rec = game('2p', 42);
    const text = toNotation(rec, INFO(rec))!;
    const firstMove = /(\b[a-dm-p]\+\d) ([BGRY]\d+)/.exec(text)!;
    const wrong = text.replace(firstMove[0], `${firstMove[1]} ${firstMove[2] === 'B1' ? 'B2' : 'B1'}`);
    const r1 = parseNotation(wrong);
    expect(r1.ok).toBe(false);
    const lines = text.split('\n');
    const at = lines.findIndex((l) => /^\d+\. .*: [a-dm-p]\+\d/.test(l));
    const edit = (f: (l: string) => string) => lines.map((l, i) => (i === at ? f(l) : l)).join('\n');
    expect(parseNotation(edit((l) => l.replace(/: ([a-dm-p])\+/, ': z+'))).ok).toBe(false); // not a pawn
    expect(parseNotation(edit((l) => l.replace(/: ([a-dm-p])\+\d/, ': $1+6'))).ok).toBe(false); // not that die
  });
});

describe("docs/NOTATION.md's board (#164)", () => {
  it('is the board the app draws, with every square named as the notation names it', async () => {
    // @ts-expect-error: the project has no @types/node; Vitest runs on Node.
    const { readFileSync } = await import('node:fs');
    const doc: string = readFileSync(new URL('../docs/NOTATION.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(doc).toContain('```\n' + boardDiagram() + '\n```');
  });
});
