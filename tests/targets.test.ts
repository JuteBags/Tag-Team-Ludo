import { describe, expect, it } from 'vitest';
import { legalMoves } from '../src/engine';
import { TIPS, TURNS, centerOf, spot } from '../src/ui/geometry';
import { moveTargets, nearest, whyStuck } from '../src/ui/targets';
import { B, mk, prog } from './helpers';

describe('track turns', () => {
  it('finds the four diagonal corner jumps between arms', () => {
    expect(TURNS).toHaveLength(4);
    for (const { from, to } of TURNS) {
      expect(Math.abs(from[0] - to[0])).toBe(1);
      expect(Math.abs(from[1] - to[1])).toBe(1);
    }
    expect(TURNS[0]).toEqual({ from: [5, 6], to: [6, 5] });
  });

  it('finds the U-turn at the outer tip of each arm', () => {
    expect(TIPS.map((t) => t.mid)).toEqual([[7, 0], [14, 7], [7, 14], [0, 7]]);
    expect(TIPS[0]).toEqual({ from: [6, 0], mid: [7, 0], to: [8, 0] });
  });
});

describe('move targets', () => {
  it('gives every legal move a landing spot and the pawns that trigger it', () => {
    const ps = mk({ blue: [3, 4, -1, -1], red: B });
    const t = moveTargets(ps, legalMoves(ps, 'blue', 6));
    expect(t.map((x) => x.label).sort()).toEqual(['+6', '+6', 'Out']);
    const out = t.find((x) => x.label === 'Out')!;
    expect(out.pawns).toEqual(['blue2', 'blue3']);
    expect(out.dest).toEqual(spot('blue', 0, 0).pt);
    expect(t.find((x) => x.move.from === 3)!.dest).toEqual(spot('blue', 9, 0).pt);
  });

  it('offers a pair and a single move from a star as two landing spots', () => {
    const ps = mk({ blue: [8, 8, -1, -1], red: B });
    const t = moveTargets(ps, legalMoves(ps, 'blue', 4));
    expect(t.map((x) => [x.label, x.pawns]).sort()).toEqual([['One +4', ['blue0', 'blue1']], ['Pair +2 +2', ['blue0', 'blue1']]]);
    expect(t[0]!.dest).not.toEqual(t[1]!.dest);
  });

  it('tags kills, safe stars and the home lane', () => {
    const kill = mk({ blue: [5, -1, -1, -1], red: [prog('red', 46), -1, -1, -1] });
    expect(moveTargets(kill, legalMoves(kill, 'blue', 2))[0]!.tag).toBe('kill');
    const safe = mk({ blue: [3, -1, -1, -1], red: B });
    expect(moveTargets(safe, legalMoves(safe, 'blue', 5))[0]!.tag).toBe('safe');
    const home = mk({ blue: [49, -1, -1, -1], red: B });
    expect(moveTargets(home, legalMoves(home, 'blue', 3))[0]!.tag).toBe('home');
    const done = mk({ blue: [53, -1, -1, -1], red: B });
    expect(moveTargets(done, legalMoves(done, 'blue', 3))[0]!.tag).toBe('finish');
  });

  it('spreads targets that would land on the same spot', () => {
    // Pair from 10 by 2 and the single from 8 by 4 both reach 12.
    const ps = mk({ blue: [8, 8, 8, -1], red: B });
    const t = moveTargets(ps, legalMoves(ps, 'blue', 4));
    const dests = t.map((x) => x.dest.join(','));
    expect(new Set(dests).size).toBe(dests.length);
  });
});

describe('why a token cannot move', () => {
  it('needs a 6 to leave base', () => {
    expect(whyStuck(mk({ blue: [-1, -1, -1, -1], red: B }), 'blue', 0, 4)).toBe('Needs a 6 to come out');
  });
  it('explains a locked double on an odd roll', () => {
    expect(whyStuck(mk({ blue: [10, 10, -1, -1], red: B }), 'blue', 0, 3)).toBe('Locked double: needs an even roll');
  });
  it('names the enemy double in the way', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: [prog('red', 47), 56, 56, 56] });
    expect(whyStuck(ps, 'red', 0, 4)).toBe("Blocked by Blue's double");
  });
  it('needs the exact roll to finish', () => {
    expect(whyStuck(mk({ blue: [53, -1, -1, -1], red: B }), 'blue', 0, 5)).toBe('Needs exactly 3 to finish');
  });
  it('has nothing to say about a finished token', () => {
    expect(whyStuck(mk({ blue: [56, -1, -1, -1], red: B }), 'blue', 0, 5)).toBe('Already home');
  });
});

describe('nearest', () => {
  const items = [{ pt: centerOf([1, 6]) }, { pt: centerOf([3, 6]) }];
  it('picks the closest item within the radius', () => {
    expect(nearest(items, [70, 260], 30)).toBe(items[0]);
    expect(nearest(items, [135, 262], 30)).toBe(items[1]);
  });
  it('picks nothing outside the radius', () => {
    expect(nearest(items, [300, 300], 30)).toBeNull();
  });
});
