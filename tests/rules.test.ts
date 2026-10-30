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

describe('pairs', () => {
  it('moves a pair half the roll on an even roll only', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: B });
    const four = legalMoves(ps, 'blue', 4);
    expect(four.find((m) => m.kind === 'pair')).toMatchObject({ tokens: [0, 1], from: 10, to: 12, steps: 2 });
    expect(four.filter((m) => m.kind === 'single')).toHaveLength(1); // the two tokens give one single move
    expect(legalMoves(ps, 'blue', 3).some((m) => m.kind === 'pair')).toBe(false);
  });

  it('blocks enemy landing and passing on a normal square', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: [prog('red', 47), 56, 56, 56] });
    expect(squareOf('blue', 10)).toBe(49);
    expect(legalMoves(ps, 'red', 2)).toEqual([]); // would land on the block
    expect(legalMoves(ps, 'red', 4)).toEqual([]); // would pass it
    expect(legalMoves(ps, 'red', 1)).toHaveLength(1);
  });

  it('stops an enemy pair too', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: [prog('red', 46), prog('red', 46), 56, 56] });
    expect(legalMoves(ps, 'red', 6)).toEqual([]);
  });

  it('lets your own tokens pass your block', () => {
    const ps = mk({ blue: [10, 10, 8, -1], red: B });
    expect(legalMoves(ps, 'blue', 4).some((m) => m.kind === 'single' && m.from === 8 && m.to === 12)).toBe(true);
  });

  it('does not block on a star', () => {
    const ps = mk({ blue: [8, 8, -1, -1], red: [prog('red', 46), 56, 56, 56] });
    expect(squareOf('blue', 8)).toBe(47);
    expect(legalMoves(ps, 'red', 1)[0]).toMatchObject({ captures: [] });
    expect(legalMoves(ps, 'red', 3)).toHaveLength(1);
  });

  it('captures a single enemy where the pair lands', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: [prog('red', 51), -1, -1, -1] });
    const pair = legalMoves(ps, 'blue', 4).find((m) => m.kind === 'pair')!;
    expect(pair.captures).toEqual([{ color: 'red', token: 0 }]);
  });

  it('has no pairs in the home column', () => {
    const ps = mk({ blue: [52, 52, -1, -1], red: B });
    expect(legalMoves(ps, 'blue', 2)).toEqual([expect.objectContaining({ kind: 'single', from: 52, to: 54 })]);
  });
});

describe('threats', () => {
  it('sees an enemy within six squares behind', () => {
    const ps = mk({ blue: [5, -1, -1, -1], red: [prog('red', 41), -1, -1, -1] });
    expect(isThreatened(ps, 'blue', 5)).toBe(true);
  });

  it('ignores tokens on stars and in blocks', () => {
    expect(isThreatened(mk({ blue: [8, -1, -1, -1], red: [prog('red', 44), -1, -1, -1] }), 'blue', 8)).toBe(false);
    expect(isThreatened(mk({ blue: [5, 5, -1, -1], red: [prog('red', 41), -1, -1, -1] }), 'blue', 5)).toBe(false);
  });
});
