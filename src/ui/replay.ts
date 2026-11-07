// The replay (#65): a game record turned into frames to step through, with a caption for each, plus the
// share link. Pure, so the frames and the privacy rules are tested; replayScreen.ts draws them.
import { encodeRecord, ownerRanking, replay, type Color, type GameRecord, type GameState, type Move } from '../engine';
import { cleanName } from './setup';
import type { Label } from '../engine/ai/review';
import type { StoredReview } from './store';

const COLOR_NAME: Record<Color, string> = { blue: 'Blue', green: 'Green', red: 'Red', yellow: 'Yellow' };

/** One step of the replay: the position to show, the move that led to it (to animate), and what happened. */
export interface Frame {
  /** The index of `state` in the replay's states. */
  at: number;
  state: GameState;
  move?: Move;
  caption: string;
  /** The turn's dice, as they were in the tray before this move. */
  dice: number[];
}

/**
 * The names to show for each owner. Names in a record can come from a shared link, so each goes through
 * cleanName (no characters that could form markup, at most NAME_MAX) and falls back to the colour.
 */
export function namesOf(rec: GameRecord): string[] {
  const raw = Array.isArray(rec.meta?.names) ? (rec.meta!.names as unknown[]) : [];
  const owners = [...new Set(rec.seats.map((s) => s.owner))].sort((a, b) => a - b);
  return owners.map((o) => {
    const first = rec.seats.find((s) => s.owner === o)!;
    return cleanName(typeof raw[o] === 'string' ? (raw[o] as string) : '', COLOR_NAME[first.color]);
  });
}

/**
 * The record as it's shared: people's names are left out (a game with friends carries their names), so
 * each person becomes their colours ("Blue", or "Blue & Red" with two houses). Bots keep their names.
 */
export function forSharing(rec: GameRecord): GameRecord {
  const owners = [...new Set(rec.seats.map((s) => s.owner))].sort((a, b) => a - b);
  const names = namesOf(rec);
  const shared = owners.map((o, i) => {
    const mine = rec.seats.filter((s) => s.owner === o);
    if (mine.every((s) => s.bot)) return names[i]!;
    return mine.map((s) => COLOR_NAME[s.color]).join(' & ');
  });
  return { ...rec, meta: { ...(rec.meta ?? {}), names: shared } };
}

/** The web game's link that opens straight into this replay. The record rides in the fragment, so it never reaches a server. */
export async function shareLink(rec: GameRecord, site: string): Promise<string> {
  return `${site}play/#game=${await encodeRecord(forSharing(rec))}`;
}

/** The record in a link's fragment, if there is one: `#game=...`. */
export const linkPayload = (hash: string) => (hash.startsWith('#game=') ? hash.slice('#game='.length) : null);

/** A short link (#229): the game is kept on our server, and the link carries only its code. */
export const shortLink = (code: string, site: string) => `${site}play/#g=${code}`;
/** The code in a short link's fragment, if there is one: `#g=...` (12 letters and digits). */
export const linkCode = (hash: string) => (/^#g=[A-Za-z0-9]{12}$/.test(hash) ? hash.slice(3).toUpperCase() : null);

/** A move in words: "Red moved 4, capturing Blue" (the replay's captions; also the puzzle's example line). */
export function describe(m: Move, who: string, names: (c: Color) => string): string {
  const what = m.kind === 'release' ? 'brought a token out' : m.tokens.length > 1 ? `moved a pair ${m.steps}` : `moved ${m.steps}`;
  const kills = m.captures.length ? `, capturing ${[...new Set(m.captures.map((c) => names(c.color)))].join(' and ')}` : '';
  const home = m.finishes ? (m.finishes > 1 ? `, ${m.finishes} tokens home` : ', a token home') : '';
  return `${who} ${what}${kills}${home}`;
}

/**
 * The frames of a replay: the start, then one frame per move or per turn that couldn't move, and the end.
 * Rolls don't get frames of their own: a turn's dice show with the moves they're played by.
 */
export function framesOf(rec: GameRecord): { frames: Frame[]; error?: string; stopped: boolean } {
  const r = replay(rec);
  const names = namesOf(rec);
  const ownerName = (c: Color) => names[rec.seats.find((s) => s.color === c)?.owner ?? 0] ?? COLOR_NAME[c];
  const frames: Frame[] = [];
  const states = r.states;
  if (!states.length) return { frames, error: r.ok ? undefined : r.error, stopped: false };
  // "You play", "Aarav plays".
  const s3 = (who: string, verb: string) => `${who} ${who === 'You' ? verb : verb + 's'}`;
  frames.push({ at: 0, state: states[0]!, caption: `${s3(ownerName(states[0]!.players[states[0]!.current]!.color), 'play')} first`, dice: [] });
  for (let i = 1; i < states.length; i++) {
    const s = states[i]!;
    const before = states[i - 1]!;
    const ev = s.event;
    if (!ev || ev.type === 'rolled') continue;
    if (ev.type === 'moved') frames.push({ at: i, state: s, move: ev.move, caption: describe(ev.move, ownerName(ev.move.color), ownerName), dice: before.rolls });
    else if (ev.type === 'no-move') frames.push({ at: i, state: s, caption: `${ownerName(ev.color)} rolled ${[...before.rolls, ev.dice].join(' · ')}: no move`, dice: [...before.rolls, ev.dice] });
    // Not "the turn is lost": dice kept from before the run still play (RULES.md rule 13).
    else if (ev.type === 'three-sixes') frames.push({ at: i, state: s, caption: `${ownerName(ev.color)} rolled 6, 6, 6`, dice: [6, 6, 6] });
  }
  const last = states.at(-1)!;
  if (r.ok && (last.phase === 'over' || r.stopped)) {
    const order = ownerRanking(last);
    frames.push({ at: states.length - 1, state: last, caption: `${s3(names[order[0]!] ?? 'Someone', 'win')}${r.stopped ? ' (the game ended early)' : ''}`, dice: [] });
  } else frames.push({ at: states.length - 1, state: last, caption: r.ok ? 'The record ends here' : 'The record is damaged from here', dice: [] });
  return { frames, error: r.ok ? undefined : r.error, stopped: r.ok && r.stopped };
}

// ---------- a shared game's review (#229) ----------

/** The review as it's shared: everything the replay and the review screen show, not the older version kept with it. */
export function sharedSummary(r: StoredReview): StoredReview {
  const { old: _old, ...rest } = r;
  return rest;
}

const LABELS: Label[] = ['best', 'good', 'inaccuracy', 'mistake', 'blunder'];
const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
const int = (x: unknown, lo: number, hi: number) => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;
const ints = (x: unknown, lo: number, hi: number) => Array.isArray(x) && x.every((v) => int(v, lo, hi));

/**
 * A shared review from a link, checked against its game before the screens use it (it's untrusted: anyone can
 * send anything). Undefined when it doesn't fit: the viewer's app then works the review out itself.
 */
export function sharedReview(x: unknown, states: number): StoredReview | undefined {
  const r = x as Partial<StoredReview> | null;
  if (!r || typeof r !== 'object' || !num(r.v) || !Array.isArray(r.moves)) return undefined;
  const okMove = (m: unknown) => {
    const v = m as Record<string, unknown>;
    return !!v && typeof v === 'object' && int(v.at, 0, states - 1) && int(v.owner, 0, 3) && int(v.played, 0, 200) && int(v.best, 0, 200) &&
      [v.playedChance, v.bestChance].every((c) => num(c) && (c as number) >= 0 && (c as number) <= 1) && num(v.gap) && num(v.se) &&
      LABELS.includes(v.label as Label) && (v.gaps === undefined || (Array.isArray(v.gaps) && v.gaps.every(num))) && (v.approx === undefined || v.approx === 'race' || v.approx === 'net');
  };
  const okLuck = (l: unknown) => {
    const v = l as Record<string, unknown>;
    return !!v && typeof v === 'object' && int(v.at, 0, states - 1) && int(v.owner, 0, 3) && int(v.face, 1, 6) && num(v.luck) && (v.sd === undefined || num(v.sd)) && (v.run === undefined || num(v.run));
  };
  if (!r.moves.every(okMove)) return undefined;
  if (r.luck !== null && r.luck !== undefined && !(Array.isArray(r.luck) && r.luck.every(okLuck))) return undefined;
  if (r.chances !== undefined && !(Array.isArray(r.chances) && r.chances.length <= states && r.chances.every((c) => Array.isArray(c) && c.length <= 4 && c.every(num)))) return undefined;
  if (r.who !== undefined && !ints(r.who, 0, 3)) return undefined;
  if (r.skip !== undefined && !ints(r.skip, 0, states)) return undefined;
  return { v: r.v!, moves: r.moves, luck: r.luck ?? null, ...(r.chances ? { chances: r.chances } : {}), ...(r.who ? { who: r.who } : {}), ...(r.skip ? { skip: r.skip } : {}), ...(r.done ? { done: true } : {}), ...(num(r.when) ? { when: r.when } : {}) };
}
