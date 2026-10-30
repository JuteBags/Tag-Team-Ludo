import { describe, expect, it } from 'vitest';
import { applyMove, isThreatened, legalMoves, squareOf } from '../src/engine';
import { B, mk, prog } from './helpers';

describe('board', () => {
  it('maps progress to absolute squares', () => {
    expect(squareOf('blue', 0)).toBe(39);
    expect(squareOf('blue', 13)).toBe(0);
    expect(squareOf('blue', 50)).toBe(37);
    expect(squareOf('green', 50)).toBe(50);
    expect(squareOf('red', 50)).toBe(11);
    expect(squareOf('yellow', 50)).toBe(24);
    expect(squareOf('blue', 51)).toBeNull();
    expect(squareOf('blue', -1)).toBeNull();
  });
});

describe('classic moves', () => {
  it('releases only on a 6', () => {
    const ps = mk({ blue: B, red: B });
    for (let r = 1; r <= 5; r++) expect(legalMoves(ps, 'blue', r)).toEqual([]);
    const m = legalMoves(ps, 'blue', 6);
    expect(m.map((x) => x.tokens[0])).toEqual([0, 1, 2, 3]);
    for (const x of m) expect(x).toMatchObject({ kind: 'release', from: -1, to: 0 });
  });

  it('captures a single enemy on a normal square', () => {
    const ps = mk({ blue: [5, -1, -1, -1], red: [prog('red', 46), -1, -1, -1] });
    const m = legalMoves(ps, 'blue', 2).find((x) => x.kind === 'single')!;
    expect(m.captures).toEqual([{ color: 'red', token: 0 }]);
    expect(applyMove(ps, m)[1]!.tokens[0]).toBe(-1);
  });

  it('never captures on a star', () => {
    const ps = mk({ blue: [3, -1, -1, -1], red: [prog('red', 47), -1, -1, -1] });
    const m = legalMoves(ps, 'blue', 5)[0]!;
    expect(squareOf('blue', m.to)).toBe(47);
    expect(m.captures).toEqual([]);
  });

  it('needs the exact roll to finish', () => {
    const ps = mk({ blue: [53, -1, -1, -1], red: B });
    expect(legalMoves(ps, 'blue', 3)[0]).toMatchObject({ to: 56, finishes: 1 });
    expect(legalMoves(ps, 'blue', 4)).toEqual([]);
  });
});

// Blue progress 8 is square 47 (a star), 10 is square 49 (a normal square).
describe('doubles', () => {
  it('lets a double on a star move together or one token alone on an even roll', () => {
    const four = legalMoves(mk({ blue: [8, 8, -1, -1], red: B }), 'blue', 4);
    expect(four.find((m) => m.kind === 'pair')).toMatchObject({ tokens: [0, 1], from: 8, to: 10, steps: 2 });
    expect(four.find((m) => m.kind === 'single')).toMatchObject({ from: 8, to: 12 });
  });

  it('locks a double on a normal square: no single moves, pair only on even rolls', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: B });
    expect(legalMoves(ps, 'blue', 3)).toEqual([]);
    expect(legalMoves(ps, 'blue', 4)).toEqual([expect.objectContaining({ kind: 'pair', from: 10, to: 12 })]);
  });

  it('makes a locked double when your single lands on your single', () => {
    const ps = mk({ blue: [10, 7, -1, -1], red: B });
    const after = applyMove(ps, legalMoves(ps, 'blue', 3).find((m) => m.from === 7)!);
    expect(after[0]!.tokens).toEqual([10, 10, -1, -1]);
    expect(legalMoves(after, 'blue', 3)).toEqual([]);
  });

  it('lets the third token on a double move alone', () => {
    const ps = mk({ blue: [10, 10, 10, -1], red: B });
    expect(legalMoves(ps, 'blue', 3)).toEqual([expect.objectContaining({ kind: 'single', from: 10, to: 13 })]);
    expect(legalMoves(ps, 'blue', 4).map((m) => m.kind).sort()).toEqual(['pair', 'single']);
    expect(legalMoves(mk({ blue: [10, 10, 10, 10], red: B }), 'blue', 3)).toEqual([]);
  });

  it('splits a double that enters the home column', () => {
    const into = legalMoves(mk({ blue: [48, 48, -1, -1], red: B }), 'blue', 6).find((m) => m.kind === 'pair')!;
    expect(into).toMatchObject({ from: 48, to: 51 });
    expect(legalMoves(mk({ blue: [52, 52, -1, -1], red: B }), 'blue', 2)).toEqual([expect.objectContaining({ kind: 'single', from: 52, to: 54 })]);
  });

  it('stops a single from passing an enemy double', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: [prog('red', 47), 56, 56, 56] });
    expect(legalMoves(ps, 'red', 4)).toEqual([]);
    expect(legalMoves(ps, 'red', 1)).toHaveLength(1);
  });

  it('lets a single sit on an enemy double without anyone being killed', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: [prog('red', 47), 56, 56, 56] });
    expect(legalMoves(ps, 'red', 2)).toEqual([expect.objectContaining({ kind: 'single', captures: [] })]);
  });

  it('lets a single sitting on an enemy double move on past it', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: [prog('red', 49), 56, 56, 56] });
    expect(legalMoves(ps, 'red', 4)).toEqual([expect.objectContaining({ kind: 'single', steps: 4 })]);
  });

  it('lets any other single kill a single sitting on a double, even the double\'s colour', () => {
    const ps = mk({ blue: [10, 10, 7, -1], green: [47, 56, 56, 56], red: [prog('red', 49), 56, 56, 56] });
    expect(legalMoves(ps, 'green', 2)[0]!.captures).toEqual([{ color: 'red', token: 0 }]);
    expect(legalMoves(ps, 'blue', 3).find((m) => m.from === 7)!.captures).toEqual([{ color: 'red', token: 0 }]);
  });

  it('lets your own single pass your own double', () => {
    const ps = mk({ blue: [10, 10, 8, -1], red: B });
    expect(legalMoves(ps, 'blue', 4).some((m) => m.kind === 'single' && m.from === 8 && m.to === 12)).toBe(true);
  });

  it('does not block on a star', () => {
    const ps = mk({ blue: [8, 8, -1, -1], red: [prog('red', 46), 56, 56, 56] });
    expect(legalMoves(ps, 'red', 1)[0]).toMatchObject({ captures: [] });
    expect(legalMoves(ps, 'red', 3)).toHaveLength(1);
  });

  it('never lets a double kill a single', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: [prog('red', 51), -1, -1, -1] });
    expect(legalMoves(ps, 'blue', 4)).toEqual([expect.objectContaining({ kind: 'pair', to: 12, captures: [] })]);
  });

  it('kills both tokens of an enemy double it lands on', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: [prog('red', 51), prog('red', 51), 56, 56] });
    const pair = legalMoves(ps, 'blue', 4)[0]!;
    expect(pair.captures).toEqual([{ color: 'red', token: 0 }, { color: 'red', token: 1 }]);
    expect(applyMove(ps, pair)[1]!.tokens).toEqual([-1, -1, 56, 56]);
  });

  it('kills an enemy double but not a single sitting on it', () => {
    const r = prog('red', 51);
    const ps = mk({ blue: [10, 10, -1, -1], red: [r, r, 56, 56], yellow: [prog('yellow', 51), 56, 56, 56] });
    expect(legalMoves(ps, 'blue', 4)[0]!.captures).toEqual([{ color: 'red', token: 0 }, { color: 'red', token: 1 }]);
  });

  it('lets a double pass an enemy double', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: [prog('red', 50), prog('red', 50), 56, 56] });
    expect(legalMoves(ps, 'blue', 4)).toEqual([expect.objectContaining({ kind: 'pair', to: 12, captures: [] })]);
  });

  it('lets an enemy double land on a double and kill it', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: [prog('red', 46), prog('red', 46), 56, 56] });
    const m = legalMoves(ps, 'red', 6);
    expect(m).toEqual([expect.objectContaining({ kind: 'pair', captures: [{ color: 'blue', token: 0 }, { color: 'blue', token: 1 }] })]);
  });
});

describe('threats', () => {
  it('sees an enemy within six squares behind', () => {
    const ps = mk({ blue: [5, -1, -1, -1], red: [prog('red', 41), -1, -1, -1] });
    expect(isThreatened(ps, 'blue', 5)).toBe(true);
  });

  it('ignores tokens on stars', () => {
    expect(isThreatened(mk({ blue: [8, -1, -1, -1], red: [prog('red', 44), -1, -1, -1] }), 'blue', 8)).toBe(false);
  });

  it('threatens a double only with an enemy double', () => {
    expect(isThreatened(mk({ blue: [5, 5, -1, -1], red: [prog('red', 41), -1, -1, -1] }), 'blue', 5)).toBe(false);
    expect(isThreatened(mk({ blue: [5, 5, -1, -1], red: [prog('red', 41), prog('red', 41), -1, -1] }), 'blue', 5)).toBe(true);
  });

  it('threatens a single sitting on an enemy double', () => {
    const ps = mk({ blue: [5, -1, -1, -1], green: [prog('green', 42), 56, 56, 56], red: [prog('red', 44), prog('red', 44), 56, 56] });
    expect(isThreatened(ps, 'blue', 5)).toBe(true);
  });
});
