// The game review's words, symbols and graph (#65), pure so they're tested; reviewScreen.ts draws them.
import { FINISHED, type GameState, type Move } from '../engine';
import type { Label, MoveReview, RollLuck } from '../engine/ai/review';

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

/**
 * A person's dice luck in words first: "Lucky dice", "Unlucky dice" or "Average dice", and a line saying what it
 * means, to follow the word ("Unlucky dice: your rolls cost you 17 points of winning chance compared with
 * average rolls."). Luck is in points of winning chance (an absolute -100..100 scale), so the line says points, not %.
 */
export function luckWords(luck: number, you: boolean): { word: string; tone: 'lucky' | 'unlucky' | 'average'; line: string } {
  const pts = Math.round(Math.abs(luck));
  const whose = you ? 'your rolls' : 'their rolls';
  const them = you ? 'you' : 'them';
  if (Math.abs(luck) < AVERAGE_LUCK) return { word: 'Average dice', tone: 'average', line: `${whose} were about as good as average rolls.` };
  return luck > 0
    ? { word: 'Lucky dice', tone: 'lucky', line: `${whose} gave ${them} ${pts} ${pts === 1 ? 'point' : 'points'} of winning chance more than average rolls.` }
    : { word: 'Unlucky dice', tone: 'unlucky', line: `${whose} cost ${them} ${pts} ${pts === 1 ? 'point' : 'points'} of winning chance compared with average rolls.` };
}

/** What a move does, in a few words: "moved 5", "brought a token out", "moved a pair 3". */
export function moveText(m: Move): string {
  if (m.kind === 'release') return 'brought a token out';
  const base = m.tokens.length > 1 ? `moved a pair ${m.steps}` : `moved ${m.steps}`;
  if (m.captures.length) return `${base}, capturing`;
  if (m.finishes) return `${base}, home`;
  return base;
}

/**
 * Which of the mover's tokens on the track a move takes, by how far along it is: "front", "back", "2nd" or
 * "3rd" (from the front), or '' when it's the only one out (or the move brings a token out).
 */
export function whichToken(s: GameState, m: Move): string {
  const p = s.players.find((x) => x.color === m.color);
  if (!p || m.kind === 'release') return '';
  const out = p.tokens.map((t, i) => ({ t, i })).filter((x) => x.t >= 0 && x.t < FINISHED).sort((a, b) => b.t - a.t || a.i - b.i);
  const r = out.findIndex((x) => x.i === m.tokens[0]);
  if (out.length < 2 || r < 0) return '';
  return r === 0 ? 'front' : r === out.length - 1 ? 'back' : r === 1 ? '2nd' : '3rd';
}

/**
 * The played and best moves in words, for a verdict. When they'd read the same ("moved 4 · Best: moved 4": same
 * steps, another token), both say which token: "moved the back token 4 · Best: moved the front token 4".
 */
export function verdictMoves(s: GameState, played: Move, best: Move): [string, string] {
  const a = moveText(played);
  const b = moveText(best);
  if (a !== b) return [a, b];
  const named = (m: Move) => {
    const w = whichToken(s, m);
    if (!w) return moveText(m);
    return moveText(m).replace(/^moved (a pair )?/, (_, pair: string | undefined) => `moved the ${w} ${pair ? 'pair ' : 'token '}`);
  };
  return [named(played), named(best)];
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

/** The labels a "Key moves" list shows: the moves that lost something. */
export const KEY_LABELS: Label[] = ['inaccuracy', 'mistake', 'blunder'];

/** The key moves: every inaccuracy, mistake and blunder, most points lost first (ties in game order). */
export const keyMoves = (moves: MoveReview[]) => moves.filter((m) => KEY_LABELS.includes(m.label)).sort((a, b) => b.gap - a.gap || a.at - b.at);

/** The `n` rolls that swung the game most, for anyone, biggest first (ties in game order). */
export const bigRolls = (luck: RollLuck[], n = 3) => [...luck].sort((a, b) => Math.abs(b.luck) - Math.abs(a.luck) || a.at - b.at).slice(0, n);

/** A big roll in words: "Your lucky 6: +12" or "Aarav's unlucky 1: −9 for them". */
export function rollText(r: RollLuck, who: string, you: boolean): string {
  const pts = `${r.luck >= 0 ? '+' : '−'}${Math.round(Math.abs(r.luck))}`;
  const kind = r.luck >= 0 ? 'lucky' : 'unlucky';
  return you ? `Your ${kind} ${r.face}: ${pts}` : `${who}'s ${kind} ${r.face}: ${pts} for them`;
}

/**
 * The time left in words, from the seconds still to go: to the nearest half minute so it doesn't tick down
 * jerkily, "Almost done" under 20 s, and nothing when there's no estimate yet.
 */
export function etaText(secs: number | null): string {
  if (secs === null || !Number.isFinite(secs)) return '';
  if (secs < 20) return 'Almost done';
  const halves = Math.max(1, Math.round(secs / 30));
  if (halves === 1) return 'About half a minute left';
  const mins = halves / 2;
  return `About ${Number.isInteger(mins) ? mins : `${Math.floor(mins)}½`} ${mins === 1 ? 'minute' : 'minutes'} left`;
}

/** When a review was made, in words: "Reviewed today", "Reviewed yesterday", "Reviewed 2 Nov". */
export function reviewedText(when: number | undefined, now = Date.now()): string {
  if (!when) return '';
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(when)) / 86_400_000);
  if (days <= 0) return 'Reviewed today';
  if (days === 1) return 'Reviewed yesterday';
  const d = new Date(when);
  const month = d.toLocaleString('en-GB', { month: 'short' });
  return `Reviewed ${d.getDate()} ${month}${d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`}`;
}
