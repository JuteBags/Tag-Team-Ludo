// Ranked matchmaking, the pure part (tested in tests/rating.test.ts): who plays whom. matchmaker.ts runs it
// every second on that mode's queue.
import { modeSlots, type GameMode } from '../../src/net/protocol';
import { BOT_FILL_MS, botsAllowed, canMatch } from '../../src/net/rating';

/** Someone searching. */
export interface Waiting {
  id: string;
  name: string;
  rating: number;
  since: number;
}

/** A game the queue made: one entry per slot (modeSlots order), null for a ranked bot at `botRating`. */
export interface Match {
  slots: (Waiting | null)[];
  botRating: number;
}

/**
 * The games to start now, oldest searcher first. Two people fit when their ratings are within the wider of
 * their two windows, in the same league or (after LOWER_LEAGUE_MS) the one just below (canMatch). A group that
 * can't fill waits; once its oldest has waited BOT_FILL_MS, bots fill the rest, if everyone is up to Gold III
 * (botsAllowed); above that, it waits for people. In 2v2 the four are split into fair teams: the best and the weakest are partners.
 */
export function findMatches(queue: Waiting[], mode: GameMode, now: number): Match[] {
  const need = modeSlots(mode).length;
  const left = [...queue].sort((a, b) => a.since - b.since);
  const used = new Set<string>();
  const out: Match[] = [];
  for (const first of left) {
    if (used.has(first.id)) continue;
    // The closest ratings first, each one allowed with everyone already in the group (canMatch: the league rules).
    const near = left.filter((w) => w !== first && !used.has(w.id)).sort((a, b) => Math.abs(a.rating - first.rating) - Math.abs(b.rating - first.rating));
    const group = [first];
    for (const w of near) {
      if (group.length === need) break;
      if (group.every((g) => canMatch(g, w, now))) group.push(w);
    }
    // Not full: bots fill it once the oldest has waited BOT_FILL_MS, and only up to Gold III; else it waits.
    if (group.length < need && (now - first.since < BOT_FILL_MS || !botsAllowed(group))) continue;
    for (const w of group) used.add(w.id);
    const botRating = Math.round(group.reduce((a, w) => a + w.rating, 0) / group.length);
    out.push({ slots: arrange(mode, group, need, botRating), botRating });
  }
  return out;
}

/** The group in slot order; bots (null) take the places left. 2v2: fair teams (slots are A, B, A, B). */
function arrange(mode: GameMode, group: Waiting[], need: number, botRating: number): (Waiting | null)[] {
  const all: (Waiting | null)[] = [...group, ...Array<null>(need - group.length).fill(null)];
  if (mode !== '2v2') return all;
  const r = (w: Waiting | null) => w?.rating ?? botRating;
  const byRating = [...all].sort((a, b) => r(b) - r(a));
  // Best + weakest against the middle two.
  return [byRating[0]!, byRating[1]!, byRating[3]!, byRating[2]!];
}
