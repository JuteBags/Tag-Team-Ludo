// Gold (#35 phase 2): earned by playing, spent in the Store. Pure, so the amounts are tested.
// vs Computer pays for playing, your place, your kills and your tokens home; With friends pays a flat
// amount (the device belongs to one of the players, so nobody farms gold off friends).

/** Gold for each finishing place (index = place). */
const PLACE_GOLD = [0, 60, 30, 15, 0];

export interface GoldLine {
  label: string;
  gold: number;
}

/** What a finished game earns, line by line. `home` is how many of your tokens got home. */
export function goldFor(g: { mode: 'pvc' | 'pvp'; place: number; kills: number; home: number }): GoldLine[] {
  if (g.mode === 'pvp') return [{ label: 'Game with friends', gold: 15 }];
  const lines: GoldLine[] = [{ label: 'Game played', gold: 20 }];
  const placeGold = PLACE_GOLD[g.place] ?? 0;
  if (placeGold) lines.push({ label: g.place === 1 ? 'Win' : `${['', '1st', '2nd', '3rd', '4th'][g.place]} place`, gold: placeGold });
  if (g.kills) lines.push({ label: `${g.kills} kill${g.kills === 1 ? '' : 's'}`, gold: 5 * g.kills });
  if (g.home) lines.push({ label: `${g.home} token${g.home === 1 ? '' : 's'} home`, gold: 5 * g.home });
  return lines;
}

export const total = (lines: GoldLine[]) => lines.reduce((a, l) => a + l.gold, 0);
