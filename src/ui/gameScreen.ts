// Game screen: runs the turn loop, drives bots, and takes the human's taps.
import { chooseMove, cryptoRng, finalRanking, move, newGame, roll, tokensHome, type Color, type GameState, type Move, type Rng } from '../engine';
import { PROFILES, avatarSVG, confettiHTML, cssVars, icons, medalSVG, pawnSVG, ribbonSVG, starBadge, trophySVG, twinsSVG } from './art';
import { BoardView } from './boardView';
import { dieMarkup, rollDie } from './dice';
import { saveSetting, settings } from './settings';
import { sfx } from './sfx';
import { moveTargets, whyStuck, type Target } from './targets';

const SEAT_CLASS: Record<Color, string> = { blue: 'bl', green: 'tl', red: 'tr', yellow: 'br' };
const DIE = 38;
const ROLL_MS = 1150;
const PLACES = ['', '1ST', '2ND', '3RD', '4TH'];
const faceLabel = () => (settings.diceFace === 'top' ? 'DICE: TOP FACE' : 'DICE: FRONT FACE');

export type Exit = 'home' | 'again';

export class GameScreen {
  readonly el = document.createElement('div');
  state: GameState;
  /** Dev/test hooks: queued dice faces and an animation speed multiplier. */
  forced: number[] = [];
  speed = 1;
  private view: BoardView;
  private paused = false;
  private waiting: (() => void)[] = [];
  private disposed = false;
  /** Last face each player rolled, to redraw the resting dice when the setting changes. */
  private lastFace = new Map<Color, number>();

  constructor(count: 2 | 3 | 4, private exit: (to: Exit) => void, private rng: Rng = cryptoRng) {
    this.state = newGame(count);
    this.el.className = 'screen game';
    this.el.innerHTML = `
      <div class="gtop"><button class="rbtn" data-act="menu" aria-label="Menu">${icons.menu}</button>
        <div class="mode"><small>CLASSIC</small><b>${count} PLAYERS</b></div><span class="rbtn-space"></span></div>
      ${this.state.players.map((p) => this.panelHTML(p.color, p.bot)).join('')}
      <div class="gboard"></div>
      <div class="hint"><span class="tw"></span><span><b></b><small></small></span></div>
      <div class="toasts"></div>`;
    this.view = new BoardView(this.state.players, 370, this.state.players.find((p) => !p.bot)?.color);
    this.el.querySelector('.gboard')!.appendChild(this.view.el);
    this.el.querySelector('[data-act=menu]')!.addEventListener('click', () => this.openMenu());
    void this.run();
  }

  private panelHTML(c: Color, bot: boolean) {
    return `<div class="pl ${SEAT_CLASS[c]} idle" data-c="${c}" style="${cssVars(c)}">
      <div class="who"><div class="av">${avatarSVG(c)}</div><span class="nm">${PROFILES[c].name}</span>${bot ? '<span class="bot">BOT</span>' : ''}<span class="ptr"></span></div>
      <button class="dbox" aria-label="Roll dice">${dieMarkup(6, DIE)}</button></div>`;
  }

  // ---------- turn loop ----------
  private get cur() {
    return this.state.players[this.state.current]!;
  }

  private humanDone() {
    return this.state.players.some((p) => !p.bot && this.state.ranking.includes(p.color));
  }

  private async run() {
    await this.sleep(400);
    while (!this.disposed && this.state.phase !== 'over' && !this.humanDone()) {
      const p = this.cur;
      this.markActive(p.color);
      if (p.bot) await this.botTurn(p.color);
      else await this.humanTurn(p.color);
    }
    if (this.disposed) return;
    this.markActive(null);
    await this.sleep(500);
    if (!this.disposed) this.showResult();
  }

  private async botTurn(c: Color) {
    this.setHint(c, `${PROFILES[c].name} is playing…`, 'Bot turn');
    await this.sleep(380);
    if (this.disposed) return;
    await this.doRoll(c);
    if (this.disposed || this.state.phase !== 'move') return;
    await this.sleep(320);
    if (this.disposed) return;
    await this.doMove(chooseMove(this.state, this.rng));
  }

  private async humanTurn(c: Color) {
    this.setHint(c, 'Your turn', 'Tap the dice to roll');
    await this.waitRollTap(c);
    if (this.disposed) return;
    await this.doRoll(c);
    if (this.disposed || this.state.phase !== 'move') return;

    const targets = moveTargets(this.state.players, this.state.moves);
    if (targets.length === 1) {
      await this.sleep(250);
      if (!this.disposed) await this.doMove(targets[0]!.move);
      return;
    }
    const d = this.state.dice!;
    if (targets.some((t) => t.move.kind === 'pair')) this.setHint(c, `Pair move! You rolled ${d}`, `Pair moves ${d / 2} + ${d / 2}. Tap a token or where it lands`, true);
    else this.setHint(c, `You rolled ${d}`, 'Tap a token, or the spot where it lands');
    const m = await this.pickMove(c, targets);
    if (!this.disposed) await this.doMove(m);
  }

  private async doRoll(c: Color) {
    this.state = roll(this.state, this.rng, this.forced.shift());
    const box = this.diceBox(c);
    await rollDie(box, this.state.dice!, DIE, ROLL_MS / this.speed);
    this.lastFace.set(c, this.state.dice!);
    const ev = this.state.event;
    if (this.state.dice === 6 && ev?.type !== 'three-sixes') {
      box.classList.remove('six');
      void box.offsetWidth; // restart the flare animation
      box.classList.add('six');
      this.toast('SIX!', c, 'six');
    }
    if (ev?.type === 'three-sixes') {
      sfx.bust();
      this.toast('Three 6s! Turn lost', c, 'bust');
      await this.sleep(800);
    } else if (ev?.type === 'no-move') {
      this.toast(ev.dice === 6 ? 'No moves · roll again' : 'No moves', c);
      await this.sleep(700);
    }
  }

  private async doMove(m: Move) {
    this.state = move(this.state, m);
    await this.view.animateMove(m, this.state.players, this.speed);
    const ev = this.state.event;
    const extra = ev?.type === 'moved' && ev.extraTurn;
    const human = !this.state.players.find((p) => p.color === m.color)!.bot;
    if (m.captures.length) this.toast(m.captures.length > 1 ? 'DOUBLE KILL!' : 'KILL!', m.color, 'kill');
    else if (m.finishes) this.toast('HOME!', m.color, 'home');
    if (extra && human) this.toast('Roll again', m.color);
  }

  // ---------- human input ----------
  private waitRollTap(c: Color): Promise<void> {
    const box = this.diceBox(c);
    box.classList.add('can-roll');
    return new Promise((done) => {
      const on = () => {
        if (this.paused) return;
        box.removeEventListener('click', on);
        box.classList.remove('can-roll');
        done();
      };
      box.addEventListener('click', on);
    });
  }

  /** Landing markers on the board; a pair on a star shows "pair" and "one token" as two markers. */
  private pickMove(c: Color, targets: Target[]): Promise<Move> {
    return new Promise((resolve) => {
      this.view.showTargets(
        targets,
        (t) => resolve(t.move),
        (own) => {
          const pair = own.find((t) => t.move.kind === 'pair');
          const one = own.find((t) => t.move.kind === 'single');
          if (pair && one) this.setHint(c, 'Pair or one token?', `Tap a spot: pair moves ${pair.move.steps} + ${pair.move.steps}, one token moves ${one.move.steps}`, true);
        },
        (pawn) => this.setHint(c, "That token can't move", whyStuck(this.state.players, c, Number(pawn.slice(c.length)), this.state.dice!, (o) => PROFILES[o].name)),
      );
    });
  }

  // ---------- UI bits ----------
  private diceBox(c: Color) {
    return this.el.querySelector<HTMLElement>(`.pl[data-c=${c}] .dbox`)!;
  }

  private markActive(c: Color | null) {
    this.el.querySelectorAll<HTMLElement>('.pl').forEach((pl) => {
      const on = pl.dataset.c === c;
      pl.classList.toggle('active', on);
      pl.classList.toggle('idle', !on);
    });
  }

  private setHint(c: Color, title: string, sub: string, pair = false) {
    const h = this.el.querySelector('.hint')!;
    h.querySelector('.tw')!.innerHTML = pair ? twinsSVG(c) : pawnSVG(c);
    h.querySelector('b')!.textContent = title;
    h.querySelector('small')!.textContent = sub;
  }

  /** A banner over the board. Big moments (kill, six, home) slam in larger and tilted. */
  private toast(text: string, c: Color, kind: 'kill' | 'six' | 'home' | 'bust' | '' = '') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.setAttribute('style', cssVars(c));
    t.textContent = text;
    this.el.querySelector('.toasts')!.appendChild(t);
    const big = kind === 'kill' || kind === 'six' || kind === 'home';
    const tilt = kind === 'kill' ? -6 : 0;
    const a = t.animate(
      big
        ? [
            { opacity: 0, transform: `scale(2.6) rotate(${tilt * 2}deg)` },
            { opacity: 1, transform: `scale(.92) rotate(${tilt}deg)`, offset: 0.12 },
            { opacity: 1, transform: `scale(1.06) rotate(${tilt}deg)`, offset: 0.2 },
            { opacity: 1, transform: `scale(1) rotate(${tilt}deg)`, offset: 0.78 },
            { opacity: 0, transform: `scale(1.1) translateY(-22px) rotate(${tilt}deg)` },
          ]
        : [
            { opacity: 0, transform: 'scale(.6) translateY(10px)' },
            { opacity: 1, transform: 'scale(1.06)', offset: 0.15 },
            { opacity: 1, transform: 'scale(1)', offset: 0.25 },
            { opacity: 1, transform: 'scale(1)', offset: 0.8 },
            { opacity: 0, transform: 'translateY(-16px)' },
          ],
      { duration: (big ? 1250 : 1300) / this.speed, fill: 'forwards', easing: big ? 'cubic-bezier(.16,1,.3,1)' : 'ease' },
    );
    void a.finished.finally(() => t.remove());
    setTimeout(() => t.remove(), 1400 / this.speed);
  }

  // ---------- pause / exit ----------
  private openMenu() {
    if (this.paused || this.disposed) return;
    this.paused = true;
    const ov = document.createElement('div');
    ov.className = 'menu-ov';
    ov.innerHTML = `<div class="box"><h2>Paused</h2><button class="b3 green disp" data-act="resume">RESUME</button><button class="b3 blue disp" data-act="face">${faceLabel()}</button><button class="b3 blue disp" data-act="sound">${sfx.muted ? 'SOUND: OFF' : 'SOUND: ON'}</button><button class="b3 blue disp" data-act="quit">QUIT TO HOME</button></div>`;
    ov.addEventListener('click', (e) => {
      const act = (e.target as Element).closest('button')?.dataset.act;
      if (act === 'resume') {
        ov.remove();
        this.resume();
      } else if (act === 'face') {
        saveSetting('diceFace', settings.diceFace === 'top' ? 'front' : 'top');
        (e.target as Element).closest('button')!.textContent = faceLabel();
        // Redraw the resting dice with the new counting face.
        this.el.querySelectorAll<HTMLElement>('.pl').forEach((pl) => {
          const box = pl.querySelector<HTMLElement>('.dbox')!;
          box.innerHTML = dieMarkup(this.lastFace.get(pl.dataset.c as Color) ?? 6, DIE);
        });
      } else if (act === 'sound') {
        sfx.setMuted(!sfx.muted);
        (e.target as Element).closest('button')!.textContent = sfx.muted ? 'SOUND: OFF' : 'SOUND: ON';
      } else if (act === 'quit') {
        this.dispose();
        this.exit('home');
      }
    });
    this.el.appendChild(ov);
  }

  private resume() {
    this.paused = false;
    this.waiting.splice(0).forEach((w) => w());
  }

  dispose() {
    this.disposed = true;
    this.resume();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((r) => setTimeout(r, ms / this.speed)).then(
      () => new Promise<void>((r) => (this.paused ? this.waiting.push(r) : r())),
    );
  }

  // ---------- result ----------
  private showResult() {
    this.disposed = true;
    const order = finalRanking(this.state);
    const human = this.state.players.find((p) => !p.bot)!.color;
    const place = order.indexOf(human) + 1;
    const won = place === 1;
    const rows = order
      .map((c, i) => {
        const p = this.state.players.find((x) => x.color === c)!;
        const sub = i === 0 ? 'Winner' : p.bot ? 'Bot' : 'You';
        return `<div class="row${i === 0 ? ' first' : ''}${p.bot ? '' : ' me'}"><span class="medal m${i + 1}">${i + 1}</span>
          <span class="ra" style="${cssVars(c)}">${avatarSVG(c)}</span><span class="rn"><b>${PROFILES[c].name}</b><small>${sub}</small></span>
          <span class="rv">${tokensHome(this.state, c)} / 4 home</span></div>`;
      })
      .join('');
    const ov = document.createElement('div');
    ov.className = `result${won ? ' won' : ''}`;
    ov.innerHTML = `<div class="dim"></div>${won ? `<div class="rays"></div><div class="tglow"></div>${confettiHTML()}` : ''}
      <div class="trophy">${won ? trophySVG() : medalSVG(place)}</div>
      ${won ? `<div class="stars">${starBadge('s0')}${starBadge('s1')}${starBadge('s2')}</div>` : ''}
      <div class="rescol"><div class="ribbon">${ribbonSVG()}<span class="disp">${won ? 'YOU WIN!' : `${PLACES[place]} PLACE`}</span></div>
        <div class="rank">${rows}</div>
        <div class="wbtns"><button class="b3 blue disp" data-act="home">HOME</button><button class="b3 green disp" data-act="again">PLAY AGAIN</button></div></div>`;
    ov.addEventListener('click', (e) => {
      const act = (e.target as Element).closest('button')?.dataset.act;
      if (act === 'home' || act === 'again') this.exit(act);
    });
    this.el.appendChild(ov);
    if (won) sfx.win();
    ov.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350 });
    ov.querySelector('.trophy')!.animate([{ transform: 'scale(.3) rotate(-12deg)' }, { transform: 'scale(1.08)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 650, easing: 'cubic-bezier(.3,.8,.4,1.2)' });
  }
}
