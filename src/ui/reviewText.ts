// The game review's words, symbols and graph (#65), pure so they're tested; reviewScreen.ts draws them.
import { FINISHED, type GameState, type Move } from '../engine';
import type { Label, MoveReview, RollLuck } from '../engine/ai/review';
import { accuracyText, luckBand } from './reviewWords';
// Moved to reviewWords.ts (#98) so the Stats sheet doesn't load this file at startup; still exported from here.
export { accuracyText, luckBand };

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
export function moveText(m: Move, nameOf?: (c: Move['color']) => string): string {
  if (m.kind === 'release') return 'brought a token out';
  const base = m.tokens.length > 1 ? `moved a pair ${m.steps}` : `moved ${m.steps}`;
  if (m.captures.length) return `${base}, capturing${nameOf ? ` ${[...new Set(m.captures.map((c) => nameOf(c.color)))].join(' and ')}` : ''}`;
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
export function verdictMoves(s: GameState, played: Move, best: Move, nameOf?: (c: Move['color']) => string): [string, string] {
  // Moves by the same die (same steps) could be either token: both say which ("moved 5 · Best: moved 5,
  // capturing" reads as the same move twice).
  const sameDie = played.kind !== 'release' && best.kind !== 'release' && played.steps === best.steps;
  const named = (m: Move) => {
    const t = moveText(m, nameOf);
    const w = sameDie ? whichToken(s, m) : '';
    return w ? t.replace(/^moved (a pair )?/, (_, pair: string | undefined) => `moved the ${w} ${pair ? 'pair ' : 'token '}`) : t;
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
/**
 * The rolls as the review shows them (#135): a cancelled run of three 6s is one event, on its third 6 and worth
 * the run's total; the run's first two 6s aren't shown on their own.
 */
export const rollEvents = (luck: RollLuck[]): RollLuck[] => luck.filter((r) => !r.inRun).map((r) => (r.run === undefined ? r : { ...r, luck: r.run }));

/** A person's cancelled runs of three 6s, as roll events, in game order: the review lists every one (#135). */
export const sixRuns = (luck: RollLuck[], owner: number): RollLuck[] => rollEvents(luck).filter((r) => r.run !== undefined && r.owner === owner);

export const bigRolls = (luck: RollLuck[], n = 3) => rollEvents(luck).sort((a, b) => Math.abs(b.luck) - Math.abs(a.luck) || a.at - b.at).slice(0, n);

/** A big roll in words: "Your lucky 6: +12" or "Aarav's unlucky 1: −9 for them". */
export function rollText(r: RollLuck, who: string, you: boolean): string {
  if (r.run !== undefined) {
    // Three 6s cancel (rule 13): one event for the run, in the "% to win" the verdicts use.
    const run = `${r.run >= 0 ? '+' : '−'}${Math.round(Math.abs(r.run))}% to win`;
    return you ? `Three 6s cancelled: ${run}` : `${who}'s three 6s cancelled: ${run} for them`;
  }
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


/** Under the card's "–": why a game has no accuracy (no decision with much at stake). */
export const FEW_BIG_DECISIONS = 'Few big decisions this game: accuracy needs a few moves where much was at stake.';

/** Below this accuracy (0-1) with no key mistakes, the headline explains the small slips. */
export const SMALL_SLIPS_BELOW = 0.75;

/** Accuracy (0-1) the headline calls great play. */
export const GREAT_PLAY = 0.9;

/**
 * The story of the game in one sentence, from one player's side: whether they won, how well they played
 * (accuracy 0-1) and how their dice were (luck percentile). `name` is "You" or the player's name.
 */
export function headline(o: { won: boolean; accuracy: number; luckPct: number; name: string; decider?: MoveReview; keyMistakes?: number; inaccuracies?: number }): string {
  const you = o.name === 'You';
  // No accuracy (no meaningful decision): nothing here quotes or compares one.
  const scored = Number.isFinite(o.accuracy);
  // No mistake or blunder but a low accuracy: the losses were small slips in close decisions. Say so, rather
  // than anything that would read against "No key mistakes" on the card.
  if (scored && o.keyMistakes === 0 && o.accuracy < SMALL_SLIPS_BELOW) return 'No big mistakes, but small slips added up in close decisions.';
  // A loss turned by one bad move says so, whatever the accuracy.
  if (!o.won && o.decider && (o.decider.label === 'blunder' || o.decider.label === 'mistake'))
    return `One ${o.decider.label} decided it: a single move cost ${Math.round(o.decider.gap)} points of winning chance.`;
  const acc = `${Math.round(100 * o.accuracy)}%`;
  const luck = `luck ${Math.round(o.luckPct)}%`;
  const them = you ? 'you' : 'them';
  const great = scored && o.accuracy >= GREAT_PLAY;
  const unlucky = o.luckPct < 40;
  const lucky = o.luckPct > 60;
  if (o.won) {
    if (great && unlucky) return `Won against the dice: great play (${acc}) beat unlucky rolls (${luck}).`;
    if (great) return `Won on great play: ${acc} accuracy.`;
    if (lucky) return `Won, with the dice on ${you ? 'your' : 'their'} side (${luck}).`;
    return 'Won, with a few slips to learn from.';
  }
  if (great && unlucky) return `${o.name} played well (${acc}), but the dice went against ${them} (${luck}).`;
  if (great) return `${o.name} played well (${acc}): the turning point decided it.`;
  // No key mistakes: it was the small slips that added up, so say that rather than "mistakes".
  const slips = !o.keyMistakes && o.inaccuracies ? `${o.inaccuracies} small slip${o.inaccuracies === 1 ? '' : 's'}` : '';
  if (lucky) return slips ? `The dice were kind (${luck}), but ${slips} added up.` : `The dice were kind (${luck}), but the mistakes cost the game.`;
  return slips ? `Lost on ${slips}: the key moves show where.` : 'Lost on mistakes: the key moves show where.';
}

/** A swing only counts as the turning point while the game was still open: the side's chance before it inside this band. */
export const OPEN_GAME: [number, number] = [0.1, 0.9];

/**
 * The turning point from one owner's side: the biggest swing in their winning chances while the outcome was
 * still open, either one of their moves (the points it gave up) or anyone's roll (its luck). `chanceAt(at)` is
 * the side's win chance (0-1) at a state, when known. The game's last move and last roll never count (the
 * final swing is always big and never telling). Null when nothing qualifies.
 */
export function turningPoint(moves: MoveReview[], luck: RollLuck[], owner: number, chanceAt?: (at: number) => number | undefined): { kind: 'move'; move: MoveReview } | { kind: 'roll'; roll: RollLuck } | null {
  const open = (c: number | undefined) => c === undefined || (c >= OPEN_GAME[0] && c <= OPEN_GAME[1]);
  const lastMove = Math.max(-1, ...moves.map((x) => x.at));
  const lastRoll = Math.max(-1, ...luck.map((x) => x.at));
  const m = moves
    .filter((x) => x.owner === owner && x.at !== lastMove && open(chanceAt?.(x.at) ?? x.bestChance))
    .sort((a, b) => b.gap - a.gap || a.at - b.at)[0];
  const r = rollEvents(luck).filter((x) => x.at !== lastRoll && open(chanceAt?.(x.at))).sort((a, b) => Math.abs(b.luck) - Math.abs(a.luck) || a.at - b.at)[0];
  const mv = m && m.gap >= 1 ? m.gap : 0;
  const rv = r ? Math.abs(r.luck) : 0;
  if (!mv && rv < 1) return null;
  return mv >= rv ? { kind: 'move', move: m! } : { kind: 'roll', roll: r! };
}

/** The better move's colour (#124): its path, its pill and its "+N% to win" all share it. */
export const BETTER_COLOR = '#34d399';
/** A piece of a plain verdict: text, or a word shown as a pill in the colour of its path on the board. */
export type VerdictPart = string | { pill: 'you' | 'better'; text: string };
export interface PlainVerdict {
  label: Label;
  /** The label in words ("Blunder"), and its colour. */
  name: string;
  color: string;
  /** What the better move would have kept, for Inaccuracy, Mistake and Blunder only: always "+N% to win", in the better move's colour. */
  win: { text: string; color: string } | null;
  /** One sentence: what was played and, when it wasn't the best, what was better. */
  parts: VerdictPart[];
  /** A better move to draw on the board. */
  better: boolean;
}

/**
 * The replay's verdict in plain words (#124): "You moved this token 3. Moving that one 6 gets it home.",
 * with "this token" and "that one" as pills in the colours of the "You" and "Better" paths on the board.
 * No symbols, token numbers or points: the win chance given up is "+19% to win". `who` is "You" or a name.
 */
export function plainVerdict(m: Pick<MoveReview, 'label' | 'played' | 'best' | 'gap'>, s: Pick<GameState, 'moves'>, who: string): PlainVerdict {
  const look = LABEL_LOOK[m.label];
  const played = s.moves[m.played]!;
  const best = s.moves[m.best]!;
  const isBest = m.label === 'best' || m.played === m.best;
  const base = { label: m.label, name: look.name, color: look.color };
  if (isBest) return { ...base, win: null, better: false, parts: [`${who} found the best move.`] };
  const you: VerdictPart[] =
    played.kind === 'release'
      ? [`${who} brought a new token out.`]
      : [`${who} moved `, { pill: 'you', text: played.tokens.length > 1 ? 'this pair' : 'this token' }, ` ${played.steps}${played.finishes ? ' home' : played.captures.length ? ', capturing' : ''}.`];
  const sameToken = played.kind !== 'release' && best.kind !== 'release' && played.tokens.length === best.tokens.length && played.tokens.every((t) => best.tokens.includes(t));
  const ending = best.finishes ? ' gets it home.' : best.captures.length ? ' captures.' : ' was better.';
  const better: VerdictPart[] =
    best.kind === 'release'
      ? [{ pill: 'better', text: 'Bringing a new one out' }, ' was better.']
      : ['Moving ', { pill: 'better', text: sameToken ? 'it' : best.tokens.length > 1 ? 'that pair' : 'that one' }, ` ${best.steps}${ending}`];
  const key = m.label === 'inaccuracy' || m.label === 'mistake' || m.label === 'blunder';
  return { ...base, better: true, win: key ? { text: `+${Math.max(1, Math.round(m.gap))}% to win`, color: BETTER_COLOR } : null, parts: [...you, ' ', ...better] };
}

/**
 * A decision's verdict in words: `head` "Inaccuracy −4" and `line` "You moved 5 · Best: moved a pair 3" (the best
 * only when it differs). `who` is "You" or the player's name.
 */
export function verdictText(m: MoveReview, s: GameState, who: string, nameOf?: (c: Move['color']) => string): { head: string; line: string } {
  const look = LABEL_LOOK[m.label];
  const head = `${look.name}${m.label !== 'best' && m.gap >= 1 ? ` −${Math.round(m.gap)}` : ''}`;
  const plain = m.played === m.best || m.label === 'best';
  const [played, best] = verdictMoves(s, s.moves[m.played]!, s.moves[m.best]!, nameOf);
  return { head, line: `${who} ${plain ? moveText(s.moves[m.played]!, nameOf) : played}${plain ? '' : ` · Best: ${best}`}` };
}
