// The review's "why" line (#97): rules-only facts, one test per reason, on crafted positions.
import { describe, expect, it } from 'vitest';
import { legalMoves, trayMoves, type Color, type Move, type PlayerState } from '../src/engine';
import { DANGER_SHOWN, dangerAt, whyFacts, whyLine } from '../src/ui/reviewWhy';
import move87 from '../tools/ai/positions/move87.json';

/** Players from tokens per colour; `owners` puts colours on one side (2h). */
function board(tokens: Partial<Record<Color, number[]>>, owners: Partial<Record<Color, number>> = {}): PlayerState[] {
  return (Object.keys(tokens) as Color[]).map((c, i) => ({ color: c, owner: owners[c] ?? i, bot: i > 0, tokens: tokens[c]! }));
}
/** The legal move of `color`'s token `token` by `roll`. */
function mv(players: PlayerState[], color: Color, token: number, roll: number, singles = false): Move {
  const m = legalMoves(players, color, roll, singles).find((x) => x.tokens.length === 1 && x.tokens[0] === token);
  if (!m) throw new Error(`no move for ${color} ${token} by ${roll}`);
  return m;
}
const THREE = (1 / 6) * (1 + 1 / 6 + 1 / 36); // a tray holding a 3
const SIX = 5 / 36 + 5 / 216; // a 6 then a non-6 (or two 6s then a non-6)

describe('danger (fair dice, the chance of being hit before your next turn)', () => {
  it('a single 3 squares behind: a tray holding a 3', () => {
    // Green on 10 (track 10), yellow's single on track 7 (yellow 33).
    const p = board({ green: [10, -1, -1, -1], yellow: [33, -1, -1, -1] });
    const d = dangerAt(p, 'green', 10);
    expect(d.p).toBeCloseTo(THREE, 9);
    expect(d.by).toEqual([{ color: 'yellow', pair: false }]);
  });
  it('a 6 away: only with a die after it', () => {
    const p = board({ green: [10, -1, -1, -1], yellow: [30, -1, -1, -1] }); // yellow 30 = track 4
    expect(dangerAt(p, 'green', 10).p).toBeCloseTo(SIX, 9);
  });
  it('two colours: 1 - (1 - a)(1 - b); in 4p only the colours that can reach it count', () => {
    // 4p: yellow 3 behind (track 7), red 1 behind (red 48 = track 9), blue all at home.
    const p = board({ blue: [-1, -1, -1, -1], green: [10, -1, -1, -1], red: [48, -1, -1, -1], yellow: [33, -1, -1, -1] });
    const d = dangerAt(p, 'green', 10);
    expect(d.p).toBeCloseTo(1 - (1 - THREE) * (1 - THREE), 9); // a tray holding a 1 is as likely as one holding a 3
    expect(d.by.map((x) => x.color).sort()).toEqual(['red', 'yellow']);
  });
  it('never counts a partner (2h): the same side never captures', () => {
    const p = board({ green: [10, -1, -1, -1], yellow: [33, -1, -1, -1] }, { green: 0, yellow: 0 });
    expect(dangerAt(p, 'green', 10).p).toBe(0);
  });
  it('nothing on a star, in the home column or in base', () => {
    const p = board({ green: [13, 52, -1, -1], yellow: [37, -1, -1, -1] }); // green 13: a star, yellow 3 behind
    expect(dangerAt(p, 'green', 13).p).toBe(0);
    expect(dangerAt(p, 'green', 52).p).toBe(0);
    expect(dangerAt(p, 'green', -1).p).toBe(0);
  });
});

describe('why facts', () => {
  it('move 87 (the 2.5.0 demo): past the yellow pair before it moves on, and yours left a star into the yellow single\'s reach', () => {
    const p = move87.seats.map((s) => ({ ...s, tokens: (move87.tokens as Record<string, number[]>)[s.color]! })) as PlayerState[];
    const moves = trayMoves(p, 'green', move87.tray);
    const played = moves.find((m) => m.tokens[0] === move87.played.token && m.from === move87.played.from)!;
    const better = moves.find((m) => m.tokens[0] === move87.best.token && m.from === move87.best.from)!;
    const facts = whyFacts(p, played, better);
    expect(facts[0]).toEqual({ kind: 'past-pair', color: 'yellow' });
    expect(facts[1]).toMatchObject({ kind: 'walked-in', fromSafe: true, danger: { by: [{ color: 'yellow', pair: false }] } });
    expect((facts[1] as { danger: { p: number } }).danger.p).toBeCloseTo(THREE, 9);
    expect(whyLine(facts, 'your')).toBe('Why: it gets past the yellow pair before the pair moves on, and your token left a safe star, into reach of the yellow single (about 20% chance to be hit next turn).');
    expect(whyLine(facts, 'your', true)).toBe('Why: it gets past the yellow pair before the pair moves on.');
    // The token sitting on the pair was not in danger (no yellow single can reach it): no "escape" claimed.
    expect(dangerAt(p, 'green', 43).p).toBe(0);
  });

  it('escape: the better move takes a threatened token to a star; the move played leaves it', () => {
    const p = board({ green: [10, 29, -1, -1], yellow: [33, -1, -1, -1] }); // yellow 3 behind green 10
    const facts = whyFacts(p, mv(p, 'green', 1, 3), mv(p, 'green', 0, 3)); // 10 -> 13, a star
    expect(facts[0]).toEqual({ kind: 'escape', p: expect.closeTo(THREE, 9) });
    expect(whyLine(facts, 'your')).toBe('Why: it takes that token out of danger (it had about 20% chance to be hit next turn).');
  });

  it("past-pair only from on top of the pair: a single behind one can't pass it at all (rule 24)", () => {
    // Green 10 with a yellow pair on track 12: a 4 would pass it, so it isn't a legal move; a 2 lands on it.
    const p = board({ green: [10, 29, -1, -1], yellow: [38, 38, -1, -1] });
    expect(legalMoves(p, 'green', 4).some((m) => m.tokens[0] === 0)).toBe(false);
    expect(whyFacts(p, mv(p, 'green', 1, 2), mv(p, 'green', 0, 2)).some((f) => f.kind === 'past-pair')).toBe(false);
    // Sitting on it (green 12, the pair's square), moving on is the reason.
    const q = board({ green: [12, 29, -1, -1], yellow: [38, 38, -1, -1] });
    expect(whyFacts(q, mv(q, 'green', 1, 2), mv(q, 'green', 0, 2))[0]).toEqual({ kind: 'past-pair', color: 'yellow' });
  });

  it('pair: the better move makes a pair on a normal square', () => {
    const p = board({ green: [10, 14, 29, -1], yellow: [-1, -1, -1, -1] });
    const facts = whyFacts(p, mv(p, 'green', 2, 4), mv(p, 'green', 0, 4)); // 10 -> 14 onto its own single
    expect(facts).toEqual([{ kind: 'pair' }]);
    expect(whyLine(facts, 'your')).toBe('Why: it makes a pair, safe from single tokens.');
  });

  it('safe: a star, or the home column', () => {
    const p = board({ green: [10, 29, 48, -1], yellow: [-1, -1, -1, -1] });
    expect(whyFacts(p, mv(p, 'green', 1, 3), mv(p, 'green', 0, 3))).toEqual([{ kind: 'safe', where: 'star' }]); // 10 -> 13
    const facts = whyFacts(p, mv(p, 'green', 1, 4), mv(p, 'green', 2, 4)); // 48 -> 52, the home column
    expect(facts).toEqual([{ kind: 'safe', where: 'home column' }]);
    expect(whyLine(facts, 'your')).toBe("Why: it reaches the home column, where it can't be captured.");
  });

  it('walked-in from a plain square, with a name', () => {
    // Played: 20 -> 23 (track 23), yellow's single on the star at track 21 (yellow 47), 2 behind 23 but ahead of 20.
    // Better: 10 -> 13, a star.
    const p = board({ green: [10, 20, -1, -1], yellow: [47, -1, -1, -1] });
    const facts = whyFacts(p, mv(p, 'green', 1, 3), mv(p, 'green', 0, 3));
    expect(facts.at(-1)).toMatchObject({ kind: 'walked-in', fromSafe: false });
    expect(whyLine(facts, "Aarav's")).toMatch(/Aarav's token is now in reach of the yellow single \(about \d+% chance to be hit next turn\)\.$/);
  });

  it('walked-in by a pair says "your pair" (an enemy pair can capture it)', () => {
    // Green pair on the star at 13 moves 2 (1 + 1) to 14; yellow's pair on track 12 (yellow 38) is 2 behind:
    // with a 4 it moves 2 + 2 onto 14 and captures both. Better: the single on 29 moves 2.
    const p = board({ green: [13, 13, 29, -1], yellow: [38, 38, -1, -1] });
    const pairMove = legalMoves(p, 'green', 2).find((m) => m.kind === 'pair')!;
    const facts = whyFacts(p, pairMove, mv(p, 'green', 2, 2));
    expect(facts.at(-1)).toMatchObject({ kind: 'walked-in', fromSafe: true, pair: true, danger: { by: [{ color: 'yellow', pair: true }] } });
    expect(whyLine(facts, 'your')).toMatch(/your pair left a safe star, into reach of the yellow pair/);
  });

  it('no fact: no line, nothing invented', () => {
    const p = board({ green: [10, 29, -1, -1], yellow: [-1, -1, -1, -1] });
    const facts = whyFacts(p, mv(p, 'green', 1, 1), mv(p, 'green', 0, 1)); // 10 -> 11 vs 29 -> 30, nothing at stake
    expect(facts).toEqual([]);
    expect(whyLine(facts, 'your')).toBeNull();
  });

  it('a danger under DANGER_SHOWN is never a reason', () => {
    // Yellow 6 away from 23 needs a 6 and another die: about 16%, over the bar; 7+ away: no danger at all.
    const p = board({ green: [10, 20, -1, -1], yellow: [41, -1, -1, -1] }); // yellow 41 = track 15, 8 behind 23
    const facts = whyFacts(p, mv(p, 'green', 1, 3), mv(p, 'green', 0, 1));
    expect(facts.some((f) => f.kind === 'walked-in')).toBe(false);
    expect(DANGER_SHOWN).toBe(0.1);
  });

  it('singles (doubles off): no pair facts', () => {
    const p = board({ green: [10, 14, 29, -1], yellow: [38, 38, -1, -1] });
    expect(whyFacts(p, mv(p, 'green', 2, 4, true), mv(p, 'green', 0, 4, true), true)).toEqual([]);
  });

  it('2h: a partner\'s pair never blocks, so getting past it is no reason', () => {
    const p = board({ green: [10, 29, -1, -1], yellow: [38, 38, -1, -1] }, { green: 0, yellow: 0 });
    expect(whyFacts(p, mv(p, 'green', 1, 4), mv(p, 'green', 0, 4))).toEqual([]);
  });
});
