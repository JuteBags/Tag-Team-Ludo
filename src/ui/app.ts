// App shell: a fixed 390 x 844 stage scaled to fit any screen, plus simple routing.
import { globalDefs } from './art';
import { GameScreen } from './gameScreen';
import { homeScreen } from './homeScreen';
import { handleBack } from './native';
import type { GameConfig, Mode } from './setup';
import { setupScreen } from './setupScreen';
import { giveUpSaved, loadGame, loadPuzzleLog, loadReview, type SavedGame } from './store';
import { puzzleBadge } from './puzzleDay';
import { applyLook } from './themes';
import { offerUpdate } from './update';
import { offerCheckIn } from './checkin';
import { requireTerms } from './legal';
import { decodeRecord, type GameRecord } from '../engine';
import { linkPayload } from './replay';
import { bootReviews, setGame } from './reviewQueue';
import { prefetchAtIdle, screens, setScreen, show } from './lazy';
import type { RoomLink } from '../net/client';

const W = 390;
const H = 844;

export function mountApp(root: HTMLElement) {
  applyLook();
  root.insertAdjacentHTML('beforeend', globalDefs());
  const safe = document.createElement('div');
  safe.className = 'safe';
  const stage = document.createElement('div');
  stage.className = 'stage';
  safe.appendChild(stage);
  root.appendChild(safe);
  const fit = () => (stage.style.transform = `translate(-50%, -50%) scale(${Math.min(safe.clientWidth / W, safe.clientHeight / H)})`);
  fit();
  new ResizeObserver(fit).observe(safe);

  let count: 2 | 3 | 4 = 4;
  let game: GameScreen | null = null;
  const home = async () => {
    game = null;
    setGame('none');
    const [saved, log] = await Promise.all([loadGame(), loadPuzzleLog()]);
    if (game) return; // a game started while the save was loading
    const screen = homeScreen(count, (n) => (count = n), setup, saved, () => saved && play(saved.config, saved), () => void show(stage, screens.store, (m) => m.storeScreen(() => void home()), () => void home()), (rec) => void watch(rec, () => void home()), (rec) => void review(rec, () => void home()), puzzleBadge(log === 'error' ? null : log), () => void puzzle(), (rejoin) => void online(rejoin));
    setScreen(stage, screen);
    // On the home screen only, never during a game: the Privacy note and Terms of use until they're accepted
    // (#208: first launch, and again when they change), then a newer version on the site, then today's check-in.
    void requireTerms(screen)
      .then(() => offerUpdate(screen))
      .then(() => offerCheckIn(screen));
  };
  // Home -> setup (houses, roll for order, pick houses) -> game. Play again keeps the same houses.
  const setup = (mode: Mode, houses: 1 | 2 = 1) =>
    setScreen(stage, setupScreen(mode, count, (cfg) => play(cfg), () => void home(), houses, () => {
      // From 4 players vs Computer: you and one bot with two colours each.
      count = 2;
      setup(mode, 2);
    }));
  /** The daily puzzle (#99): the screen and the pool load together; its log is read fresh each time. */
  const puzzle = () =>
    void show(stage, () => Promise.all([screens.puzzle(), loadPuzzleLog()]), ([m, log]) => m.puzzleScreen(m.pool, log, () => void home()), () => void home());
  /** The replay of `rec`; `back` returns to where it was opened from. With a stored review it opens in review mode. */
  // `keep`: the game is one of the past games, so its review is stored (not for a game from a link).
  const storedReview = async (rec: GameRecord, keep: boolean) =>
    keep ? await loadReview(rec) : undefined;
  const watch = async (rec: GameRecord, back: () => void, keep = true, startAt?: number, startCaption?: string, pov?: number) => {
    const stored = await storedReview(rec, keep);
    await show(stage, screens.replay, (m) => m.safeReplayScreen(rec, back, { startAt, startCaption, pov, keep, review: stored, onReview: (p) => void review(rec, back, keep, p) }), back);
  };
  /** The game review of `rec` (it runs in the review queue); a tapped move opens the replay there, from the same side. */
  const review = async (rec: GameRecord, back: () => void, keep = true, pov?: number) => {
    const stored = await storedReview(rec, keep);
    await show(stage, screens.review, (m) => m.reviewScreen(rec, stored, back, (at, caption, p) => void watch(rec, () => void review(rec, back, keep, p), keep, at, caption, p), keep, pov), back);
  };
  /** Play online: the private-room screens, then the room's game (the server plays it; this screen shows it). */
  const online = async (rejoin = false) => {
    await show(stage, screens.online, (m) => m.onlineScreen(playOnline, () => void home(), rejoin), () => void home());
  };
  const playOnline = (link: RoomLink, cfg: GameConfig) => {
    if (game && stage.contains(game.el)) game.dispose();
    const toResult = () => setScreen(stage, g.el);
    // Play again: a new room (the old one is over).
    const g = new GameScreen(cfg, (to) => (to === 'home' ? void home() : to === 'replay' ? g.finalRecord && void watch(g.finalRecord, toResult) : to === 'review' ? g.finalRecord && void review(g.finalRecord, toResult) : void online()), undefined, undefined, link);
    game = g;
    setScreen(stage, g.el);
    setGame('light');
    if (import.meta.env.DEV) (window as unknown as { __ludo: GameScreen }).__ludo = g;
  };
  // Set while a game starts, so a double tap on Start or Play again can't open two games.
  let starting = false;
  const play = async (cfg: GameConfig, saved?: SavedGame) => {
    if (starting) return;
    starting = true;
    try {
      // A new game replaces any saved one (counted as a loss when it's given up past the first round); a
      // continued game picks up from it.
      if (!saved) await giveUpSaved();
      const toResult = () => setScreen(stage, g.el);
      const g = new GameScreen(cfg, (to) => (to === 'home' ? void home() : to === 'replay' ? g.finalRecord && void watch(g.finalRecord, toResult) : to === 'review' ? g.finalRecord && void review(g.finalRecord, toResult) : play(cfg)), undefined, saved);
      game = g;
      setScreen(stage, game.el);
      // Reviews keep going during a game, except vs Extreme, whose bots think with the rollout engine.
      setGame(cfg.seats.some((s) => s.bot && s.level === 'extreme') ? 'extreme' : 'light');
      if (import.meta.env.DEV) (window as unknown as { __ludo: GameScreen }).__ludo = game;
    } finally {
      starting = false;
    }
  };

  // Back: an open sheet closes; in a game it pauses and resumes; in setup it goes a step back; on the
  // home screen the update prompt or the check-in card closes, and after that the app closes.
  handleBack(() => {
    // The top one: a text opened over Settings (#208) closes before Settings.
    const sheet = [...stage.querySelectorAll('.sheet')].at(-1);
    if (sheet) {
      sheet.remove();
      return true;
    }
    if (game && stage.contains(game.el)) return game.back();
    // The update prompt and the check-in card: Back is "Not now" / "Later".
    const later = stage.querySelector<HTMLElement>('.menu-ov [data-act=later]');
    if (later) {
      later.click();
      return true;
    }
    const back = stage.querySelector<HTMLElement>('[data-act=back]');
    if (back) {
      back.click();
      return true;
    }
    return false;
  });
  // A shared game's link (web): straight into its replay, or a friendly screen if it can't be opened. Also
  // for a link pasted into a tab that already has the game open.
  const openLink = () => {
    const payload = linkPayload(location.hash);
    const bench = location.hash === '#bench';
    if (payload === null && !bench) return false;
    // A game in progress stops here; it was saved at the start of its turn, so Continue picks it up.
    if (game && stage.contains(game.el)) game.dispose();
    game = null;
    const leave = () => {
      history.replaceState(null, '', location.pathname + location.search);
      void home();
    };
    // The hidden Extreme speed test (#62), for timing a real phone.
    if (bench) void show(stage, screens.bench, (m) => m.benchScreen(leave), leave);
    else void decodeRecord(payload!).then((rec) => (rec ? void watch(rec, leave, false) : void show(stage, screens.replay, (m) => m.safeReplayScreen(null, leave), leave)));
    return true;
  };
  addEventListener('hashchange', () => void openLink());
  if (!openLink()) void home();
  // The newest unreviewed past games are reviewed while the app is open (#96).
  void bootReviews();
  // The lazily loaded screens, fetched at idle so a web session that started online also works offline (#98).
  prefetchAtIdle();
}
