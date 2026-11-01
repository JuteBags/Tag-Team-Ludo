// The game review's words, symbols and graph (#65), pure so they're tested; reviewScreen.ts draws them.
import type { Move } from '../engine';
import type { Label } from '../engine/ai/review';

/** Each label's symbol (so colour isn't the only cue), name and colour. */
export const LABEL_LOOK: Record<Label, { sym: string; name: string; color: string }> = {
  best: { sym: '★', name: 'Best', color: '#4ade80' },
  good: { sym: '✓', name: 'Good', color: '#a3e635' },
  inaccuracy: { sym: '?!', name: 'Inaccuracy', color: '#facc15' },
  mistake: { sym: '?', name: 'Mistake', color: '#fb923c' },
  blunder: { sym: '??', name: 'Blunder', color: '#f87171' },
};
export const LABELS: Label[] = ['best', 'good', 'inaccuracy', 'mistake', 'blunder'];

/** Luck under this many points reads as average dice, so noise isn't called luck. */
export const AVERAGE_LUCK = 5;

/** A person's dice luck in words first: "Lucky dice", "Unlucky dice" or "Average dice", and a line saying what it means. */
export function luckWords(luck: number, you: boolean): { word: string; tone: 'lucky' | 'unlucky' | 'average'; line: string } {
  const pts = Math.round(Math.abs(luck));
  const whose = you ? 'Your dice' : 'Their dice';
  if (Math.abs(luck) < AVERAGE_LUCK) return { word: 'Average dice', tone: 'average', line: `${whose} were about as good as average dice.` };
  return luck > 0
    ? { word: 'Lucky dice', tone: 'lucky', line: `${whose} gave ${you ? 'you' : 'them'} ${pts}% more winning chances than average dice.` }
    : { word: 'Unlucky dice', tone: 'unlucky', line: `${whose} cost ${you ? 'you' : 'them'} ${pts}% of winning chances against average dice.` };
}

/** What a move does, in a few words: "moved 5", "brought a token out", "moved a pair 3". */
export function moveText(m: Move): string {
  if (m.kind === 'release') return 'brought a token out';
  const base = m.tokens.length > 1 ? `moved a pair ${m.steps}` : `moved ${m.steps}`;
  if (m.captures.length) return `${base}, capturing`;
  if (m.finishes) return `${base}, home`;
  return base;
}

/** The win chance an average player has in this game: 100 / people (50 in 2p and team games, 25 in 4p). */
export const evenChance = (people: number) => 100 / people;

/** The graph's points: one per reviewed move, x over [0, w], y = the chance after the move on a 0-100 axis over [h, 0]. */
export function graphPoints(chances: number[], w: number, h: number): [number, number][] {
  const n = chances.length;
  return chances.map((c, i) => [n > 1 ? (w * i) / (n - 1) : w / 2, h * (1 - Math.max(0, Math.min(1, c)))]);
}

/** Verdicts to have before the list shows (one alone looks broken). */
export const SHOW_AFTER = 3;
