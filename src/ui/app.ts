// App shell: a fixed 390 x 844 stage scaled to fit any screen, plus simple routing.
import { globalDefs } from './art';
import { GameScreen } from './gameScreen';
import { homeScreen } from './homeScreen';
import type { GameConfig, Mode } from './setup';
import { setupScreen } from './setupScreen';

const W = 390;
const H = 844;

export function mountApp(root: HTMLElement) {
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
  const home = () => stage.replaceChildren(homeScreen(count, (n) => (count = n), setup));
  // Home -> setup (houses, roll for order, pick houses) -> game. Play again keeps the same houses.
  const setup = (mode: Mode) => stage.replaceChildren(setupScreen(mode, count, play, home));
  const play = (cfg: GameConfig) => {
    const game = new GameScreen(cfg, (to) => (to === 'home' ? home() : play(cfg)));
    stage.replaceChildren(game.el);
    if (import.meta.env.DEV) (window as unknown as { __ludo: GameScreen }).__ludo = game;
  };
  home();
}
