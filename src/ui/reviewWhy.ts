// The review's "why" line (#97): a short reason the better move was better, from facts about the positions
// that the rules can check, never invented. Each fact compares the position after the better move with the
// position after the move played, using only the engine's rules (legal moves, captures, pairs, stars); the
// net and the rollouts never come into it. No fact that holds: no line.
import { FINISHED, HOME_FIRST, LAST_TRACK, applyMove, countAt, isSafe, legalMoves, sameSide, squareOf, type Color, type Move, type PlayerState } from '../engine';

/** A danger worth saying: the chance of being captured before your next turn, at least this. */
export const DANGER_SHOWN = 0.1;
/** And the two moves must differ by at least this much for it to be a reason. */
export const DANGER_GAP = 0.1;

/** Fair dice (#97, agreed): the line states a property of the position that anyone can check. */
const FACE = 1 / 6;

/** The opponents who could capture, and how: what the line names ("the yellow single", "the red pair"). */
export interface Danger {
  /** The chance (0-1) that some opponent captures the token(s) on their next turn, a lower bound. */
  p: number;
  /** Each colour that can hit, with whether it hits with a single token or a pair. */
  by: { color: Color; pair: boolean }[];
}

/**
 * The chance that `color`'s token(s) at `progress` are captured before `color` moves again, with fair dice.
 * For each opposing colour (never a partner's, rules.sameSide), over every tray it could roll (dice until a
 * non-6; three 6s cancel), it counts the trays holding a die that captures there right away (the engine's
 * legal moves). Colours are taken as independent: 1 - Π(1 - pᵢ). A die that only hits after another die
 * moved first isn't counted, so it's a lower bound. Nothing on a star, in the home column or in base is in danger.
 */
export function dangerAt(players: PlayerState[], color: Color, progress: number, singles = false): Danger {
  const sq = squareOf(color, progress);
  const none: Danger = { p: 0, by: [] };
  if (sq === null || isSafe(sq)) return none;
  const mine = players.find((p) => p.color === color)!.tokens;
  let safe = 1;
  const by: Danger['by'] = [];
  for (const opp of players) {
    if (sameSide(players, opp.color, color)) continue;
    const hits = new Map<number, boolean>(); // die -> captures with a pair move?
    for (let d = 1; d <= 6; d++) {
      for (const m of legalMoves(players, opp.color, d, singles)) {
        if (m.captures.some((c) => c.color === color && mine[c.token] === progress)) {
          hits.set(d, m.kind === 'pair');
          break;
        }
      }
    }
    if (!hits.size) continue;
    // Trays: k sixes (0-2) then a non-6 face; three 6s cancel (no tray).
    let p = 0;
    for (let k = 0; k <= 2; k++)
      for (let f = 1; f <= 5; f++) if ((k > 0 && hits.has(6)) || hits.has(f)) p += FACE ** (k + 1);
    safe *= 1 - p;
    by.push({ color: opp.color, pair: [...hits.values()].every((x) => x) });
  }
  return { p: 1 - safe, by };
}

/** The reasons the line can give, best-move reasons first in priority order, then the move played. */
export type WhyFact =
  | { kind: 'escape'; p: number }
  | { kind: 'past-pair'; color: Color }
  | { kind: 'pair' }
  | { kind: 'safe'; where: 'star' | 'home column' }
  | { kind: 'walked-in'; fromSafe: boolean; pair: boolean; danger: Danger };

const onNormalTrack = (color: Color, progress: number) => {
  const sq = squareOf(color, progress);
  return sq !== null && !isSafe(sq);
};
/** Two or more of `color`'s tokens on that progress's square, a normal one: a pair (none in a singles game). */
const pairAt = (players: PlayerState[], color: Color, progress: number, singles: boolean) => !singles && onNormalTrack(color, progress) && countAt(players, color, squareOf(color, progress)!) >= 2;

/**
 * The enemy pair `color`'s single sits on at `progress` (on a normal square), if any. A single can't pass an
 * enemy pair (rule 24): sitting on it is the one place it can get past, and only until the pair moves on (rule 25).
 */
function enemyPairUnder(players: PlayerState[], color: Color, progress: number): Color | null {
  if (!onNormalTrack(color, progress)) return null;
  const sq = squareOf(color, progress)!;
  for (const opp of players) if (!sameSide(players, opp.color, color) && countAt(players, opp.color, sq) >= 2) return opp.color;
  return null;
}

/**
 * The facts behind a verdict (#97), comparing the better move with the move played from the same position:
 * at most one about the better move (the first that holds, in priority order) and one about the move played.
 * Capturing, getting home and bringing a token out are left out: the verdict's sentence already says them.
 */
export function whyFacts(players: PlayerState[], played: Move, better: Move, singles = false): WhyFact[] {
  const color = better.color;
  const afterBetter = applyMove(players, better);
  const afterPlayed = applyMove(players, played);
  const out: WhyFact[] = [];
  const sameToken = better.tokens.some((t) => played.tokens.includes(t));
  // Where the better move's token stands after the move played (where it was, unless that move moved it too).
  const betterTokenAfterPlayed = sameToken ? played.to : better.from;
  const pick = (): WhyFact | null => {
    if (better.kind !== 'release' && better.from >= 0) {
      // 1. escape: its token was in danger, the better move takes it out, the move played leaves it in.
      const before = dangerAt(players, color, better.from, singles).p;
      const afterB = better.to >= HOME_FIRST || better.to === FINISHED ? 0 : dangerAt(afterBetter, color, better.to, singles).p;
      const afterP = betterTokenAfterPlayed >= HOME_FIRST ? 0 : dangerAt(afterPlayed, color, betterTokenAfterPlayed, singles).p;
      if (before >= DANGER_SHOWN && afterB < DANGER_SHOWN && afterP >= DANGER_SHOWN) return { kind: 'escape', p: before };
      // 2. past-pair: its single sits on an enemy pair, and the better move takes it on past (the move played doesn't).
      const under = singles || better.kind !== 'single' ? null : enemyPairUnder(players, color, better.from);
      if (under && !(sameToken && played.to > played.from)) return { kind: 'past-pair', color: under };
    }
    // 3. pair: the better move makes a pair of your colour on a normal square, and the move played doesn't.
    if (better.kind !== 'pair' && pairAt(afterBetter, color, better.to, singles) && !(played.kind !== 'pair' && pairAt(afterPlayed, color, played.to, singles))) return { kind: 'pair' };
    // 4. safe: the better move's token reaches a star or the home column from an unsafe square, the move played doesn't.
    if (better.kind !== 'release' && better.to !== FINISHED && onNormalTrack(color, better.from)) {
      const where = better.to >= HOME_FIRST ? 'home column' : !onNormalTrack(color, better.to) ? 'star' : null;
      const playedSafe = played.to >= HOME_FIRST || (played.to >= 0 && !onNormalTrack(color, played.to));
      if (where && !playedSafe) return { kind: 'safe', where };
    }
    return null;
  };
  const b = pick();
  if (b) out.push(b);
  // 5. walked-in: the token you moved ends in danger, and the better move's position doesn't have it.
  if (played.to <= LAST_TRACK && played.to >= 0) {
    const mine = dangerAt(afterPlayed, color, played.to, singles);
    const thereAfterBetter = sameToken ? better.to : played.from;
    const other = thereAfterBetter >= 0 && thereAfterBetter <= LAST_TRACK ? dangerAt(afterBetter, color, thereAfterBetter, singles).p : 0;
    if (mine.p >= DANGER_SHOWN && mine.p - other >= DANGER_GAP) {
      const fromSafe = played.kind !== 'release' && played.from >= 0 && !onNormalTrack(color, played.from);
      out.push({ kind: 'walked-in', fromSafe, pair: played.kind === 'pair', danger: mine });
    }
  }
  return out;
}

/** "about 20%": never claims to be exact (#97). */
const pct = (p: number) => `about ${Math.round(100 * p)}%`;
const hitters = (d: Danger) => {
  const names = d.by.map((x) => `${x.color}${x.pair ? ' pair' : ' single'}`);
  return names.length === 1 ? `the ${names[0]}` : `the ${names.slice(0, -1).join(', the ')} and the ${names.at(-1)}`;
};

/** The better move's reason in words, after "Why: ". */
export function betterReason(f: WhyFact): string | null {
  switch (f.kind) {
    case 'escape':
      return `it takes that token out of danger (it had ${pct(f.p)} chance to be hit next turn)`;
    case 'past-pair':
      return `it gets past the ${f.color} pair before the pair moves on`;
    case 'pair':
      return 'it makes a pair, safe from single tokens';
    case 'safe':
      return `it reaches ${f.where === 'star' ? 'a star' : 'the home column'}, where it can't be captured`;
    default:
      return null;
  }
}

/** The move played's reason in words. `whose` is "your" or "Aarav's". */
export function playedReason(f: WhyFact, whose: string): string | null {
  if (f.kind !== 'walked-in') return null;
  const what = `${whose} ${f.pair ? 'pair' : 'token'}`;
  const where = f.fromSafe ? `${what} left a safe star, into reach of ${hitters(f.danger)}` : `${what} is now in reach of ${hitters(f.danger)}`;
  return `${where} (${pct(f.danger.p)} chance to be hit next turn)`;
}

/**
 * The whole line: "Why: <better reason>, and <your reason>." Either alone when only one holds; null when
 * none does. `short`: the better-move reason alone (when both don't fit in two lines).
 */
export function whyLine(facts: WhyFact[], whose: string, short = false): string | null {
  const b = facts.map(betterReason).find((x) => x) ?? null;
  const p = short && b ? null : (facts.map((f) => playedReason(f, whose)).find((x) => x) ?? null);
  const parts = [b, p].filter(Boolean) as string[];
  if (!parts.length) return null;
  return `Why: ${parts.join(', and ')}.`;
}
