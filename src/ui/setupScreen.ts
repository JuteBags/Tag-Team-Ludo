// Setup before a game: houses per person (2-player games), a roll for order, then picking houses one by
// one in that order. The highest roller picks first and plays first. Rules live in setup.ts.
import { COLORS, type Color, type Seat } from '../engine';
import { PALETTE, PROFILES, cssVars, icons, pawnSVG } from './art';
import { dieMarkup, rollDie } from './dice';
import { pickSequence, pickable, rankRolls, type GameConfig, type Mode, type Pairing, type PickRules, type Picks } from './setup';

const DIE = 30;
const ROLL_MS = 900;
const NEUTRAL = '--l:#7cb0ff;--m:#2f66df;--d:#173f9e;--t:#cfe0ff';
/** Names bots can have (the human seat's character is "You"). */
const BOT_NAMES = (['green', 'red', 'yellow'] as const).map((c) => PROFILES[c].name);
/** Where each house sits, as on the board. */
const GRID: Color[] = ['green', 'red', 'blue', 'yellow'];

interface Person {
  name: string;
  bot: boolean;
}

export function setupScreen(mode: Mode, count: 2 | 3 | 4, onStart: (cfg: GameConfig) => void, onBack: () => void): HTMLElement {
  const people: Person[] = Array.from({ length: count }, (_, i) =>
    mode === 'pvp' ? { name: `Player ${i + 1}`, bot: false } : i === 0 ? { name: 'You', bot: false } : { name: `Bot ${i}`, bot: true },
  );
  const rules: PickRules = { houses: 1, pairing: 'opposite' };
  /** Every roll each person has made (shown next to them). */
  const rolls: number[][] = people.map(() => []);
  /**
   * People in order so far, as groups. A group of more than one is a tie: its members each roll once
   * more, and that round's results split it. Starts as one group with everyone.
   */
  let groups: number[][] = [people.map((_, i) => i)];
  /** This round's roll for each member of the group being decided. */
  const round = new Map<number, number>();
  const picks: Picks = {};
  let order: number[] = [];
  let step: 'roll' | 'pick' | 'ready' = 'roll';
  let busy = false;
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
    ${count === 2 ? `<section class="sp opts">
      <div class="row2"><span class="lbl">Houses each</span><div class="tg" data-k="houses"><button data-v="1" class="on">1 house</button><button data-v="2">2 houses</button></div></div>
      <div class="row2 pairs" hidden><span class="lbl">Pairs</span><div class="tg" data-k="pairing"><button data-v="opposite" class="on">Opposite</button><button data-v="adjacent">Side by side</button></div></div>
    </section>` : ''}
    <section class="sp roll"><h3 class="disp">Roll for order</h3><p class="sub">Highest roll picks first and plays first</p><div class="people"></div></section>
    <section class="sp pick" hidden><h3 class="disp"></h3><p class="sub"></p><div class="houses">${GRID.map((c) => `<button class="house" data-c="${c}" style="${cssVars(c)}"><span class="pw">${pawnSVG(c)}</span><b></b></button>`).join('')}</div></section>
    <button class="b3 green disp start" hidden>START GAME</button>`;

  const q = <T extends Element>(s: string) => el.querySelector<T & HTMLElement>(s)!;
  el.querySelector('[data-act=back]')!.addEventListener('click', onBack);

  // ----- houses each (2 players) -----
  el.querySelectorAll<HTMLElement>('.tg').forEach((tg) =>
    tg.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('button');
      if (!b || step !== 'roll') return;
      tg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      if (tg.dataset.k === 'houses') {
        rules.houses = Number(b.dataset.v) as 1 | 2;
        q('.pairs').hidden = rules.houses === 1;
      } else rules.pairing = b.dataset.v as Pairing;
    }),
  );

  // ----- roll for order -----
  const peopleEl = q('.people');
  peopleEl.innerHTML = people
    .map((p, i) => `<div class="prow" data-p="${i}"><span class="chip disp">${i + 1}</span><b>${p.name}</b><span class="st"></span><button class="dbox" style="${NEUTRAL}" aria-label="Roll">${dieMarkup(6, DIE)}</button></div>`)
    .join('');

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
    if (now.length && now.every((i) => people[i]!.bot) && !busy) void rollFor(now[0]!);
  };

  const rollFor = async (i: number) => {
    if (busy || step !== 'roll' || !due().includes(i)) return;
    busy = true;
    el.querySelector('.opts')?.classList.add('locked');
    const v = rand();
    const box = peopleEl.querySelector<HTMLElement>(`.prow[data-p="${i}"] .dbox`)!;
    box.classList.remove('can-roll');
    await rollDie(box, v, DIE, ROLL_MS);
    rolls[i]!.push(v);
    round.set(i, v);
    busy = false;
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
    step = 'pick';
    setTimeout(startPick, 700);
  };

  // ----- pick houses one by one -----
  let turn = 0;
  const sequence = () => pickSequence(order, rules.houses);
  const startPick = () => {
    q('.pick').hidden = false;
    q('.pick').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    q('.pick h3').textContent = `${people[picker]!.name}: pick ${second ? 'your second house' : 'a house'}`;
    q('.pick .sub').textContent = second ? (rules.pairing === 'opposite' ? 'It must be opposite your first' : 'It must be next to your first') : `${seq.length - turn} picks left`;
    // Bots pick by themselves; a pick with only one option fills itself in.
    if (people[picker]!.bot || options.length === 1) setTimeout(() => choose(options[Math.floor(Math.random() * options.length)]!), 650);
  };

  const choose = (c: Color) => {
    const picker = sequence()[turn];
    if (picker === undefined || !pickable(picks, picker, rules).includes(c)) return;
    picks[c] = picker;
    turn++;
    refreshPick();
  };
  el.querySelector('.houses')!.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('.house');
    const picker = sequence()[turn];
    if (b && picker !== undefined && !people[picker]!.bot) choose(b.dataset.c as Color);
  });

  const ready = () => {
    step = 'ready';
    const first = COLORS.find((c) => picks[c] === order[0])!;
    // Bots take the name of their first house, so a bot with two houses has one name.
    // A bot takes its first house's character name; Blue's is "You", so it takes a free one instead.
    const used = new Set<string>();
    const names = people.map((p, i) => {
      if (!p.bot) return p.name;
      const own = PROFILES[COLORS.find((c) => picks[c] === i)!].name;
      const name = BOT_NAMES.includes(own) && !used.has(own) ? own : BOT_NAMES.find((n) => !used.has(n))!;
      used.add(name);
      return name;
    });
    q('.pick h3').textContent = `${names[order[0]!]} plays first`;
    q('.pick .sub').textContent = 'Houses are set';
    const start = q<HTMLButtonElement>('.start');
    start.hidden = false;
    start.style.setProperty('--first', PALETTE[first].m);
    start.onclick = () => {
      const seats: Seat[] = COLORS.filter((c) => picks[c] !== undefined).map((c) => ({ color: c, owner: picks[c]!, bot: people[picks[c]!]!.bot }));
      onStart({ mode, seats, first, names });
    };
  };

  refreshRoll();
  return el;
}
