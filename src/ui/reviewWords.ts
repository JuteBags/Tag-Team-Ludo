// Review words the Stats sheet needs at startup (#98): kept out of reviewText.ts, which loads with the review
// and replay screens.

/** A luck percentile in words, as agreed for #96: "unlucky" under 20, "a bit unlucky" to 40, "average" to 60, "a bit lucky" to 80, then "lucky". */
export function luckBand(pct: number): { word: string; tone: 'lucky' | 'unlucky' | 'average' } {
  if (!Number.isFinite(pct)) return { word: 'average', tone: 'average' };
  if (pct < 20) return { word: 'unlucky', tone: 'unlucky' };
  if (pct < 40) return { word: 'a bit unlucky', tone: 'unlucky' };
  if (pct <= 60) return { word: 'average', tone: 'average' };
  if (pct <= 80) return { word: 'a bit lucky', tone: 'lucky' };
  return { word: 'lucky', tone: 'lucky' };
}

/** Accuracy (0-1) as shown: "87%", or "–" when it can't be scored (no meaningful decision, see accuracyOf). */
export const accuracyText = (acc: number) => (Number.isFinite(acc) ? `${Math.round(100 * acc)}%` : '–');

/** How many games the Stats trends show. */
export const TREND_GAMES = 10;

/**
 * The accuracy and luck trends (Stats): each reviewed game's accuracy (0-1) and luck percentile, oldest first,
 * the last TREND_GAMES, with their averages over the games that have one. null with fewer than 2 games.
 */
export function trendOf(games: { accuracy: number; luckPct: number }[], n = TREND_GAMES) {
  const last = games.slice(-n);
  if (last.length < 2) return null;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  return {
    games: last,
    accuracy: avg(last.map((g) => g.accuracy).filter(Number.isFinite)),
    luck: avg(last.map((g) => g.luckPct).filter(Number.isFinite)),
  };
}
