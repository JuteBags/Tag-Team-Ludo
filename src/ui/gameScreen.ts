// Game screen: runs the turn loop, drives bots, and takes the human's taps.
import { BASE, chooseMove, cryptoRng, finalRanking, move, newGame, roll, tokensHome, type Color, type GameState, type Move, type Rng } from '../engine';
import { PROFILES, avatarSVG, confettiHTML, cssVars, icons, medalSVG, pawnSVG, ribbonSVG, starBadge, trophySVG, twinsSVG } from './art';
import { BoardView } from './boardView';
import { dieMarkup, rollDie } from './dice';

const SEAT_CLASS: Record<Color, string> = { blue: 'bl', green: 'tl', red: 'tr', yellow: 'br' };
const DIE = 38;
const ROLL_MS = 620;
const PLACES = ['', '1ST', '2ND', '3RD', '4TH'];

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
    this.view = new BoardView(this.state.players, 370);
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

    const moves = this.state.moves;
    const choices = new Set(moves.map((m) => (m.kind === 'release' ? 'release' : `${m.kind}:${m.from}`)));
    if (choices.size === 1) {
      await this.sleep(250);
      if (!this.disposed) await this.doMove(moves[0]!);
      return;
    }
    const d = this.state.dice!;
    if (moves.some((m) => m.kind === 'pair')) this.setHint(c, `Pair move! You rolled ${d}`, `Tap your pair to move both ${d / 2} + ${d / 2}, or move one token`, true);
    else this.setHint(c, `You rolled ${d}`, 'Tap a glowing token to move it');
    const m = await this.pickMove(c, moves);
    if (!this.disposed) await this.doMove(m);
  }

  private async doRoll(c: Color) {
    this.state = roll(this.state, this.rng, this.forced.shift());
    await rollDie(this.diceBox(c), this.state.dice!, DIE, ROLL_MS / this.speed);
    const ev = this.state.event;
    if (ev?.type === 'three-sixes') {
      this.toast('Three 6s! Turn lost', c);
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
    const what = m.captures.length ? 'Captured!' : m.finishes ? 'Home!' : '';
    const human = !this.state.players.find((p) => p.color === m.color)!.bot;
    const text = [what, extra && human ? 'Extra roll' : ''].filter(Boolean).join(' · ');
    if (text) this.toast(text, m.color);
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

  private pickMove(c: Color, moves: Move[]): Promise<Move> {
    const me = this.cur;
    const keys = new Set<string>();
    for (const m of moves) {
      if (m.kind === 'release') keys.add(c + m.tokens[0]);
      else me.tokens.forEach((t, i) => t === m.from && keys.add(c + i));
    }
    let choosing = false;
    return new Promise((resolve) => {
      this.view.setMovable([...keys], async (key) => {
        if (choosing || this.paused) return;
        const i = Number(key.slice(c.length));
        const t = me.tokens[i]!;
        const options = t === BASE ? moves.filter((m) => m.kind === 'release' && m.tokens[0] === i) : moves.filter((m) => m.kind !== 'release' && m.from === t);
        choosing = true;
        const m = options.length === 1 ? options[0] : await this.choose(c, options);
        choosing = false;
        if (m) {
          this.view.clearMovable();
          resolve(m);
        }
      });
    });
  }

  /** Single token or pair from the same square. */
  private choose(c: Color, options: Move[]): Promise<Move | null> {
    const single = options.find((m) => m.kind === 'single');
    const pair = options.find((m) => m.kind === 'pair');
    const ov = document.createElement('div');
    ov.className = 'chooser';
    ov.innerHTML = `<div class="box">
      ${single ? `<button data-k="single">${pawnSVG(c)}<b>Move one</b><small>+${single.steps} steps</small></button>` : ''}
      ${pair ? `<button class="pr" data-k="pair">${twinsSVG(c)}<b>Move pair</b><small>+${pair.steps} each</small></button>` : ''}</div>`;
    this.el.appendChild(ov);
    return new Promise((resolve) => {
      ov.addEventListener('click', (e) => {
        const b = (e.target as Element).closest('button');
        ov.remove();
        resolve(!b ? null : b.dataset.k === 'pair' ? pair! : single!);
      });
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

  private toast(text: string, c: Color) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('style', cssVars(c));
    t.textContent = text;
    this.el.querySelector('.toasts')!.appendChild(t);
    const a = t.animate(
      [
        { opacity: 0, transform: 'scale(.6) translateY(10px)' },
        { opacity: 1, transform: 'scale(1.06)', offset: 0.15 },
        { opacity: 1, transform: 'scale(1)', offset: 0.25 },
        { opacity: 1, transform: 'scale(1)', offset: 0.8 },
        { opacity: 0, transform: 'translateY(-16px)' },
      ],
      { duration: 1300 / this.speed, fill: 'forwards' },
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
    ov.innerHTML = `<div class="box"><h2>Paused</h2><button class="b3 green disp" data-act="resume">RESUME</button><button class="b3 blue disp" data-act="quit">QUIT TO HOME</button></div>`;
    ov.addEventListener('click', (e) => {
      const act = (e.target as Element).closest('button')?.dataset.act;
      if (act === 'resume') {
        ov.remove();
        this.resume();
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
    ov.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350 });
    ov.querySelector('.trophy')!.animate([{ transform: 'scale(.3) rotate(-12deg)' }, { transform: 'scale(1.08)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 650, easing: 'cubic-bezier(.3,.8,.4,1.2)' });
  }
}
