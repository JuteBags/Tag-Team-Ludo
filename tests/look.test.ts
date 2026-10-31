// Board themes and colour-blind symbols: every theme sets every board colour, and every colour has
// its own shape.
import { describe, expect, it } from 'vitest';
import { COLORS } from '../src/engine';
import { symbolPath } from '../src/ui/art';
import { THEMES } from '../src/ui/themes';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = read('../src/ui/styles.css');
const art = read('../src/ui/art.ts');

const vars = (block: string) => new Set([...block.matchAll(/(--b-[a-z0-9-]+):/g)].map((m) => m[1]));
const blockOf = (selector: string) => css.slice(css.indexOf(selector)).split('}')[0]!;

describe('board themes', () => {
  const base = vars(blockOf(':root{--b-'));

  it('Classic defines the board colours the art uses', () => {
    const used = new Set([...art.matchAll(/var\((--b-[a-z0-9-]+)\)/g)].map((m) => m[1]));
    for (const v of used) expect(base, v).toContain(v);
  });

  // Thumbnails draw a board inside an element with data-theme, so Classic has its own block too.
  for (const t of THEMES) {
    it(`${t.name} sets every board colour`, () => {
      expect(vars(blockOf(`[data-theme=${t.id}]{`))).toEqual(base);
    });
  }
});

describe('colour-blind symbols', () => {
  it('gives every colour its own shape', () => {
    expect(new Set(COLORS.map((c) => symbolPath(c, 3))).size).toBe(COLORS.length);
  });
});
