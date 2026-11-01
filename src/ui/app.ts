// App shell: a fixed 390 x 844 stage scaled to fit any screen, plus simple routing.
import { globalDefs } from './art';
import { GameScreen } from './gameScreen';
import { homeScreen } from './homeScreen';
import { handleBack } from './native';
import type { GameConfig, Mode } from './setup';
import { setupScreen } from './setupScreen';
import { storeScreen } from './storeScreen';
import { clearGame, loadGame, type SavedGame } from './store';
import { applyLook } from './themes';
import { offerUpdate } from './update';
import { offerCheckIn } from './checkin';

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
    const screen = homeScreen(count, (n) => (count = n), setup, saved, () => saved && play(saved.config, saved), () => stage.replaceChildren(storeScreen(() => void home())));
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
  const play = (cfg: GameConfig, saved?: SavedGame) => {
    // A new game replaces any saved one; a continued game picks up from it.
    if (!saved) void clearGame();
    game = new GameScreen(cfg, (to) => (to === 'home' ? void home() : play(cfg)), undefined, saved);
    stage.replaceChildren(game.el);
    if (import.meta.env.DEV) (window as unknown as { __ludo: GameScreen }).__ludo = game;
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
  void home();
}
