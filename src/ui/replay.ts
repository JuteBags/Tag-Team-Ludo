// The replay (#65): a game record turned into frames to step through, with a caption for each, plus the
// share link. Pure, so the frames and the privacy rules are tested; replayScreen.ts draws them.
import { encodeRecord, ownerRanking, replay, type Color, type GameRecord, type GameState, type Move } from '../engine';
import { cleanName } from './setup';

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

function describe(m: Move, who: string, names: (c: Color) => string): string {
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
    else if (ev.type === 'three-sixes') frames.push({ at: i, state: s, caption: `${ownerName(ev.color)} rolled three 6s: the turn is lost`, dice: [6, 6, 6] });
  }
  const last = states.at(-1)!;
  if (r.ok && (last.phase === 'over' || r.stopped)) {
    const order = ownerRanking(last);
    frames.push({ at: states.length - 1, state: last, caption: `${s3(names[order[0]!] ?? 'Someone', 'win')}${r.stopped ? ' (the game ended early)' : ''}`, dice: [] });
  } else frames.push({ at: states.length - 1, state: last, caption: r.ok ? 'The record ends here' : 'The record is damaged from here', dice: [] });
  return { frames, error: r.ok ? undefined : r.error, stopped: r.ok && r.stopped };
}
