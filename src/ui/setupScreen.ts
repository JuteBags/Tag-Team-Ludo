// Setup before a game, one step per screen: options (houses each in 2-player games, bots for empty houses
// in With friends, how well bots play), a roll for order, then picking houses one by one in that order. The highest roller
// picks first and plays first. Steps with nothing to choose are skipped. Rules live in setup.ts.
import { COLORS, type BotLevel, type Color, type Seat } from '../engine';
import { PROFILES, cssVars, icons, pawnSVG } from './art';
import { rollDie } from './dice';
import { saveSetting, settings } from './settings';
import { NAME_MAX, cleanName, defaultName, pickSequence, pickable, previewLayout, rankRolls, type GameConfig, type Mode, type Pairing, type PickRules, type Picks } from './setup';

const DIE = 30;
const ROLL_MS = 900;
const NEUTRAL = '--l:#7cb0ff;--m:#2f66df;--d:#173f9e;--t:#cfe0ff';
/** A small pencil: this name can be changed. */
const PENCIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>';
/** Names bots can have (the human seat's character is "You"). */
const BOT_NAMES = (['green', 'red', 'yellow'] as const).map((c) => PROFILES[c].name);
/** Where each house sits, as on the board. */
const GRID: Color[] = ['green', 'red', 'blue', 'yellow'];
/** A tiny 2x2 board with two houses marked, for the Opposite / Side by side buttons (GRID order). */
const mini = (marked: number[]) =>
  `<svg class="mini" viewBox="0 0 20 20" aria-hidden="true">${GRID.map((_, i) => `<rect x="${(i % 2) * 11}" y="${Math.floor(i / 2) * 11}" width="9" height="9" rx="2" fill="${marked.includes(i) ? '#ffd65a' : 'rgba(255,255,255,.25)'}"/>`).join('')}</svg>`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** A die before anyone rolls: a question mark, so nobody looks as if they already rolled a 6. */
const QDIE = '<span class="qdie disp">?</span>';
const CROWN = '<svg class="crown" viewBox="0 0 24 18" aria-hidden="true"><path d="M2 15 L4 4 L9 10 L12 2 L15 10 L20 4 L22 15Z" fill="#ffd23f" stroke="#a35a00" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const PLACE = ['1st', '2nd', '3rd', '4th'];

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
      // People keep the names they typed last time, seat by seat.
      ...Array.from({ length: humans }, (_, i) => ({ name: cleanName((mode === 'pvp' ? settings.friendNames[i] : settings.myName) ?? '', defaultName(mode, i)), bot: false })),
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
      <div class="pv" aria-hidden="true">${GRID.map((c) => `<div class="pvh" data-c="${c}" style="${cssVars(c)}"><span class="pw">${pawnSVG(c)}</span><b></b></div>`).join('')}</div>
      <div class="sp opts">
        ${count === 2 ? `<div class="row2 q"><span class="lbl">How many colours does each player play?</span><div class="tg" data-k="houses"><button data-v="1" class="on">1 colour</button><button data-v="2">2 colours</button></div><small class="qh">With 2 colours you move both; they're one team</small></div>
        <div class="row2 q pairs" hidden><span class="lbl">Where are your two colours?</span><div class="tg" data-k="pairing"><button data-v="opposite" class="on">${mini([1, 2])}Opposite</button><button data-v="adjacent">${mini([2, 3])}Side by side</button></div></div>` : ''}
        ${mode === 'pvp' ? `<div class="row2 q bots"><span class="lbl">Fill the empty colours with computer players?</span><div class="tg" data-k="bots"></div><small class="qh"></small></div>` : ''}
        <div class="row2 q lvl"><span class="lbl">How good are the bots?</span><div class="tg" data-k="level">${(['easy', 'normal', 'hard'] as const).map((l) => `<button data-v="${l}"${l === level ? ' class="on"' : ''}>${l[0]!.toUpperCase() + l.slice(1)}</button>`).join('')}</div></div>
      </div>
      <button class="b3 green disp go" data-act="to-roll">ROLL FOR ORDER</button>
    </section>` : ''}
    <section class="wiz" data-step="roll">
      <h3 class="disp">Roll for order</h3><p class="sub">Highest roll picks first and plays first. Tap a name to change it</p>
      <p class="porder" hidden></p>
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
  /** The bots choice: none up to the number of empty houses; hidden when none are empty. */
  const drawOptions = () => {
    const tg = el.querySelector<HTMLElement>('.tg[data-k=bots]');
    if (tg) {
      addedBots = Math.min(addedBots, emptyHouses());
      tg.innerHTML = Array.from({ length: emptyHouses() + 1 }, (_, n) => `<button data-v="${n}"${n === addedBots ? ' class="on"' : ''}>${n ? plural(n, 'bot', 'bots') : 'No, just us'}</button>`).join('');
      q('.bots').hidden = emptyHouses() === 0;
      const left = emptyHouses() - addedBots;
      q('.bots .qh').textContent = left ? `${plural(left, 'colour stays', 'colours stay')} empty` : 'Every colour is played';
    }
    const pairs = el.querySelector<HTMLElement>('.pairs');
    if (pairs) pairs.hidden = rules.houses === 1;
    // The level only matters when there are bots.
    const lvl = el.querySelector<HTMLElement>('.lvl');
    if (lvl) lvl.hidden = mode === 'pvp' && addedBots === 0;
    // The preview: who plays each house. Houses are picked later, so it shows the layout, not names.
    const layout = previewLayout(count, rules, mode === 'pvp' ? addedBots : 0);
    let botSeen = 0;
    el.querySelectorAll<HTMLElement>('.pvh').forEach((h) => {
      const slot = layout[h.dataset.c as Color];
      // vs Computer, person 1 is you and everyone else is a bot.
      // Bots by the names they play under; vs Computer, person 1 is you and the rest are bots.
      const botIndex = mode === 'pvc' ? Number(slot.slice(1)) - 2 : botSeen++;
      const label = slot === 'empty' ? 'Empty' : slot === 'bot' || (mode === 'pvc' && slot !== 'p1') ? BOT_NAMES[botIndex] ?? 'Bot' : mode === 'pvc' ? 'You' : `Player ${slot.slice(1)}`;
      h.classList.toggle('empty', slot === 'empty');
      h.querySelector('b')!.textContent = label;
    });
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
      .map((p, i) => `<div class="prow" data-p="${i}"><span class="chip disp">${i + 1}</span>${p.bot ? `<b>${p.name}</b>` : `<button class="pname" data-p="${i}" aria-label="Change name">${p.name}${PENCIL}</button>`}<span class="st"></span><button class="dbox" style="${NEUTRAL}" aria-label="Roll">${QDIE}</button></div>`)
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
      row.classList.toggle('tie', waiting && mine.length > 0);
      row.querySelector('.st')!.textContent = waiting && mine.length ? 'Tie! Roll again' : mine.length ? `rolled ${mine.join(' · ')}` : people[i]!.bot ? '' : 'Tap the dice';
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
  // Tap a person's name to change it; it is remembered for that seat.
  const editName = (i: number) => {
    const btn = peopleEl.querySelector<HTMLElement>(`.pname[data-p="${i}"]`);
    if (!btn) return;
    const input = document.createElement('input');
    input.className = 'pname-in';
    input.maxLength = NAME_MAX;
    input.value = people[i]!.name === defaultName(mode, i) ? '' : people[i]!.name;
    input.placeholder = defaultName(mode, i);
    input.setAttribute('aria-label', 'Name');
    input.enterKeyHint = 'done';
    btn.replaceWith(input);
    input.focus();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const name = cleanName(input.value, defaultName(mode, i));
      people[i]!.name = name;
      if (mode === 'pvp') {
        const names = [...settings.friendNames];
        names[i] = name === defaultName(mode, i) ? '' : name;
        saveSetting('friendNames', names);
      } else saveSetting('myName', name === defaultName(mode, i) ? '' : name);
      const back = document.createElement('button');
      back.className = 'pname';
      back.dataset.p = String(i);
      back.setAttribute('aria-label', 'Change name');
      back.innerHTML = name + PENCIL;
      input.replaceWith(back);
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
    input.addEventListener('blur', commit);
  };
  peopleEl.addEventListener('click', (e) => {
    const nameBtn = (e.target as Element).closest<HTMLElement>('.pname');
    if (nameBtn) return editName(Number(nameBtn.dataset.p));
    if ((e.target as Element).closest('.pname-in')) return;
    const row = (e.target as Element).closest<HTMLElement>('.prow');
    if (row && !people[Number(row.dataset.p)]!.bot) void rollFor(Number(row.dataset.p));
  });

  /**
   * Every place is decided: the rows slide into play order (1st at the top), each with its rank, and a
   * line spells the order out. Names can still be changed; a rename doesn't move anyone.
   */
  const finishRoll = () => {
    order = groups.flat();
    const rows = [...peopleEl.querySelectorAll<HTMLElement>('.prow')];
    const before = new Map(rows.map((r) => [r, r.getBoundingClientRect().top]));
    rows.forEach((row) => {
      const i = Number(row.dataset.p);
      const place = order.indexOf(i);
      row.querySelector('.chip')!.innerHTML = place === 0 ? CROWN : String(place + 1);
      row.querySelector('.st')!.textContent = `${PLACE[place]} · rolled ${rolls[i]!.join(' · ')}`;
      row.classList.add('ranked');
      row.classList.toggle('first', place === 0);
      row.classList.remove('tie');
      row.style.order = String(place);
    });
    // FLIP: from where each row was to where it is now, top row first.
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const row of rows) {
        const dy = before.get(row)! - row.getBoundingClientRect().top;
        if (Math.abs(dy) < 1) continue;
        row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 420, delay: 60 * Number(row.style.order), easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
      }
    }
    const po = q('.porder');
    po.innerHTML = `Play order: ${order.map((i) => `<b>${people[i]!.name}</b>`).join(' → ')}`;
    po.hidden = false;
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
    q('.wiz[data-step=pick] h3').innerHTML = `${CROWN}${names[order[0]!]} plays first`;
    q('.wiz[data-step=pick] .sub').textContent = 'Houses are set';
    const start = q<HTMLButtonElement>('[data-act=start]');
    start.hidden = false;
    start.onclick = () => {
      const seats: Seat[] = COLORS.filter((c) => picks[c] !== undefined).map((c) => ({ color: c, owner: picks[c]!, bot: people[picks[c]!]!.bot, ...(people[picks[c]!]!.bot ? { level } : {}) }));
      onStart({ mode, seats, first, names, ...(settings.doubles ? {} : { singles: true }) });
    };
  };

  drawOptions();
  resetRoll();
  show(steps[0]!);
  return el;
}
