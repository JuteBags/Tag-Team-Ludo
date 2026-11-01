// App shell: a fixed 390 x 844 stage scaled to fit any screen, plus simple routing.
import { globalDefs } from './art';
import { GameScreen } from './gameScreen';
import { homeScreen } from './homeScreen';
import { handleBack } from './native';
import type { GameConfig, Mode } from './setup';
import { setupScreen } from './setupScreen';
import { storeScreen } from './storeScreen';
import { giveUpSaved, loadGame, loadPastGames, type SavedGame } from './store';
import { applyLook } from './themes';
import { offerUpdate } from './update';
import { offerCheckIn } from './checkin';
import { decodeRecord, type GameRecord } from '../engine';
import { linkPayload } from './replay';
import { safeReplayScreen } from './replayScreen';
import { reviewScreen } from './reviewScreen';

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
    const saved = await loadGame();
    if (game) return; // a game started while the save was loading
    const screen = homeScreen(count, (n) => (count = n), setup, saved, () => saved && play(saved.config, saved), () => stage.replaceChildren(storeScreen(() => void home())), (rec) => watch(rec, () => void home()));
    stage.replaceChildren(screen);
    // On the home screen only, never during a game: a newer version on the site, then today's check-in.
    void offerUpdate(screen).then(() => offerCheckIn(screen));
  };
  // Home -> setup (houses, roll for order, pick houses) -> game. Play again keeps the same houses.
  const setup = (mode: Mode, houses: 1 | 2 = 1) =>
    stage.replaceChildren(setupScreen(mode, count, (cfg) => play(cfg), () => void home(), houses, () => {
      // From 4 players vs Computer: you and one bot with two colours each.
      count = 2;
      setup(mode, 2);
    }));
  /** The replay of `rec`; `back` returns to where it was opened from. */
  // `keep`: the game is one of the past games, so its review is stored (not for a game from a link).
  const watch = (rec: GameRecord, back: () => void, keep = true, startAt?: number) =>
    stage.replaceChildren(safeReplayScreen(rec, back, { startAt, onReview: () => void review(rec, back, keep) }));
  /** The game review of `rec`, picking up a stored one; a tapped move opens the replay there. */
  const review = async (rec: GameRecord, back: () => void, keep = true) => {
    const stored = keep ? (await loadPastGames()).find((g) => g.rec.events === rec.events && g.rec.first === rec.first)?.review : undefined;
    const screen = reviewScreen(rec, stored, back, (at) => watch(rec, () => void review(rec, back, keep), keep, at), keep);
    stage.replaceChildren(screen);
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
      const toResult = () => stage.replaceChildren(g.el);
      const g = new GameScreen(cfg, (to) => (to === 'home' ? void home() : to === 'replay' ? g.finalRecord && watch(g.finalRecord, toResult) : to === 'review' ? g.finalRecord && void review(g.finalRecord, toResult) : play(cfg)), undefined, saved);
      game = g;
      stage.replaceChildren(game.el);
      if (import.meta.env.DEV) (window as unknown as { __ludo: GameScreen }).__ludo = game;
    } finally {
      starting = false;
    }
  };

  // Back: an open sheet closes; in a game it pauses and resumes; in setup it goes a step back; on the
  // home screen the update prompt or the check-in card closes, and after that the app closes.
  handleBack(() => {
    const sheet = stage.querySelector('.sheet');
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
    if (payload === null) return false;
    // A game in progress stops here; it was saved at the start of its turn, so Continue picks it up.
    if (game && stage.contains(game.el)) game.dispose();
    game = null;
    const leave = () => {
      history.replaceState(null, '', location.pathname + location.search);
      void home();
    };
    void decodeRecord(payload).then((rec) => (rec ? watch(rec, leave, false) : stage.replaceChildren(safeReplayScreen(null, leave))));
    return true;
  };
  addEventListener('hashchange', () => void openLink());
  if (!openLink()) void home();
}
