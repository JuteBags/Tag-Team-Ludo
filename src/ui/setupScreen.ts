// Setup before a game, one step per screen: options (houses each in 2-player games, bots for empty houses
// in With friends, how well bots play), a roll for order, then picking houses one by one in that order. The highest roller
// picks first and plays first. Steps with nothing to choose are skipped. Rules live in setup.ts.
import { COLORS, type BotLevel, type Color, type Seat } from '../engine';
import { PROFILES, cssVars, icons, pawnSVG } from './art';
import { dieMarkup, rollDie } from './dice';
import { saveSetting, settings } from './settings';
import { pickSequence, pickable, rankRolls, type GameConfig, type Mode, type Pairing, type PickRules, type Picks } from './setup';

const DIE = 30;
const ROLL_MS = 900;
const NEUTRAL = '--l:#7cb0ff;--m:#2f66df;--d:#173f9e;--t:#cfe0ff';
/** Names bots can have (the human seat's character is "You"). */
const BOT_NAMES = (['green', 'red', 'yellow'] as const).map((c) => PROFILES[c].name);
/** Where each house sits, as on the board. */
const GRID: Color[] = ['green', 'red', 'blue', 'yellow'];

type Step = 'opts' | 'roll' | 'pick';
interface Person {
  name: string;
  bot: boolean;
}

export function setupScreen(mode: Mode, count: 2 | 3 | 4, onStart: (cfg: GameConfig) => void, onBack: () => void): HTMLElement {
  const rules: PickRules = { houses: 1, pairing: 'opposite' };
  /** With friends: bots added to houses nobody plays. */
  let addedBots = 0;
  const emptyHouses = () => 4 - count * rules.houses;
  /** How well the bots play (the last choice is remembered). */
  let level: BotLevel = settings.botLevel;
  /**
   * Is there anything to choose before rolling? vs Computer always has the bot level; With friends has
   * houses each (2 players) or bots for empty houses.
   */
  const hasOptions = mode === 'pvc' || count === 2 || count < 4;
  const steps: Step[] = hasOptions ? ['opts', 'roll', 'pick'] : ['roll', 'pick'];
  /** Everyone in the game: the people (or you and the bots), then any added bots. Bots keep one name throughout. */
  const makePeople = (): Person[] => {
    const humans = mode === 'pvp' ? count : 1;
    const bots = mode === 'pvp' ? addedBots : count - 1;
    return [
      ...Array.from({ length: humans }, (_, i) => ({ name: mode === 'pvp' ? `Player ${i + 1}` : 'You', bot: false })),
      ...Array.from({ length: bots }, (_, i) => ({ name: BOT_NAMES[i]!, bot: true })),
    ];
  };
  let people = makePeople();
  /** Every roll each person has made (shown next to them). */
  let rolls: number[][] = [];
  /**
   * People in order so far, as groups. A group of more than one is a tie: its members each roll once
   * more, and that round's results split it. Starts as one group with everyone.
   */
  let groups: number[][] = [];
  /** This round's roll for each member of the group being decided. */
  const round = new Map<number, number>();
  let order: number[] = [];
  let picks: Picks = {};
  let turn = 0;
  let step: Step = steps[0]!;
  let busy = false;
  /** Bumped on every reset, so a pending bot action from before it does nothing. */
  let epoch = 0;
  const rand = () => {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return 1 + (a[0]! % 6);
  };

  const el = document.createElement('div');
  el.className = 'screen setup';
  el.innerHTML = `
    <div class="gtop"><button class="rbtn" data-act="back" aria-label="Back">${icons.back}</button>
      <div class="mode"><small>${mode === 'pvp' ? 'WITH FRIENDS' : 'VS COMPUTER'}</small><b>${count} PLAYERS</b></div><span class="rbtn-space"></span></div>
    <ol class="steps">${steps.map((s) => `<li data-s="${s}"><i></i><span>${{ opts: 'Options', roll: 'Order', pick: 'Houses' }[s]}</span></li>`).join('')}</ol>
    ${hasOptions ? `<section class="wiz" data-step="opts">
      <h3 class="disp">Game options</h3><p class="sub">Set these before rolling</p>
      <div class="sp opts">
        ${count === 2 ? `<div class="row2"><span class="lbl">Houses each</span><div class="tg" data-k="houses"><button data-v="1" class="on">1 house</button><button data-v="2">2 houses</button></div></div>
        <div class="row2 pairs" hidden><span class="lbl">Pairs</span><div class="tg" data-k="pairing"><button data-v="opposite" class="on">Opposite</button><button data-v="adjacent">Side by side</button></div></div>` : ''}
        ${mode === 'pvp' ? `<div class="row2 bots"><span class="lbl">Add bots</span><div class="tg" data-k="bots"></div></div>` : ''}
        <div class="row2 lvl"><span class="lbl">Bots play</span><div class="tg" data-k="level">${(['easy', 'normal', 'hard'] as const).map((l) => `<button data-v="${l}"${l === level ? ' class="on"' : ''}>${l[0]!.toUpperCase() + l.slice(1)}</button>`).join('')}</div></div>
      </div>
      <p class="note"></p>
      <button class="b3 green disp go" data-act="to-roll">ROLL FOR ORDER</button>
    </section>` : ''}
    <section class="wiz" data-step="roll">
      <h3 class="disp">Roll for order</h3><p class="sub">Highest roll picks first and plays first</p>
      <div class="sp people"></div>
      <button class="b3 green disp go" data-act="to-pick" hidden>PICK HOUSES</button>
    </section>
    <section class="wiz" data-step="pick">
      <h3 class="disp"></h3><p class="sub"></p>
      <div class="houses">${GRID.map((c) => `<button class="house" data-c="${c}" style="${cssVars(c)}"><span class="pw">${pawnSVG(c)}</span><b></b></button>`).join('')}</div>
      <button class="b3 green disp go" data-act="start" hidden>START GAME</button>
    </section>`;

  const q = <T extends Element>(s: string) => el.querySelector<T & HTMLElement>(s)!;

  /** Shows one step and marks progress. */
  const show = (s: Step) => {
    step = s;
    el.querySelectorAll<HTMLElement>('.wiz').forEach((w) => (w.hidden = w.dataset.step !== s));
    const at = steps.indexOf(s);
    el.querySelectorAll<HTMLElement>('.steps li').forEach((li, i) => {
      li.classList.toggle('on', i === at);
      li.classList.toggle('done', i < at);
    });
  };

  // Back goes one step back (clearing what that step decided); from the first step, home.
  el.querySelector('[data-act=back]')!.addEventListener('click', () => {
    if (busy) return;
    const at = steps.indexOf(step);
    if (at === 0) return onBack();
    if (step === 'pick') {
      resetPicks();
      show('roll');
    } else {
      resetRoll();
      show(steps[at - 1]!);
    }
  });

  // ----- step 1: options -----
  /** The "Add bots" choice: 0 up to the number of empty houses; hidden when none are empty. */
  const drawOptions = () => {
    const tg = el.querySelector<HTMLElement>('.tg[data-k=bots]');
    if (tg) {
      addedBots = Math.min(addedBots, emptyHouses());
      tg.innerHTML = Array.from({ length: emptyHouses() + 1 }, (_, n) => `<button data-v="${n}"${n === addedBots ? ' class="on"' : ''}>${n}</button>`).join('');
      q('.bots').hidden = emptyHouses() === 0;
    }
    const pairs = el.querySelector<HTMLElement>('.pairs');
    if (pairs) pairs.hidden = rules.houses === 1;
    // The level only matters when there are bots.
    const lvl = el.querySelector<HTMLElement>('.lvl');
    if (lvl) lvl.hidden = mode === 'pvp' && addedBots === 0;
    const total = count * rules.houses + (mode === 'pvp' ? addedBots : 0);
    const note = el.querySelector('.note');
    if (note) note.textContent = rules.houses === 2 ? 'All four houses in play: two each' : `${total} of 4 houses in play${mode === 'pvp' && addedBots ? `, ${addedBots} played by bots` : ''}`;
  };
  el.querySelectorAll<HTMLElement>('.tg').forEach((tg) =>
    tg.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('button');
      if (!b) return;
      tg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      if (tg.dataset.k === 'houses') rules.houses = Number(b.dataset.v) as 1 | 2;
      else if (tg.dataset.k === 'bots') addedBots = Number(b.dataset.v);
      else if (tg.dataset.k === 'level') saveSetting('botLevel', (level = b.dataset.v as BotLevel));
      else rules.pairing = b.dataset.v as Pairing;
      drawOptions();
    }),
  );
  el.querySelector('[data-act=to-roll]')?.addEventListener('click', () => {
    resetRoll();
    show('roll');
  });

  // ----- step 2: roll for order -----
  const peopleEl = q('.people');
  /** Starts the roll over with the current options. */
  const resetRoll = () => {
    epoch++;
    busy = false;
    people = makePeople();
    rolls = people.map(() => []);
    groups = [people.map((_, i) => i)];
    round.clear();
    order = [];
    q('[data-act=to-pick]').hidden = true;
    peopleEl.innerHTML = people
      .map((p, i) => `<div class="prow" data-p="${i}"><span class="chip disp">${i + 1}</span><b>${p.name}</b><span class="st"></span><button class="dbox" style="${NEUTRAL}" aria-label="Roll">${dieMarkup(6, DIE)}</button></div>`)
      .join('');
    refreshRoll();
  };

  /** The tie being decided now (the first group of more than one), if any. */
  const deciding = () => groups.find((g) => g.length > 1);
  /** Who still has to roll in this round. */
  const due = () => (deciding() ?? []).filter((i) => !round.has(i));

  const refreshRoll = () => {
    const now = due();
    peopleEl.querySelectorAll<HTMLElement>('.prow').forEach((row) => {
      const i = Number(row.dataset.p);
      const mine = rolls[i]!;
      const waiting = now.includes(i);
      row.classList.toggle('due', waiting);
      row.querySelector('.st')!.textContent = waiting && mine.length ? 'Tie! Roll again' : mine.length ? `rolled ${mine.join(' · ')}` : people[i]!.bot ? '' : 'Tap to roll';
      row.querySelector('.dbox')!.classList.toggle('can-roll', waiting && !people[i]!.bot);
    });
    if (!deciding()) return finishRoll();
    // Bots roll by themselves once only bots are left to roll this round.
    if (now.length && now.every((i) => people[i]!.bot) && !busy) {
      const e = epoch;
      setTimeout(() => e === epoch && void rollFor(now[0]!), 250);
    }
  };

  const rollFor = async (i: number) => {
    if (busy || step !== 'roll' || !due().includes(i)) return;
    busy = true;
    const e = epoch;
    const v = rand();
    const box = peopleEl.querySelector<HTMLElement>(`.prow[data-p="${i}"] .dbox`)!;
    box.classList.remove('can-roll');
    await rollDie(box, v, DIE, ROLL_MS);
    if (e !== epoch) return;
    busy = false;
    rolls[i]!.push(v);
    round.set(i, v);
    // When everyone in the tie has rolled, split it by this round's rolls (highest first).
    const g = deciding()!;
    if (g.every((m) => round.has(m))) {
      const split = rankRolls(g.map((m) => [m, round.get(m)!]));
      groups = groups.flatMap((x) => (x === g ? split : [x]));
      round.clear();
    }
    refreshRoll();
  };
  peopleEl.addEventListener('click', (e) => {
    const row = (e.target as Element).closest<HTMLElement>('.prow');
    if (row && !people[Number(row.dataset.p)]!.bot) void rollFor(Number(row.dataset.p));
  });

  const finishRoll = () => {
    order = groups.flat();
    peopleEl.querySelectorAll<HTMLElement>('.prow').forEach((row) => {
      const i = Number(row.dataset.p);
      row.querySelector('.chip')!.textContent = String(order.indexOf(i) + 1);
      row.querySelector('.st')!.textContent = `${['1st', '2nd', '3rd', '4th'][order.indexOf(i)]} · rolled ${rolls[i]!.join(' · ')}`;
      row.classList.add('ranked');
      row.style.order = String(order.indexOf(i));
    });
    q('[data-act=to-pick]').hidden = false;
  };
  q('[data-act=to-pick]').addEventListener('click', () => {
    resetPicks();
    show('pick');
  });

  // ----- step 3: pick houses one by one -----
  const sequence = () => pickSequence(order, rules.houses);
  const resetPicks = () => {
    epoch++;
    picks = {};
    turn = 0;
    q('[data-act=start]').hidden = true;
    refreshPick();
  };

  const refreshPick = () => {
    const seq = sequence();
    const picker = seq[turn];
    const options = picker === undefined ? [] : pickable(picks, picker, rules);
    el.querySelectorAll<HTMLButtonElement>('.house').forEach((b) => {
      const c = b.dataset.c as Color;
      const owner = picks[c];
      b.classList.toggle('taken', owner !== undefined);
      b.classList.toggle('can', options.includes(c));
      b.disabled = !options.includes(c);
      b.querySelector('b')!.textContent = owner !== undefined ? people[owner]!.name : options.includes(c) ? 'Pick' : '';
    });
    if (picker === undefined) return ready();
    const second = rules.houses === 2 && COLORS.some((c) => picks[c] === picker);
    q('.wiz[data-step=pick] h3').textContent = `${people[picker]!.name}: pick ${second ? 'your second house' : 'a house'}`;
    q('.wiz[data-step=pick] .sub').textContent = second ? (rules.pairing === 'opposite' ? 'It must be opposite your first' : 'It must be next to your first') : `${seq.length - turn} picks left`;
    // Bots pick by themselves; a pick with only one option fills itself in.
    if (people[picker]!.bot || options.length === 1) {
      const e = epoch;
      setTimeout(() => e === epoch && choose(options[Math.floor(Math.random() * options.length)]!), 650);
    }
  };

  const choose = (c: Color) => {
    const picker = sequence()[turn];
    if (picker === undefined || !pickable(picks, picker, rules).includes(c)) return;
    picks[c] = picker;
    turn++;
    refreshPick();
  };
  q('.houses').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('.house');
    const picker = sequence()[turn];
    if (b && picker !== undefined && !people[picker]!.bot) choose(b.dataset.c as Color);
  });

  const ready = () => {
    const first = COLORS.find((c) => picks[c] === order[0])!;
    const names = people.map((p) => p.name);
    q('.wiz[data-step=pick] h3').textContent = `${names[order[0]!]} plays first`;
    q('.wiz[data-step=pick] .sub').textContent = 'Houses are set';
    const start = q<HTMLButtonElement>('[data-act=start]');
    start.hidden = false;
    start.onclick = () => {
      const seats: Seat[] = COLORS.filter((c) => picks[c] !== undefined).map((c) => ({ color: c, owner: picks[c]!, bot: people[picks[c]!]!.bot, ...(people[picks[c]!]!.bot ? { level } : {}) }));
      onStart({ mode, seats, first, names });
    };
  };

  drawOptions();
  resetRoll();
  show(steps[0]!);
  return el;
}
