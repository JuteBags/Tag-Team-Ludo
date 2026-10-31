// Game screen: runs the turn loop, drives bots, and takes people's taps. In "With friends" every seat is
// a person passing the device; a person with two houses plays both colours' turns.
import { FINISHED, chooseMove, createGame, cryptoRng, isDone, move, ownerRanking, roll, type Color, type GameState, type Move, type Rng } from '../engine';
import { PROFILES, avatarSVG, confettiHTML, cssVars, icons, medalSVG, pawnSVG, ribbonSVG, starBadge, trophySVG, twinsSVG } from './art';
import { BoardView } from './boardView';
import { playCutscene } from './palace';
import { dieMarkup, rollDie } from './dice';
import { saveSetting, settings } from './settings';
import { sfx } from './sfx';
import type { GameConfig } from './setup';
import { keepAwake } from './native';
import { drawCard, shareCard } from './shareCard';
import { clearGame, recordGame, saveGame, type SavedGame } from './store';
import { moveTargets, whyStuck, type Target } from './targets';

const SEAT_CLASS: Record<Color, string> = { blue: 'bl', green: 'tl', red: 'tr', yellow: 'br' };
const DIE = 38;
const ROLL_MS = 1150;
const PLACES = ['', '1ST', '2ND', '3RD', '4TH'];
const ORD = ['', '1st', '2nd', '3rd', '4th'];
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
  /** The person whose turn it was last, to announce a hand-over in "With friends". */
  private lastOwner = -1;
  /** This game's kills and pairs formed by the person playing vs Computer, for the stats. */
  private kills = 0;
  private pairs = 0;
  /** The players still in voted to stop: the game ends with the places as they stand. */
  private ended = false;
  /** Pauses the game and saves it when the app goes to the background. */
  private onHidden = () => {
    if (document.visibilityState !== 'hidden' || this.disposed) return;
    this.save();
    if (!this.el.querySelector('.cs, .vote')) this.openMenu();
  };

  /** Starts a game from `config`, or picks up `saved`. */
  constructor(readonly config: GameConfig, private exit: (to: Exit) => void, private rng: Rng = cryptoRng, saved?: SavedGame) {
    this.state = saved?.state ?? createGame(config.seats, config.first, config.singles);
    this.kills = saved?.kills ?? 0;
    this.pairs = saved?.pairs ?? 0;
    for (const [c, f] of saved?.faces ?? []) this.lastFace.set(c, f);
    const people = config.names.length;
    this.el.className = 'screen game';
    this.el.innerHTML = `
      <div class="gtop"><button class="rbtn" data-act="menu" aria-label="Menu">${icons.menu}</button>
        <div class="mode"><small>${config.mode === 'pvp' ? 'WITH FRIENDS' : 'VS COMPUTER'}${this.state.singles ? ' · NO DOUBLES' : ''}</small><b>${people} PLAYERS</b></div><span class="rbtn-space"></span></div>
      ${this.state.players.map((p) => this.panelHTML(p.color, p.bot)).join('')}
      <div class="gboard"></div>
      <div class="hint"><span class="tw"></span><span><b></b><small></small></span></div>
      <div class="toasts"></div>`;
    this.view = new BoardView(this.state.players, 370, this.state.players.filter((p) => !p.bot).map((p) => p.color), !!this.state.singles);
    this.el.querySelector('.gboard')!.appendChild(this.view.el);
    this.el.querySelector('[data-act=menu]')!.addEventListener('click', () => this.openMenu());
    // A continued game shows the dice as they were.
    for (const [c, f] of this.lastFace) this.diceBox(c).innerHTML = dieMarkup(f, DIE);
    keepAwake(true);
    document.addEventListener('visibilitychange', this.onHidden);
    void this.run();
  }

  /** Saves the game so it can be continued after the app closes. Done at the start of every turn. */
  private save() {
    if (this.disposed || this.ended || this.state.phase !== 'roll') return;
    void saveGame({ v: 1, config: this.config, state: this.state, kills: this.kills, pairs: this.pairs, faces: [...this.lastFace], savedAt: Date.now() });
  }

  /** The Android back button: skip a cutscene, close the pause menu, leave the result, or pause. */
  back(): boolean {
    const cs = this.el.querySelector<HTMLElement>('.cs');
    if (cs) cs.click();
    else if (this.el.querySelector('.vote')) {
      // The vote needs an answer.
    } else if (this.el.querySelector('.result')) this.exit('home');
    else if (this.el.querySelector('.menu-ov')) {
      this.el.querySelector('.menu-ov')!.remove();
      this.resume();
    } else this.openMenu();
    return true;
  }

  private panelHTML(c: Color, bot: boolean) {
    return `<div class="pl ${SEAT_CLASS[c]} idle" data-c="${c}" style="${cssVars(c)}">
      <div class="who"><div class="av">${avatarSVG(c)}</div><span class="nm">${this.name(c)}</span>${bot ? '<span class="bot">BOT</span>' : ''}<span class="ptr"></span></div>
      <button class="dbox" aria-label="Roll dice">${dieMarkup(6, DIE)}</button></div>`;
  }

  // ---------- turn loop ----------
  private get cur() {
    return this.state.players[this.state.current]!;
  }

  private ownerOf(c: Color) {
    return this.state.players.find((p) => p.color === c)!.owner;
  }

  /** The person's name for a colour. */
  private name(c: Color) {
    return this.config.names[this.ownerOf(c)] ?? PROFILES[c].name;
  }

  /** vs Computer ends for you once all your houses are home; With friends plays on to the last place. */
  private humanDone() {
    if (this.config.mode === 'pvp') return false;
    const mine = this.state.players.filter((p) => !p.bot);
    return mine.length > 0 && mine.every((p) => p.tokens.every((t) => t === FINISHED));
  }

  private async run() {
    await this.sleep(400);
    while (!this.disposed && !this.ended && this.state.phase !== 'over' && !this.humanDone()) {
      this.save();
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
    this.setHint(c, `${this.name(c)} is playing…`, 'Bot turn');
    await this.sleep(380);
    if (this.disposed) return;
    await this.doRoll(c);
    if (this.disposed || this.state.phase !== 'move') return;
    await this.sleep(320);
    if (this.disposed) return;
    await this.doMove(chooseMove(this.state, this.rng));
  }

  private async humanTurn(c: Color) {
    const pvp = this.config.mode === 'pvp';
    // Passing the device: announce whose turn it is when it changes hands.
    if (pvp && this.ownerOf(c) !== this.lastOwner) this.toast(`${this.name(c)}'s turn`, c, 'turn');
    this.lastOwner = this.ownerOf(c);
    this.setHint(c, pvp ? `${this.name(c)}'s turn` : 'Your turn', 'Tap the dice to roll');
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
    const who = this.config.mode === 'pvp' ? this.name(c) : 'You';
    if (targets.some((t) => t.move.kind === 'pair')) this.setHint(c, `Pair move! ${who} rolled ${d}`, `Pair moves ${d / 2} + ${d / 2}. Tap a token or where it lands`, true);
    else this.setHint(c, `${who} rolled ${d}`, 'Tap a token, or the spot where it lands');
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
    const doneBefore = this.doneOwners();
    this.state = move(this.state, m);
    await this.view.animateMove(m, this.state.players, this.speed);
    const ev = this.state.event;
    const extra = ev?.type === 'moved' && ev.extraTurn;
    const player = this.state.players.find((p) => p.color === m.color)!;
    const human = !player.bot;
    if (m.captures.length) this.toast(m.captures.length > 1 ? 'DOUBLE KILL!' : 'KILL!', m.color, 'kill');
    // A person's token reaching home is welcomed into the palace; a bot's just gets the banner.
    else if (m.finishes && human) await playCutscene(this.el, m.color, player.tokens, this.speed);
    else if (m.finishes) this.toast('HOME!', m.color, 'home');
    if (extra && human) this.toast('Roll again', m.color);
    if (human && this.config.mode === 'pvc') this.count(m);
    // Someone just finished: the people still playing decide whether to play on for the next place.
    const fresh = this.doneOwners().filter((o) => !doneBefore.includes(o));
    if (fresh.length && this.state.phase !== 'over' && !this.humanDone()) {
      const voters = [...new Set(this.state.players.filter((p) => !p.bot && !isDone(p)).map((p) => p.owner))].filter((o) => !this.doneOwners().includes(o));
      // Only bots left: nobody is watching for the rest of the places.
      if (!voters.length || !(await this.vote(fresh[0]!, this.doneOwners().length, voters))) this.ended = true;
    }
  }

  /** People with every one of their colours home. */
  private doneOwners() {
    const owners = [...new Set(this.state.players.map((p) => p.owner))];
    return owners.filter((o) => this.state.players.filter((p) => p.owner === o).every(isDone));
  }

  /** Stats for the person playing vs Computer: kills, and pairs formed by landing on their own token. */
  private count(m: Move) {
    this.kills += m.captures.length;
    const tokens = this.state.players.find((p) => p.color === m.color)!.tokens;
    if (!this.state.singles && m.kind !== 'pair' && m.to >= 0 && m.to <= 50 && tokens.filter((t) => t === m.to).length === 2) this.pairs++;
  }

  /**
   * Asks the people still playing whether to play on now that `owner` finished in `place`. Everyone
   * has to agree to play on: one "stop" ends the game with the places as they stand. Bots always play on.
   */
  private vote(owner: number, place: number, voters: number[]): Promise<boolean> {
    return new Promise((resolve) => {
      const c = this.state.players.find((p) => p.owner === owner)!.color;
      const next = ORD[place + 1]!;
      const one = voters.length === 1;
      const ov = document.createElement('div');
      ov.className = 'menu-ov vote';
      const who = (o: number) => this.state.players.find((p) => p.owner === o)!.color;
      ov.innerHTML = `<div class="box"><div class="vav" style="${cssVars(c)}">${avatarSVG(c)}<span class="medal m${place}">${place}</span></div>
        <h2>${this.config.names[owner]} finished ${ORD[place]}!</h2>
        <p class="sub">${one ? `Keep playing for ${next} place?` : `Keep playing for ${next} place? Everyone still playing has to agree.`}</p>
        ${one
          ? `<button class="b3 green disp" data-o="${voters[0]}" data-v="yes">KEEP PLAYING</button><button class="b3 blue disp" data-o="${voters[0]}" data-v="no">END GAME</button>`
          : voters.map((o) => `<div class="vrow" data-o="${o}"><span class="ra" style="${cssVars(who(o))}">${avatarSVG(who(o))}</span><b>${this.config.names[o]}</b>
              <button data-o="${o}" data-v="yes">Play on</button><button data-o="${o}" data-v="no">Stop</button></div>`).join('')}</div>`;
      const yes = new Set<number>();
      ov.addEventListener('click', (e) => {
        const b = (e.target as Element).closest<HTMLButtonElement>('button[data-v]');
        if (!b) return;
        sfx.tick();
        const o = Number(b.dataset.o);
        const done = (go: boolean) => {
          ov.remove();
          if (!go) this.toast('Game over by vote', c);
          resolve(go);
        };
        if (b.dataset.v === 'no') return done(false);
        yes.add(o);
        ov.querySelector(`.vrow[data-o="${o}"]`)?.classList.add('agreed');
        if (voters.every((v) => yes.has(v))) setTimeout(() => done(true), one ? 0 : 450);
      });
      this.el.appendChild(ov);
    });
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
        (pawn) => this.setHint(c, "That token can't move", whyStuck(this.state.players, c, Number(pawn.slice(c.length)), this.state.dice!, (o) => this.name(o), this.state.singles)),
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
  private toast(text: string, c: Color, kind: 'kill' | 'six' | 'home' | 'bust' | 'turn' | '' = '') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.setAttribute('style', cssVars(c));
    t.textContent = text;
    this.el.querySelector('.toasts')!.appendChild(t);
    const big = kind === 'kill' || kind === 'six' || kind === 'home' || kind === 'turn';
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
        // Quitting gives the game up: there's nothing to continue.
        this.dispose();
        void clearGame();
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
    keepAwake(false);
    document.removeEventListener('visibilitychange', this.onHidden);
    this.resume();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((r) => setTimeout(r, ms / this.speed)).then(
      () => new Promise<void>((r) => (this.paused ? this.waiting.push(r) : r())),
    );
  }

  // ---------- result ----------
  private showResult() {
    this.dispose();
    void clearGame();
    const order = ownerRanking(this.state);
    const pvp = this.config.mode === 'pvp';
    const colorsOf = (o: number) => this.state.players.filter((p) => p.owner === o);
    const human = this.state.players.find((p) => !p.bot)?.owner ?? 0;
    const place = order.indexOf(human) + 1;
    const won = pvp || place === 1;
    const rows = order
      .map((o, i) => {
        const mine = colorsOf(o);
        const c = mine[0]!.color;
        const bot = mine[0]!.bot;
        const sub = i === 0 ? 'Winner' : bot ? 'Bot' : pvp ? `${PLACES[i + 1]!.toLowerCase()} place` : 'You';
        const home = mine.reduce((a, p) => a + p.tokens.filter((t) => t === FINISHED).length, 0);
        return `<div class="row${i === 0 ? ' first' : ''}${bot ? '' : ' me'}"><span class="medal m${i + 1}">${i + 1}</span>
          <span class="ra" style="${cssVars(c)}">${avatarSVG(c)}</span><span class="rn"><b>${this.config.names[o]}</b><small>${sub}</small></span>
          <span class="rv">${home} / ${4 * mine.length} home</span></div>`;
      })
      .join('');
    const winner = this.config.names[order[0]!]!;
    const title = pvp ? `${winner.toUpperCase()} WINS!` : won ? 'YOU WIN!' : `${PLACES[place]} PLACE`;
    void recordGame({ mode: this.config.mode, place, kills: this.kills, pairs: this.pairs });
    const card = order.map((o) => {
      const mine = colorsOf(o);
      const home = mine.reduce((a, p) => a + p.tokens.filter((t) => t === FINISHED).length, 0);
      return { name: this.config.names[o]!, color: mine[0]!.color, detail: `${home} / ${4 * mine.length} home` };
    });
    const ov = document.createElement('div');
    ov.className = `result${won ? ' won' : ''}`;
    ov.innerHTML = `<div class="dim"></div>${won ? `<div class="rays"></div><div class="tglow"></div>${confettiHTML()}` : ''}
      <div class="trophy">${won ? trophySVG() : medalSVG(place)}</div>
      ${won ? `<div class="stars">${starBadge('s0')}${starBadge('s1')}${starBadge('s2')}</div>` : ''}
      <div class="rescol"><div class="ribbon">${ribbonSVG()}<span class="disp">${title}</span></div>
        <div class="rank">${rows}</div>
        <div class="wbtns"><button class="b3 blue disp" data-act="home">HOME</button><button class="b3 green disp" data-act="again">PLAY AGAIN</button></div>
        <button class="sharebtn disp" data-act="share">${icons.share}SHARE RESULT</button></div>`;
    ov.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>('button');
      const act = btn?.dataset.act;
      if (act === 'home' || act === 'again') this.exit(act);
      if (act === 'share' && !btn!.disabled) {
        btn!.disabled = true;
        const text = pvp ? `${winner} won our game of Tag Team Ludo!` : won ? 'I won at Tag Team Ludo!' : `I came ${PLACES[place]!.toLowerCase()} at Tag Team Ludo!`;
        void drawCard(title, `${pvp ? 'WITH FRIENDS' : 'VS COMPUTER'} · ${order.length} PLAYERS`, card)
          .then((png) => shareCard(png, text))
          .catch(() => undefined)
          .finally(() => (btn!.disabled = false));
      }
    });
    this.el.appendChild(ov);
    if (won) sfx.win();
    ov.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350 });
    ov.querySelector('.trophy')!.animate([{ transform: 'scale(.3) rotate(-12deg)' }, { transform: 'scale(1.08)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 650, easing: 'cubic-bezier(.3,.8,.4,1.2)' });
  }
}
