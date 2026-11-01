// Game screen: runs the turn loop, drives bots, and takes people's taps. In "With friends" every seat is
// a person passing the device; a person with two houses plays both colours' turns.
import { FINISHED, createGame, isDone, mixSeed, move, moveEvent, ownerRanking, positionKey, roll, rollEvent, seeded, type Color, type GameRecord, type GameState, type Move, type Rng, STOP_EVENT } from '../engine';
import { chooseBotMoveAsync } from '../engine/ai/levels';
import { PALETTE, PROFILES, avatarSVG, confettiHTML, cssVars, icons, medalSVG, pawnSVG, ribbonSVG, starBadge, symbolPath, trophySVG, twinsSVG } from './art';
import { BoardView } from './boardView';
import { playCutscene } from './palace';
import { dieMarkup, rollDie } from './dice';
import { saveSetting, settings } from './settings';
import { sfx } from './sfx';
import type { GameConfig } from './setup';
import { keepAwake } from './native';
import { drawCard, shareCard } from './shareCard';
import { clearGame, giveUpNote, givingUpLoses, layoutOf, levelOf, loadStats, recordGame, saveGame, savePastGame, type SavedGame } from './store';
import { choiceText, crowded, moveTargets, whyStuck, type Target } from './targets';
import { award, goldFor, newAchievements, nextStreak, total, type GameFacts } from './rewards';
import { earn, lockLabel, nextGoal } from './skins';

const SEAT_CLASS: Record<Color, string> = { blue: 'bl', green: 'tl', red: 'tr', yellow: 'br' };
const DIE = 38;
const ROLL_MS = 1150;
/** Bots roll quicker, so a 4-player game isn't mostly watching bot dice. */
const BOT_ROLL_MS = 700;
const PLACES = ['', '1ST', '2ND', '3RD', '4TH'];
const ORD = ['', '1st', '2nd', '3rd', '4th'];
const faceLabel = () => (settings.diceFace === 'top' ? 'DICE: TOP FACE' : 'DICE: FRONT FACE');
/** Pip spots on a 24-unit die face. */
const PIPS: Record<number, [number, number][]> = {
  1: [[12, 12]],
  2: [[7, 7], [17, 17]],
  3: [[7, 7], [12, 12], [17, 17]],
  4: [[7, 7], [17, 7], [7, 17], [17, 17]],
  5: [[7, 7], [17, 7], [12, 12], [7, 17], [17, 17]],
  6: [[7, 6], [17, 6], [7, 12], [17, 12], [7, 18], [17, 18]],
};
/** A flat die for the tray. */
const flatDie = (n: number) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="5.5" fill="#fff" stroke="rgba(0,0,0,.25)"/>${PIPS[n]!.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.4" fill="${n === 6 ? '#d2203c' : '#1b2a4a'}"/>`).join('')}</svg>`;

export type Exit = 'home' | 'again' | 'replay';

/** The rules in a nutshell, for the pause menu. */
const HOW_TO_PLAY = (singles: boolean) => `<h2>How to play</h2><ul class="howto">
  <li><b>Roll first.</b> A 6 rolls again. Your dice wait in the tray at the bottom until you play them.</li>
  <li><b>Then play the dice in any order:</b> tap a die, then a token. A 6 brings a token out.</li>
  <li><b>Land on an enemy</b> to send it home, and roll again. Stars are safe.</li>
  ${singles ? '<li><b>Doubles are off:</b> every token moves alone and nothing blocks.</li>' : '<li><b>Two of your tokens on a square are a double:</b> they move together on even rolls and block singles.</li>'}
  <li><b>Three 6s in a row</b> cancel those 6s.</li>
  <li><b>Get all four home</b> with an exact roll to win.</li></ul>
  <button class="b3 green disp" data-act="back">BACK</button>`;

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
  /** People already handed the phone in "With friends" (each once, in the game's first round). */
  private handedOver = new Set<number>();
  /** This game's kills and pairs formed by the person playing vs Computer, for the stats. */
  private kills = 0;
  private pairs = 0;
  /** Sixes the person playing vs Computer rolled this game, and their tokens that were captured. */
  private sixes = 0;
  private lost = 0;
  /** The players still in voted to stop: the game ends with the places as they stand. */
  private ended = false;
  /** Colours whose tokens have had the full palace welcome this game; later ones get a quick one. */
  private welcomed = new Set<Color>();
  /** While a person picks a move: a tap on a die in their tray. */
  private trayPick: ((roll: number) => void) | null = null;
  /** Pauses the game and saves it when the app goes to the background. */
  private onHidden = () => {
    if (document.visibilityState !== 'hidden' || this.disposed) return;
    this.save();
    if (!this.el.querySelector('.cs, .vote')) this.openMenu();
  };

  /**
   * The game's seed. Every roll and every bot move draws from a generator seeded by it and the position, so a
   * continued game rolls exactly what it would have (killing the app doesn't re-roll a bad turn), while a
   * different move leads to new dice.
   */
  private seed: number;
  /**
   * The game so far as record events (engine/record.ts), saved with the game. Null for a game continued from
   * a save made before records existed: its start is missing, so it has no record.
   */
  private log: string | null;
  /** Every die came from `seed` (not a game continued from a save made before seeds). */
  private seedFromStart: boolean;

  /** Starts a game from `config`, or picks up `saved`. `rng` replaces the position-seeded dice (tests). */
  constructor(readonly config: GameConfig, private exit: (to: Exit) => void, private fixedRng?: Rng, saved?: SavedGame) {
    this.state = saved?.state ?? createGame(config.seats, config.first, config.singles);
    this.seed = saved?.seed ?? crypto.getRandomValues(new Uint32Array(1))[0]!;
    this.log = saved ? (saved.log ?? null) : '';
    // Test dice (fixedRng) don't come from the seed. A dev forced die from an earlier session is lost on resume
    // (dev only), so such a record may claim a seed it doesn't match.
    this.seedFromStart = !fixedRng && (!saved || (saved.seed !== undefined && saved.log !== undefined));
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
      <div class="act"><div class="dicebar" aria-label="Dice this turn"></div><button class="rollbtn disp" data-act="roll" hidden>${icons.play}<span>ROLL</span></button></div>
      <div class="toasts"></div>`;
    this.view = new BoardView(this.state.players, 370, this.state.players.filter((p) => !p.bot).map((p) => p.color), !!this.state.singles, true);
    this.el.querySelector('.gboard')!.appendChild(this.view.el);
    this.el.querySelector('[data-act=menu]')!.addEventListener('click', () => this.openMenu());
    this.el.querySelector('.dicebar')!.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('.tdie');
      if (b && !this.paused) this.trayPick?.(Number(b.dataset.r));
    });
    // A continued game shows the dice as they were.
    for (const [c, f] of this.lastFace) this.diceBox(c).innerHTML = dieMarkup(f, DIE);
    this.drawTrays();
    keepAwake(true);
    document.addEventListener('visibilitychange', this.onHidden);
    void this.run();
  }

  /** The generator for this position's roll or bot move. */
  private rngFor(what: 'dice' | 'bot'): Rng {
    return this.fixedRng ?? seeded(mixSeed(this.seed, what + positionKey(this.state)));
  }

  /** The game as it would be saved now. */
  private snapshot(): SavedGame {
    return { v: 1, config: this.config, state: this.state, kills: this.kills, pairs: this.pairs, faces: [...this.lastFace], savedAt: Date.now(), seed: this.seed, ...(this.log !== null ? { log: this.log } : {}) };
  }

  /** Saves the game so it can be continued after the app closes. Done at the start of every turn. */
  private save() {
    if (this.disposed || this.ended || this.state.phase !== 'roll') return;
    void saveGame(this.snapshot());
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
      <div class="who"><div class="av">${avatarSVG(c)}</div><span class="nm">${this.name(c)}</span>${bot ? '<span class="bot">BOT</span>' : ''}<span class="ptr"></span>
        <svg class="psym sym" viewBox="-11 -11 22 22" aria-hidden="true"><circle r="10.5" fill="#fff"/><path d="${symbolPath(c, 6.5)}" fill="${PALETTE[c].m}" stroke="${PALETTE[c].d}" stroke-width="1.2" stroke-linejoin="round"/></svg></div>
      <button class="dbox" aria-label="Roll dice"><span class="qdie disp">?</span></button></div>`;
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

  // A turn is one roll or one move at a time: the whole turn is rolled into the tray first (a 6 rolls
  // again), then its dice are played in any order; a kill or a token home rolls again first.

  /** Bots' pauses: halved with "Fast bots" on. */
  private botPause(ms: number) {
    return this.sleep(settings.fastBots ? ms / 2 : ms);
  }

  private async botTurn(c: Color) {
    this.setHint(c, `${this.name(c)} is playing…`, 'Bot turn');
    if (this.state.phase === 'roll') {
      await this.botPause(380);
      if (!this.disposed) await this.doRoll(c);
      return;
    }
    const t0 = performance.now();
    const m = await chooseBotMoveAsync(this.state, this.rngFor('bot'));
    if (this.disposed) return;
    // Light up the die the bot plays, so its turn is easy to follow; thinking time counts toward the pause.
    this.drawTrays(m.roll);
    await this.botPause(Math.max(0, 420 - (performance.now() - t0)));
    if (!this.disposed) await this.doMove(m);
  }

  private async humanTurn(c: Color) {
    const pvp = this.config.mode === 'pvp';
    const who = pvp ? this.name(c) : 'You';
    if (this.state.phase === 'roll') {
      const again = this.state.rolls.length > 0;
      // Passing the device: each person is handed it once, before their first turn of the game. After that
      // the turn hint is enough: whoever taps the die, the dice are the same, and the right person moves.
      const firstRound = this.state.turnCount < this.state.players.length;
      if (!again && pvp && firstRound && !this.handedOver.has(this.ownerOf(c))) {
        this.handedOver.add(this.ownerOf(c));
        this.setHint(c, `${this.name(c)}'s turn`, 'Pass the phone');
        await this.passTo(c);
        if (this.disposed) return;
      }
      if (again) this.setHint(c, 'Roll again', `Your ${this.state.rolls.join(' · ')} wait below. Tap ROLL AGAIN`);
      else this.setHint(c, pvp ? `${this.name(c)}'s turn` : 'Your turn', 'Tap ROLL');
      await this.waitRollTap(c);
      if (!this.disposed) await this.doRoll(c);
      return;
    }
    // Only one thing to do with the whole tray: just do it.
    const all = moveTargets(this.state.players, this.state.moves);
    if (all.length === 1) {
      this.drawTrays(all[0]!.move.roll);
      await this.sleep(250);
      if (!this.disposed) await this.doMove(all[0]!.move);
      return;
    }
    const m = await this.pickMove(c, who);
    if (!this.disposed) await this.doMove(m);
  }

  private async doRoll(c: Color) {
    const kept = this.state.rolls;
    const forced = this.forced.shift();
    if (forced !== undefined) this.seedFromStart = false;
    this.state = roll(this.state, this.rngFor('dice'), forced);
    if (this.log !== null) this.log += rollEvent(this.state.dice!);
    const box = this.diceBox(c);
    await rollDie(box, this.state.dice!, DIE, (this.cur.bot || this.state.players.find((p) => p.color === c)!.bot ? BOT_ROLL_MS / (settings.fastBots ? 2 : 1) : ROLL_MS) / this.speed);
    this.lastFace.set(c, this.state.dice!);
    const ev = this.state.event;
    if (this.state.dice === 6 && ev?.type !== 'three-sixes') {
      box.classList.remove('six');
      void box.offsetWidth; // restart the flare animation
      box.classList.add('six');
      this.toast('SIX! Roll again', c, 'six');
      const human = !this.state.players.find((p) => p.color === c)!.bot;
      if (human && this.config.mode === 'pvc') this.sixes++;
      if (human) this.firstTip();
    }
    if (ev?.type === 'three-sixes') {
      sfx.bust();
      // The three 6s leave the tray at once. Dice kept from before a kill stay and are still played.
      this.drawTrays();
      const goesOn = this.state.phase === 'move';
      this.setHint(c, 'Three 6s in a row', goesOn ? `Those 6s are cancelled. You still have ${this.state.rolls.join(' · ')}` : 'Those 6s are cancelled and the turn ends');
      this.toast(goesOn ? 'Three 6s! Cancelled' : 'Three 6s! Turn lost', c, 'bust');
      await this.sleep(800);
    } else if (ev?.type === 'no-move') {
      // Show the tray that just ran out (nothing can use it) while the note is up.
      this.drawTrays(undefined, { c, dice: [...kept, ev.dice] });
      this.toast('No moves', c);
      await this.sleep(700);
    }
    this.drawTrays();
  }

  /** The dice shown in a colour's tray: the current player's unplayed dice, nobody else's. */
  private trayOf(c: Color) {
    return this.cur.color === c ? this.state.rolls : [];
  }

  /**
   * Draws the tray beside the current player's dice: their dice for this turn, not played yet. `lit` is
   * the die being played; dice no token can use right now are dimmed. `show` puts other dice in one
   * colour's tray (one that just ran out). Every other tray is empty.
   */
  private drawTrays(lit?: number, show?: { c: Color; dice: number[] }) {
    const usable = this.state.phase === 'move' ? new Set(this.state.moves.map((m) => m.roll)) : null;
    const c = show?.c ?? this.cur.color;
    const dice = show ? show.dice : this.trayOf(c);
    const bar = this.el.querySelector<HTMLElement>('.dicebar')!;
    bar.setAttribute('style', cssVars(c));
    bar.classList.toggle('bot', !!this.state.players.find((p) => p.color === c)?.bot);
    let on = false;
    bar.innerHTML = dice
      .map((r) => {
        const here = r === lit && !on;
        on ||= here;
        return `<button class="tdie${here ? ' on' : ''}${usable && !usable.has(r) ? ' off' : ''}" data-r="${r}" aria-label="Play the ${r}">${flatDie(r)}</button>`;
      })
      .join('');
  }

  private async doMove(m: Move) {
    const doneBefore = this.doneOwners();
    if (this.log !== null) this.log += moveEvent(m);
    this.state = move(this.state, m);
    // The KILL banner and red flash land with the blow, while the victim is still flying home.
    // Kill finishers: the full scene when a person is involved, a short one between bots, or none.
    const people = [m.color, ...m.captures.map((c) => c.color)].some((c) => !this.state.players.find((p) => p.color === c)!.bot);
    const fx = settings.killFx === 'off' ? 0 : settings.killFx === 'short' || !people ? 420 : 1400;
    await this.view.animateMove(m, this.state.players, this.speed, () => this.killBanner(m), m.captures.length ? fx : 0);
    const ev = this.state.event;
    const extra = ev?.type === 'moved' && ev.extraTurn;
    const player = this.state.players.find((p) => p.color === m.color)!;
    const human = !player.bot;
    // A kill's banner already landed with the blow (killBanner). A person's token reaching home is
    // welcomed into the palace; a bot's just gets the banner.
    if (!m.captures.length && m.finishes) {
      if (human) {
        await playCutscene(this.el, m.color, player.tokens, this.speed * (this.welcomed.has(m.color) ? 2.2 : 1));
        this.welcomed.add(m.color);
      }
      else this.toast('HOME!', m.color, 'home');
    }
    if (extra && human) this.toast('Roll again', m.color);
    if (ev?.type === 'moved' && ev.lost.length) this.toast(`Can't use the ${ev.lost.join(' and ')}`, m.color);
    this.drawTrays();
    if (human && this.config.mode === 'pvc') this.count(m);
    if (this.config.mode === 'pvc') this.lost += m.captures.filter((c) => !this.state.players.find((p) => p.color === c.color)!.bot).length;
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
        // One "stop" ends the game for everyone, so it takes a second tap.
        if (b.dataset.v === 'no') {
          if (b.classList.contains('sure')) return done(false);
          b.classList.add('sure');
          b.textContent = one ? 'TAP AGAIN TO END' : 'Sure?';
          return;
        }
        yes.add(o);
        ov.querySelector(`.vrow[data-o="${o}"]`)?.classList.add('agreed');
        if (voters.every((v) => yes.has(v))) setTimeout(() => done(true), one ? 0 : 450);
      });
      this.el.appendChild(ov);
    });
  }

  // ---------- human input ----------
  /** Waits for a tap on the big ROLL button (in the player's colour, by the thumb) or on their dice box. */
  private waitRollTap(c: Color): Promise<void> {
    const box = this.diceBox(c);
    const btn = this.el.querySelector<HTMLButtonElement>('.rollbtn')!;
    box.classList.add('can-roll');
    btn.setAttribute('style', cssVars(c));
    btn.querySelector('span')!.textContent = this.state.rolls.length ? 'ROLL AGAIN' : 'ROLL';
    btn.hidden = false;
    return new Promise((done) => {
      const on = () => {
        if (this.paused) return;
        box.removeEventListener('click', on);
        btn.removeEventListener('click', on);
        box.classList.remove('can-roll');
        btn.hidden = true;
        done();
      };
      box.addEventListener('click', on);
      btn.addEventListener('click', on);
    });
  }

  /**
   * With friends, when the phone changes hands: a card asks the next person to take it, and their turn
   * starts when they tap. Easy to miss as a banner; impossible to miss as a card.
   */
  private passTo(c: Color): Promise<void> {
    return new Promise((done) => {
      const ov = document.createElement('div');
      ov.className = 'menu-ov passov';
      ov.innerHTML = `<div class="box" style="${cssVars(c)}"><div class="pav">${avatarSVG(c)}</div><small>Pass the phone to</small><h2>${this.name(c)}</h2><p class="sub">Tap when you have it</p></div>`;
      ov.addEventListener('click', () => {
        if (this.paused) return;
        sfx.tick();
        ov.remove();
        done();
      });
      this.el.appendChild(ov);
    });
  }

  /**
   * A die from the tray (the biggest usable one to start; tap another to switch), then a token or its
   * landing marker. A pair on a star shows "pair" and "one token" as two markers.
   */
  private pickMove(c: Color, who: string): Promise<Move> {
    const usable = [...new Set(this.state.moves.map((m) => m.roll))];
    return new Promise((resolve) => {
      const play = (r: number) => {
        this.drawTrays(r);
        const targets: Target[] = moveTargets(this.state.players, this.state.moves.filter((m) => m.roll === r));
        const other = usable.length > 1 ? ', or another die' : '';
        if (targets.some((t) => t.move.kind === 'pair')) this.setHint(c, `Pair move with the ${r}`, `Both tokens move ${r / 2}. Tap a token${other}`, true);
        else this.setHint(c, `${who} rolled ${this.state.rolls.join(' · ')}`, `Playing the ${r}: tap a token${other}`);
        // Markers that land close together crowd each other and the pawns: those moves also get big
        // numbered buttons in the hint card, matching numbers on their markers.
        const crowd = crowded(targets, this.state.players);
        if (crowd.length) this.setHint(c, `Pick a move with the ${r}`, '', true);
        this.setChoices(crowd);
        this.view.showTargets(
          targets,
          (t) => {
            this.trayPick = null;
            this.setChoices([]);
            resolve(t.move);
          },
          (own) => {
            const pair = own.find((t) => t.move.kind === 'pair');
            const one = own.find((t) => t.move.kind === 'single');
            if (pair && one) this.setHint(c, 'Pair or one token?', `Tap a spot: the pair moves ${pair.move.steps} each, one token moves ${one.move.steps}`, true);
          },
          (pawn) => this.setHint(c, "That token can't move", whyStuck(this.state.players, c, Number(pawn.slice(c.length)), r, (o) => this.name(o), this.state.singles)),
          crowd,
        );
      };
      this.trayPick = (r) => {
        if (usable.includes(r)) play(r);
        else this.setHint(c, `No token can use the ${r} now`, 'Pick another die');
      };
      play(Math.max(...usable));
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

  /** The hint card's move buttons (crowded markers, numbered as on the board); none clears them. */
  private setChoices(targets: Target[]) {
    const h = this.el.querySelector<HTMLElement>('.hint')!;
    h.querySelector('.choices')?.remove();
    h.classList.toggle('pick', targets.length > 0);
    if (!targets.length) return;
    const row = document.createElement('div');
    row.className = 'choices';
    row.innerHTML = targets
      .map((t, i) => {
        const { what, does } = choiceText(t);
        return `<button class="choice tag-${t.tag}" data-i="${i}" style="${cssVars(t.move.color)}"><i>${i + 1}</i><span>${what}${does ? `<small>${does}</small>` : ''}</span></button>`;
      })
      .join('');
    row.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.choice');
      if (!b) return;
      sfx.tick();
      this.view.pick(targets[Number(b.dataset.i)]!);
    });
    h.querySelector('span:not(.tw)')!.appendChild(row);
  }

  private setHint(c: Color, title: string, sub: string, pair = false) {
    const h = this.el.querySelector('.hint')!;
    h.querySelector('.tw')!.innerHTML = pair ? twinsSVG(c) : pawnSVG(c);
    h.querySelector('b')!.textContent = title;
    h.querySelector('small')!.textContent = sub;
  }

  /** A banner over the board. Big moments (kill, six, home) slam in larger and tilted. */
  /** Once per install: the first 6 a person rolls explains that dice are kept and played later. */
  private firstTip() {
    try {
      if (localStorage.getItem('ludo-tip-tray') === '1') return;
      localStorage.setItem('ludo-tip-tray', '1');
    } catch {
      // Storage blocked: the tip may show again next time.
    }
    const t = document.createElement('div');
    t.className = 'tip';
    t.innerHTML = '<b>A 6 rolls again.</b> Your dice wait here in the tray, then you play them in any order: tap a die, then a token.';
    this.el.appendChild(t);
    t.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.16,1,.3,1)' });
    setTimeout(() => t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300 }).finished.then(() => t.remove()), 5200);
  }

  /** A kill: the banner and red at the screen edges. */
  private killBanner(m: Move) {
    this.toast(m.captures.length > 1 ? 'DOUBLE KILL!' : 'KILL!', m.color, 'kill');
    const f = document.createElement('div');
    f.className = 'killflash';
    this.el.appendChild(f);
    f.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }], { duration: 700 / this.speed, easing: 'ease-out' }).finished.finally(() => f.remove());
  }

  /** When the banner on screen stops holding the stage (ms, performance.now time). */
  private bannerFree = 0;

  /**
   * A banner over the board. Banners queue: each holds the stage (a kill longest) before the next one
   * starts, so "Roll again" never covers "KILL!". Big moments (kill, six, home) slam in larger and tilted.
   */
  private toast(text: string, c: Color, kind: 'kill' | 'six' | 'home' | 'bust' | 'turn' | '' = '') {
    const now = performance.now();
    const wait = Math.max(0, this.bannerFree - now);
    const hold = (kind === 'kill' ? 950 : kind === 'six' || kind === 'home' || kind === 'bust' ? 650 : 420) / this.speed;
    this.bannerFree = now + wait + hold;
    if (wait > 0) setTimeout(() => !this.disposed && this.showBanner(text, c, kind), wait);
    else this.showBanner(text, c, kind);
  }

  private showBanner(text: string, c: Color, kind: 'kill' | 'six' | 'home' | 'bust' | 'turn' | '') {
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
    ov.innerHTML = `<div class="box"><h2>Paused</h2><button class="b3 green disp" data-act="resume">RESUME</button><button class="b3 blue disp" data-act="face">${faceLabel()}</button><button class="b3 blue disp" data-act="sound">${sfx.muted ? 'SOUND: OFF' : 'SOUND: ON'}</button><button class="b3 blue disp" data-act="help">HOW TO PLAY</button><button class="b3 blue disp" data-act="quit">QUIT TO HOME</button></div>`;
    ov.addEventListener('click', async (e) => {
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
          const f = this.lastFace.get(pl.dataset.c as Color);
          if (f) box.innerHTML = dieMarkup(f, DIE);
        });
      } else if (act === 'help') {
        ov.querySelector('.box')!.innerHTML = HOW_TO_PLAY(!!this.state.singles);
      } else if (act === 'back') {
        ov.remove();
        this.paused = false;
        this.openMenu();
      } else if (act === 'sound') {
        sfx.setMuted(!sfx.muted);
        (e.target as Element).closest('button')!.textContent = sfx.muted ? 'SOUND: OFF' : 'SOUND: ON';
      } else if (act === 'quit') {
        // Quitting gives the game up, so it takes a second tap.
        const b = (e.target as Element).closest('button')!;
        if (this.disposed) return;
        const loses = givingUpLoses({ config: this.config, state: this.state });
        if (!b.classList.contains('sure')) {
          b.classList.add('sure');
          b.textContent = 'TAP AGAIN TO QUIT';
          const warn = Object.assign(document.createElement('p'), { className: 'sub warn', textContent: 'This game will be lost' });
          b.after(warn);
          // vs Computer after the first round, quitting is a loss: say what it costs.
          if (loses) void loadStats().then((s) => (warn.textContent = giveUpNote(s, levelOf(this.state))));
          return;
        }
        this.dispose();
        // As in giveUpSaved: the save is marked counted before the loss is recorded, then cleared, so a crash
        // at any point can't count the game twice (a counted save is never offered or counted again).
        if (loses) {
          await saveGame({ ...this.snapshot(), counted: true });
          await recordGame({ mode: 'pvc', place: 0, kills: 0, pairs: 0, quit: true, level: levelOf(this.state) });
        }
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
  /** The finished game's record, once the result shows (for its replay). */
  finalRecord: GameRecord | null = null;

  /** The game as a record (engine/record.ts), or null when it has none (continued from an old save). */
  record(): GameRecord | null {
    if (this.log === null) return null;
    const c = this.config;
    return { v: 1, seats: c.seats, first: c.first, ...(c.singles ? { singles: true } : {}), ...(this.seedFromStart ? { seed: this.seed } : {}), meta: { mode: c.mode, names: c.names }, events: this.log };
  }

  private showResult() {
    this.dispose();
    void clearGame();
    const order = ownerRanking(this.state);
    const pvp = this.config.mode === 'pvp';
    const colorsOf = (o: number) => this.state.players.filter((p) => p.owner === o);
    const human = this.state.players.find((p) => !p.bot)?.owner ?? 0;
    const place = order.indexOf(human) + 1;
    const won = pvp || place === 1;
    // The game's record joins the past games (for the replay and the review, #65). A game that ends before
    // its last place is played out (a vote to stop, no people left, or you finished vs Computer) ends with
    // STOP_EVENT, so a replay knows its result is the position's ownerRanking, as here.
    const rec = this.record();
    if (rec) {
      if (this.state.phase !== 'over') rec.events += STOP_EVENT;
      void savePastGame({ rec, at: Date.now(), mode: this.config.mode, place });
    }
    this.finalRecord = rec;
    const rows = order
      .map((o, i) => {
        const mine = colorsOf(o);
        const c = mine[0]!.color;
        const bot = mine[0]!.bot;
        const sub = i === 0 ? 'Winner' : bot ? 'Bot' : `${PLACES[i + 1]!.toLowerCase()} place`;
        const home = mine.reduce((a, p) => a + p.tokens.filter((t) => t === FINISHED).length, 0);
        const pct = Math.round((100 * mine.reduce((a, p) => a + p.tokens.reduce((x, t) => x + Math.max(t, 0), 0), 0)) / (FINISHED * 4 * mine.length));
        return `<div class="row${i === 0 ? ' first' : ''}${bot ? '' : ' me'}"><span class="medal m${i + 1}">${i + 1}</span>
          <span class="ra" style="${cssVars(c)}">${avatarSVG(c)}</span><span class="rn"><b>${this.config.names[o]}</b><small>${sub}</small></span>
          <span class="rv">${home} / ${4 * mine.length} home${home < 4 * mine.length ? `<small>${pct}% of the way</small>` : ''}</span></div>`;
      })
      .join('');
    const winner = this.config.names[order[0]!]!;
    const title = pvp ? `${winner.toUpperCase()} WINS!` : won ? 'YOU WIN!' : `${PLACES[place]} PLACE`;
    // Achievements need the new totals, so they join the reward panel when the stats are saved.
    const level = levelOf(this.state), layout = layoutOf(this.state);
    const facts: GameFacts = { mode: this.config.mode, place, lost: this.lost, level, layout, singles: !!this.state.singles };
    const achievements = recordGame({ mode: this.config.mode, place, kills: this.kills, pairs: this.pairs, sixes: this.sixes, level, layout }).then((s) => {
      const fresh = newAchievements(s, facts, settings.achieved);
      if (fresh.length) {
        award(fresh.map((a) => a.id));
        earn(fresh.reduce((a, x) => a + x.gold, 0));
      }
      return { fresh, ended: s.xEnded, streak: level === 'extreme' && won && !pvp ? { now: s.xStreak, next: nextStreak(s, settings.achieved) } : null };
    });
    // Gold for this game, then how close it brings you to the next skin.
    const mineHome = colorsOf(human).reduce((a, p) => a + p.tokens.filter((t) => t === FINISHED).length, 0);
    const lines = goldFor({ mode: this.config.mode, place, kills: this.kills, home: mineHome, level });
    const earned = total(lines);
    earn(earned);
    /** The next skin to buy and how close you are (redrawn when achievement gold lands). */
    const goalHTML = () => {
      const goal = nextGoal();
      const price = goal?.unlock.kind === 'gold' ? goal.unlock.price : 0;
      return goal ? `<div class="goal${settings.gold >= price ? ' ready' : ''}"><span>${settings.gold >= price ? `You can unlock <b>${goal.name}</b> in the Store!` : `Next: <b>${goal.name}</b> ${goal.shelf}`}</span><i class="bar"><i style="width:${Math.min(100, (100 * settings.gold) / price)}%"></i></i><em>${Math.min(settings.gold, price)} / ${lockLabel(goal)}</em></div>` : '';
    };
    const reward = `<div class="reward"><div class="rg"><i class="coin"></i><b class="disp">+<span class="cnt">0</span></b><small>${lines.map((l) => `${l.label} ${l.gold}`).join(' · ')}</small></div>
      <div class="achs"></div>${goalHTML()}</div>`;
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
        <div class="rank">${rows}</div>${reward}
        <div class="wbtns"><button class="b3 blue disp" data-act="home">HOME</button><button class="b3 green disp" data-act="again">PLAY AGAIN</button></div>
        <button class="sharebtn disp" data-act="share">${icons.share}SHARE RESULT</button>${rec ? '<button class="replaylink" data-act="replay">Watch the replay</button>' : ''}</div>`;
    ov.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>('button');
      const act = btn?.dataset.act;
      if (act === 'home' || act === 'again' || act === 'replay') this.exit(act);
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
    // New achievements pop in as small chips, and the next-skin bar catches up with their gold.
    void achievements.then(({ fresh, ended, streak }) => {
      const box = ov.querySelector<HTMLElement>('.achs')!;
      // A live Extreme streak and what the next win in a row would bring, or the streak this game ended.
      if (streak) {
        const next = streak.next ? ` · ${streak.next.name} at ${streak.now + streak.next.more} <em>+${streak.next.gold}</em>` : '';
        box.insertAdjacentHTML('beforeend', `<span class="ach xs">🔥 Extreme streak ${streak.now}${next}</span>`);
      } else if (ended) box.insertAdjacentHTML('beforeend', `<span class="ach xend">Extreme streak ended at ${ended}</span>`);
      // The biggest reward first, and its gold joins the headline and the breakdown.
      const sorted = [...fresh].sort((x, y) => y.gold - x.gold);
      const extra = sorted.reduce((a, x) => a + x.gold, 0);
      sorted.forEach((a, i) => {
        box.insertAdjacentHTML('beforeend', `<span class="ach" title="${a.blurb}">🏆 ${a.name} <em>+${a.gold}</em></span>`);
        (box.lastElementChild as HTMLElement).animate([{ opacity: 0, transform: 'scale(.5)' }, { opacity: 1, transform: 'scale(1.1)', offset: 0.7 }, { opacity: 1, transform: 'scale(1)' }], { duration: 380, delay: 1300 + i * 300, easing: 'cubic-bezier(.3,.8,.4,1.2)', fill: 'backwards' });
        setTimeout(() => sfx.home(), 1300 + i * 300);
      });
      if (fresh.length)
        setTimeout(() => {
          ov.querySelector('.reward .goal')?.replaceWith(document.createRange().createContextualFragment(goalHTML()));
          ov.querySelector('.reward .rg small')!.insertAdjacentText('beforeend', ` · Achievements ${extra}`);
          countUp(earned, earned + extra, 700);
        }, 1300 + fresh.length * 300);
    });
    if (won) sfx.win();
    // The gold counts up: this game's first, then the achievements' when they land.
    const cnt = ov.querySelector<HTMLElement>('.cnt')!;
    const countUp = (from: number, to: number, ms: number) => {
      const t0 = performance.now();
      const tick = () => {
        const k = Math.min(1, (performance.now() - t0) / ms);
        cnt.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    setTimeout(() => countUp(0, earned, 900), 500);
    ov.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350 });
    ov.querySelector('.trophy')!.animate([{ transform: 'scale(.3) rotate(-12deg)' }, { transform: 'scale(1.08)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 650, easing: 'cubic-bezier(.3,.8,.4,1.2)' });
  }
}
