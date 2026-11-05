// Device storage for the saved game and the stats. Capacitor Preferences keeps them in Android's
// SharedPreferences (which survive low storage better than localStorage) and in localStorage on the
// web. Every call is guarded: if storage fails, the game simply isn't saved.
import { Preferences } from '@capacitor/preferences';
import { COLORS, type BotLevel, type Color, type GameRecord, type GameState } from '../engine';
import { ACCURACY_VERSION, REVIEW_VERSION, summary, type MoveReview, type RollLuck } from '../engine/ai/review';
import type { GameConfig } from './setup';

async function read<T>(key: string): Promise<T | null> {
  try {
    const { value } = await Preferences.get({ key });
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

async function write(key: string, v: unknown) {
  try {
    await Preferences.set({ key, value: JSON.stringify(v) });
  } catch {
    // Not saved this time.
  }
}

async function drop(key: string) {
  try {
    await Preferences.remove({ key });
  } catch {
    // Nothing to remove.
  }
}

// ---------- the unfinished game ----------

/** Everything needed to pick a game up again, saved at the start of every turn. */
export interface SavedGame {
  v: 1;
  config: GameConfig;
  state: GameState;
  /** This game's running stats for the person playing vs Computer. */
  kills: number;
  pairs: number;
  /** Last face each colour rolled, so the resting dice look the same. */
  faces: [Color, number][];
  savedAt: number;
  /** The game's dice seed (gameScreen.ts); missing in saves from before 2.5, which get a new one. */
  seed?: number;
  /** Already counted as a loss when it was given up (so a crash can't count it twice). */
  counted?: boolean;
  /** The game so far as record events (engine/record.ts); missing in saves from before records. */
  log?: string;
  /** Undos each person used this game (#143), so a continued game keeps its count. */
  undos?: Record<number, number>;
}

const GAME = 'ludo-save';
export const loadGame = () =>
  read<SavedGame>(GAME).then((g) => {
    if (g?.v !== 1 || g.state?.phase === 'over' || g.counted) return null;
    // Saves from before the tray (1.5) are always at the start of a turn: an empty tray.
    g.state.rolls ??= [];
    return g;
  });
export const saveGame = (g: SavedGame) => write(GAME, g);
export const clearGame = () => drop(GAME);

/**
 * Whether giving this game up (quitting it, or starting a new game over its save) counts as a loss: vs
 * Computer, once every player has had a turn. Quitting in the first round (a wrong level picked, say) is free.
 */
export const givingUpLoses = (g: { config: GameConfig; state: GameState; counted?: boolean }) =>
  g.config.mode === 'pvc' && !g.counted && g.state.turnCount >= g.state.players.length;

/** What giving up a game costs, for the quit and new-game warnings. For an Extreme game the Extreme streak comes first. */
export const giveUpNote = (s: Stats, level?: BotLevel) =>
  level === 'extreme' && s.xStreak > 0
    ? `It counts as a loss and ends your Extreme streak of ${s.xStreak}.`
    : s.streak > 0
      ? `It counts as a loss and ends your win streak of ${s.streak}.`
      : 'It counts as a loss.';

/**
 * Gives up the saved game, if any, for a new one: it counts as a loss when `givingUpLoses`, then the save is
 * cleared. The save is marked counted first, so a crash in between can't count it twice.
 */
export async function giveUpSaved(): Promise<void> {
  const g = await loadGame();
  if (g && givingUpLoses(g)) {
    await saveGame({ ...g, counted: true });
    await recordGame({ mode: 'pvc', place: 0, kills: 0, pairs: 0, quit: true, level: levelOf(g.state) });
  }
  await clearGame();
}

// ---------- stats ----------

/** Totals on this device. Kills, pairs and places count the person playing vs Computer. */
export interface Stats {
  played: number;
  wins: number;
  /** Best finishing place so far (1 = won), 0 before the first game. */
  best: number;
  kills: number;
  pairs: number;
  /** Games played in "With friends". */
  friends: number;
  /** Sixes you rolled, and wins in a row (now and best). */
  sixes: number;
  /** Moves taken back with Undo (#143), every game on this device; a quiet count, like kills and sixes. */
  undos: number;
  streak: number;
  bestStreak: number;
  /** Wins by bot level (a game's level is its lowest bot's, `levelOf`). */
  levelWins: Record<BotLevel, number>;
  /** Wins in a row against Extreme bots, now and best. Only Extreme games count: games at other levels in between neither break nor extend it. */
  xStreak: number;
  xBestStreak: number;
  /** The layouts won against Extreme (`layoutOf`). */
  xModes: string[];
  /** The longest daily check-in run (checkin.ts). */
  checkinBest: number;
}

const STATS = 'ludo-stats';
export const emptyStats = (): Stats => ({
  played: 0, wins: 0, best: 0, kills: 0, pairs: 0, friends: 0, sixes: 0, undos: 0, streak: 0, bestStreak: 0,
  levelWins: { easy: 0, normal: 0, hard: 0, extreme: 0 }, xStreak: 0, xBestStreak: 0, xModes: [], checkinBest: 0,
});
export const EMPTY_STATS: Readonly<Stats> = emptyStats();
/** The stored totals; fields added since a device's last save start at zero. */
export const loadStats = () =>
  read<Partial<Stats>>(STATS).then((s) => {
    const e = emptyStats();
    return { ...e, ...s, levelWins: { ...e.levelWins, ...s?.levelWins }, xModes: [...(s?.xModes ?? [])] } as Stats;
  });
export const resetStats = () => drop(STATS);

/**
 * Adds one finished game to the totals and returns the new totals. A game given up (`quit`) counts as played
 * and lost and ends the win streaks (the Extreme one too, for an Extreme game), but adds nothing else.
 * `level` is the game's level (`levelOf`), `layout` its layout (`layoutOf`). `xEnded` is the Extreme streak
 * this game ended, if any.
 */
export async function recordGame(g: { mode: 'pvc' | 'pvp'; place: number; kills: number; pairs: number; sixes?: number; undos?: number; quit?: boolean; level?: BotLevel; layout?: string }): Promise<Stats & { xEnded: number }> {
  const s = await loadStats();
  const before = s.xStreak;
  const won = !g.quit && g.place === 1;
  // Undos count in every mode (#143): a quiet tally, never shown as a mistake.
  s.undos = (s.undos ?? 0) + (g.undos ?? 0);
  if (g.mode === 'pvp') s.friends++;
  else {
    s.played++;
    s.streak = won ? s.streak + 1 : 0;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
    if (g.level === 'extreme') {
      s.xStreak = won ? s.xStreak + 1 : 0;
      s.xBestStreak = Math.max(s.xBestStreak, s.xStreak);
      if (won && g.layout && !s.xModes.includes(g.layout)) s.xModes.push(g.layout);
    }
    if (won && g.level) s.levelWins[g.level]++;
    if (!g.quit) {
      if (won) s.wins++;
      s.best = s.best ? Math.min(s.best, g.place) : g.place;
      s.kills += g.kills;
      s.pairs += g.pairs;
      s.sixes += g.sixes ?? 0;
    }
  }
  await write(STATS, s);
  // The Extreme streak this game ended (0 if none), for the result screen.
  return { ...s, xEnded: before > 0 && s.xStreak === 0 ? before : 0 };
}

/** Records the longest check-in run, for the check-in achievements, and returns the new totals. */
export async function recordCheckIn(best: number): Promise<Stats> {
  const s = await loadStats();
  s.checkinBest = Math.max(s.checkinBest, best);
  await write(STATS, s);
  return s;
}

/** A game's bot level: its lowest bot's (normal for a bot without one), or undefined without bots. */
export function levelOf(state: GameState): BotLevel | undefined {
  const order: BotLevel[] = ['easy', 'normal', 'hard', 'extreme'];
  const bots = state.players.filter((p) => p.bot).map((p) => order.indexOf(p.level ?? 'normal'));
  return bots.length ? order[Math.min(...bots)] : undefined;
}

/** A game's layout: '2p', '3p', '4p', or with two houses each '2h-opposite' / '2h-side'. */
export function layoutOf(state: GameState): string {
  const owners = new Set(state.players.map((p) => p.owner)).size;
  if (state.players.length === owners) return `${owners}p`;
  const mine = state.players.filter((p) => p.owner === state.players[0]!.owner).map((p) => COLORS.indexOf(p.color));
  return Math.abs(mine[0]! - mine[1]!) === 2 ? '2h-opposite' : '2h-side';
}

// ---------- daily check-in (checkin.ts) ----------

/** The last day collected (local YYYY-MM-DD), the days in a row up to it, and the longest run so far. */
export interface CheckIn {
  last: string;
  streak: number;
  best: number;
}

const CHECKIN = 'ludo-checkin';
/** The stored check-in, null before the first one, or 'error' when storage can't be read (then no offer). */
export async function loadCheckIn(): Promise<CheckIn | null | 'error'> {
  try {
    const { value } = await Preferences.get({ key: CHECKIN });
    return value ? (JSON.parse(value) as CheckIn) : null;
  } catch {
    return 'error';
  }
}
/** Stores the check-in; false when the write failed (then the gold isn't paid, so it can't be paid twice). */
export async function saveCheckIn(c: CheckIn): Promise<boolean> {
  try {
    await Preferences.set({ key: CHECKIN, value: JSON.stringify(c) });
    return true;
  } catch {
    return false;
  }
}

// ---------- the daily puzzle (#99, puzzleDay.ts) ----------

/** A puzzle played: the move picked (an index into its state.moves) and whether it was the best. */
export interface PuzzlePick {
  pick: number;
  best: boolean;
}
/** The last day a puzzle was played, the days in a row up to it, the longest run, and that day's picks. */
export interface PuzzleLog {
  last: string;
  streak: number;
  best: number;
  daily?: PuzzlePick;
  expert?: PuzzlePick;
}

const PUZZLE = 'ludo-puzzle';
/** The stored puzzle log, null before the first puzzle, or 'error' when storage can't be read. */
export async function loadPuzzleLog(): Promise<PuzzleLog | null | 'error'> {
  try {
    const { value } = await Preferences.get({ key: PUZZLE });
    return value ? (JSON.parse(value) as PuzzleLog) : null;
  } catch {
    return 'error';
  }
}
/** Stores the puzzle log; false when the write failed (then no gold is paid, so it can't be paid twice). */
export async function savePuzzleLog(l: PuzzleLog): Promise<boolean> {
  try {
    await Preferences.set({ key: PUZZLE, value: JSON.stringify(l) });
    return true;
  } catch {
    return false;
  }
}

// ---------- past games (#65) ----------

/**
 * A finished game: its record (engine/record.ts), when it ended, and your place in it. Only games that reach
 * the result screen are kept: a quit game, or one given up for a new game, isn't.
 */
export interface PastGame {
  rec: GameRecord;
  at: number;
  mode: 'pvc' | 'pvp';
  place: number;
  /** A review stored by an older build inside the entry; reviews now live under their own key (loadReview). */
  review?: StoredReview;
}

export interface StoredReview {
  v: number;
  moves: MoveReview[];
  luck: RollLuck[] | null;
  /** When it was last worked on (ms since 1970), shown as "Reviewed today". */
  when?: number;
  /** Every owner's net win chance (whole %) at every state, for the replay's win-chance bar. */
  chances?: number[][];
  /** The owners it covers (people by default, plus any bot whose side was asked for). */
  who?: number[];
  /** A review from an older label version, shown (greyed) until this one is finished. */
  old?: StoredReview;
  /** Decisions with nothing to choose (every move reaches the same position): counted as done, never asked again. */
  skip?: number[];
  /** Set once every decision and the luck are in. */
  done?: boolean;
}

const GAMES = 'ludo-games';
/** How many finished games are kept, newest first. */
export const KEEP_GAMES = 20;
export const loadPastGames = () => read<PastGame[]>(GAMES).then((g) => (Array.isArray(g) ? g : []));

/**
 * A game's identity, for its review: who sat where, the seed and every event, so two games never share one.
 * The same game from storage, the result screen or a link gives the same key.
 */
export const keyOf = (rec: GameRecord) => `${rec.seed ?? ''}|${rec.seats.map((s) => `${s.color}${s.owner}${s.bot ? 'b' : ''}`).join(',')}|${rec.first}|${rec.events}`;

/** A short storage key for a game's review (FNV-1a over keyOf, base 36): reviews live apart from the games list. */
export function reviewKey(rec: GameRecord): string {
  const k = keyOf(rec);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x0100019d) >>> 0;
  }
  return `ludo-review-${h1.toString(36)}${h2.toString(36)}`;
}

// Writes to the games list go one at a time, so a game saved while another write is in flight is never lost.
let gamesChain: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const next = gamesChain.then(f, f);
  gamesChain = next.catch(() => undefined);
  return next;
};

/** Adds a finished game, dropping the oldest past KEEP_GAMES (and their reviews and summaries). */
export function savePastGame(g: PastGame): Promise<void> {
  return serial(async () => {
    const all = [g, ...(await loadPastGames())];
    await write(GAMES, all.slice(0, KEEP_GAMES));
    const gone = all.slice(KEEP_GAMES).map((old) => reviewKey(old.rec));
    for (const k of gone) await drop(k);
    if (gone.length) {
      const index = await loadSummaries();
      if (gone.some((k) => k in index)) await write(INDEX, Object.fromEntries(Object.entries(index).filter(([k]) => !gone.includes(k))));
    }
  });
}

/**
 * A review in a few numbers (#98): what the app start (is it finished?) and the Stats list (accuracy, luck,
 * key mistakes) need, so they don't read every full review. Only a hint: opening a game always reads the full
 * review, which rewrites the summary when it's missing, old or different.
 */
export interface ReviewSummary {
  v: number;
  done: boolean;
  /** Per owner: decisions reviewed, accuracy (0-1) and luck percentile (null when there's none), mistakes, blunders. */
  owners: { moves: number; accuracy: number | null; luckPct: number | null; mistake: number; blunder: number }[];
  /** The accuracy rules it was made under (ACCURACY_VERSION): another is redone from the full review (#133). */
  acc?: number;
}

const INDEX = 'ludo-review-index';
const finite = (x: number) => (Number.isFinite(x) ? x : null);

/** The summary of a stored review of `rec`. */
export function summaryOf(rec: GameRecord, r: StoredReview): ReviewSummary {
  const owners = new Set(rec.seats.map((s) => s.owner)).size;
  return {
    v: r.v,
    done: !!r.done,
    owners: summary(r.moves, r.luck ?? [], owners).map((o) => ({ moves: o.moves, accuracy: finite(o.accuracy), luckPct: finite(o.luckPct), mistake: o.labels.mistake, blunder: o.labels.blunder })),
    acc: ACCURACY_VERSION,
  };
}

/** Every stored review's summary, by review key: one small read. */
export const loadSummaries = () => read<Record<string, ReviewSummary>>(INDEX).then((x) => x ?? {});

/** The summary of `rec`'s review, if one is stored and it's for this label version (else read the full review). */
export async function loadSummary(rec: GameRecord, index?: Record<string, ReviewSummary>): Promise<ReviewSummary | undefined> {
  const s = (index ?? (await loadSummaries()))[reviewKey(rec)];
  // Another label version, or accuracy rules: read the full review, which keeps every gap, and rewrite it.
  return s?.v === REVIEW_VERSION && s.acc === ACCURACY_VERSION ? s : undefined;
}

/** Writes `rec`'s summary into the index, unless it's already the same (writes go one at a time). */
function keepSummary(rec: GameRecord, s: ReviewSummary): Promise<void> {
  return serial(async () => {
    const index = await loadSummaries();
    const k = reviewKey(rec);
    if (JSON.stringify(index[k]) === JSON.stringify(s)) return;
    index[k] = s;
    await write(INDEX, index);
  });
}

/**
 * A game's stored review: under its own key (#92), or, for a game saved before that, inside its past-game
 * entry. Never written into the games list again, so a review save can't lose a game.
 */
export async function loadReview(rec: GameRecord): Promise<StoredReview | undefined> {
  const own = await read<StoredReview>(reviewKey(rec));
  const r = own ?? (await loadPastGames()).find((g) => keyOf(g.rec) === keyOf(rec))?.review;
  // The full review is the truth: its summary is (re)written if it's missing, old or different (#98).
  if (r) void keepSummary(rec, summaryOf(rec, r));
  return r;
}

/**
 * Stores a game's review under its own key, if the game is still one of the past games. `ok()` is asked again
 * just before the write (the review runner's "am I still the newest run of this game?").
 */
export async function saveReview(rec: GameRecord, review: StoredReview, ok: () => boolean = () => true): Promise<void> {
  const k = keyOf(rec);
  if (!(await loadPastGames()).some((g) => keyOf(g.rec) === k)) return;
  if (!ok()) return;
  await write(reviewKey(rec), review);
  // Then its summary, so a summary never runs ahead of the review it describes (#98).
  await keepSummary(rec, summaryOf(rec, review));
}
