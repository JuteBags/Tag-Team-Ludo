// The daily puzzle (#99): the day's position (the same for everyone on a date, puzzles.ts) and, while the
// pool has them, an Expert one beside it. One try each: tap the move you'd play, and the reveal is the
// review's own verdict (its label, "+N% to win", the plain sentence and the "why" line) with the You and
// Better paths on the board, as in the replay's "Find the better move?". Then "One way it could go" plays an
// example line on the board, labelled as an example on every step: the win chances are the verdict, the
// line is one roll of the dice. A lazy screen: it and the pool load only when the puzzle is opened.
import { labelOf, layoutKey } from '../engine/ai/review';
import { checkPick, dailyExpert, dailyPuzzle, lineStates, type Pool, type Puzzle } from '../engine/puzzles';
import type { Color, GameState } from '../engine';
import { avatarSVG, cssVars, icons } from './art';
import { BoardView } from './boardView';
import { dayKey } from './checkin';
import { dieMarkup } from './dice';
import { goldOf, picksOf, played, streakNow, weekdayOf, type Which } from './puzzleDay';
import { describe } from './replay';
import { LABEL_LOOK, plainVerdict, toWin } from './reviewText';
import { whyFacts, whyLine } from './reviewWhy';
import { earn } from './skins';
import { savePuzzleLog, type PuzzleLog } from './store';
import { moveTargets } from './targets';

/** A house by its colour ("Red"): a puzzle has no players' names. */
const houseName = (c: Color) => c[0]!.toUpperCase() + c.slice(1);
const BAND = { easy: 'Easy', medium: 'Medium', hard: 'Hard' } as const;
const STEP_MS = 1100;
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The day's Expert puzzle, or null when there's none (before its start day, used up, or an older pool). */
function expertOf(day: string, pool: Pool): Puzzle | null {
  try {
    return dailyExpert(day, pool);
  } catch {
    return null;
  }
}

/** The text of an element built safely (names and copy never go in as markup). */
const span = (cls: string, text: string, style?: string) => {
  const s = document.createElement('span');
  s.className = cls;
  if (style) s.setAttribute('style', style);
  s.textContent = text;
  return s;
};

export function puzzleScreen(pool: Pool, stored: PuzzleLog | null | 'error', back: () => void): HTMLElement {
  const today = dayKey();
  const found: Record<Which, Puzzle | null> = { daily: dailyPuzzle(today, pool), expert: expertOf(today, pool) };
  // Storage that can't be read: the puzzles still play, but nothing is saved or paid (it could pay twice).
  const canSave = stored !== 'error';
  let log: PuzzleLog | null = stored === 'error' ? null : stored;
  let tab: Which = 'daily';
  let view: BoardView | null = null;
  /** Bumped on every redraw, so an example line still playing stops when the screen moves on. */
  let run = 0;

  const el = document.createElement('div');
  el.className = 'screen replay puzzle';
  const day = weekdayOf(today).toUpperCase();
  el.innerHTML = `
    <div class="gtop"><button class="rbtn" data-act="back" aria-label="Back">${icons.back}</button>
      ${found.expert
        ? `<div class="pztabs" role="tablist" aria-label="Which puzzle"><button role="tab" data-tab="daily"><small>${day}</small><b>${BAND[found.daily!.band].toUpperCase()}</b></button><button role="tab" data-tab="expert"><small>EXTRA</small><b>EXPERT</b></button></div>`
        : `<div class="mode"><small>DAILY PUZZLE · ${day}</small><b>${BAND[found.daily!.band].toUpperCase()}</b></div>`}
      <span class="pzstreak"></span></div>
    <div class="pzask"><i class="av"></i><span class="t"><b></b><small>Find the best move</small></span><span class="dice"></span></div>
    <div class="gboard"></div>
    <div class="pzlow"><div class="rpcap" aria-live="polite"><span class="rpdice"></span><span class="rptext"></span></div><div class="pzfoot"></div></div>`;
  const q = <T extends Element>(s: string) => el.querySelector<T>(s)!;
  const cap = q<HTMLElement>('.rpcap');
  const text = q<HTMLElement>('.rptext');
  const foot = q<HTMLElement>('.pzfoot');

  const drawHead = () => {
    const n = streakNow(log, today);
    const s = q<HTMLElement>('.pzstreak');
    s.textContent = `★ ${n}`;
    s.setAttribute('aria-label', `${n} ${n === 1 ? 'day' : 'days'} in a row`);
    const picks = picksOf(log, today);
    el.querySelectorAll<HTMLElement>('.pztabs [data-tab]').forEach((b) => {
      const w = b.dataset.tab as Which;
      b.classList.toggle('on', w === tab);
      b.setAttribute('aria-selected', String(w === tab));
      b.classList.toggle('done', !!picks[w]);
    });
  };

  /** The last seven days as dots, today's ringed: lit for the days of the streak. */
  const weekDots = (n: number) =>
    Array.from({ length: 7 }, (_, i) => `<i class="${i >= 7 - Math.min(n, 7) ? 'on' : ''}${i === 6 ? ' today' : ''}"></i>`).join('');

  const draw = () => {
    run++;
    const pz = found[tab]!;
    const s = pz.state;
    const mover = s.players[s.current]!.color;
    const ask = q<HTMLElement>('.pzask');
    ask.setAttribute('style', cssVars(mover));
    ask.querySelector('.av')!.innerHTML = avatarSVG(mover);
    ask.querySelector('b')!.textContent = `You're ${houseName(mover)}`;
    ask.querySelector('.dice')!.innerHTML = s.rolls.map((r) => `<i>${dieMarkup(r, 34)}</i>`).join('');
    ask.setAttribute('aria-label', `You're ${houseName(mover)}, you rolled ${s.rolls.join(' and ')}. Find the best move.`);
    view = new BoardView(s.players, 370, [mover], !!s.singles, true);
    q('.gboard').replaceChildren(view.el);
    drawHead();
    const done = picksOf(log, today)[tab];
    if (done) reveal(pz, done.pick);
    else ask_(pz);
  };

  /** Waiting for the pick: the board's own targets, as in a game. */
  const ask_ = (pz: Puzzle) => {
    const s = pz.state;
    cap.classList.remove('plain', 'line');
    q('.rpdice').replaceChildren();
    text.textContent = 'Tap the move you would play.';
    foot.innerHTML = '<p class="pznote"></p>';
    foot.querySelector('.pznote')!.textContent = `${s.moves.length} moves to choose from`;
    view!.showTargets(moveTargets(s.players, s.moves), (t) => void choose(pz, s.moves.indexOf(t.move)));
  };

  const choose = async (pz: Puzzle, i: number) => {
    if (i < 0) return;
    view!.clearMovable();
    const r = checkPick(pz, i);
    const next = played(log, today, tab, { pick: i, best: r.isBest });
    const first = next !== log;
    // Stored before the gold is paid: a failed write loses the gold rather than paying it twice.
    const saved = first && canSave && (await savePuzzleLog(next));
    log = next;
    if (saved) earn(goldOf(r.isBest));
    drawHead();
    reveal(pz, i, saved);
  };

  /** The verdict on pick `i`: the review's caption, the paths, the streak and the gold. */
  const reveal = (pz: Puzzle, i: number, fresh = false) => {
    const s = pz.state;
    const r = checkPick(pz, i);
    // The labels' cuts come from review.ts (calibrated per layout), never from the UI.
    const label = r.isBest ? 'best' : labelOf(r.lost, 0, layoutKey(s));
    const pv = plainVerdict({ label, played: i, best: pz.best, gap: r.lost }, s, 'You');
    cap.classList.add('plain');
    cap.classList.remove('line');
    q('.rpdice').replaceChildren();
    text.replaceChildren(span('vtag', pv.name, `--c:${pv.color}`));
    if (r.isBest) text.append(span('vwin', `${r.bestChance}% to win`, `color:${LABEL_LOOK.best.color}`));
    // What the pick cost, the review's way: "−3% to win" in the label's colour (a plus in green would read as a gain).
    else text.append(span('vwin', toWin(-r.lost), `color:${pv.color}`));
    const line = document.createElement('span');
    line.className = 'vline';
    for (const part of pv.parts) line.append(typeof part === 'string' ? part : span(`vp ${part.pill}`, part.text));
    text.append(line);
    const why = pv.better ? whyLine(whyFacts(s.players, s.moves[i]!, s.moves[pz.best]!, s.singles), 'your', true) : null;
    if (why) text.append(span('vwhy', why));
    view!.layout(s.players);
    view!.markMoved([]);
    view!.showVerdict({ played: s.moves[i]!, best: r.isBest ? undefined : s.moves[pz.best]! });
    const n = streakNow(log, today);
    const gold = goldOf(r.isBest);
    const other: Which = tab === 'daily' ? 'expert' : 'daily';
    const next = found[other] && !picksOf(log, today)[other] ? other : null;
    const hasLine = !!lineStates(pz);
    foot.innerHTML = `
      <div class="pzday"><span class="dots" aria-hidden="true">${weekDots(n)}</span><b>${n} ${n === 1 ? 'day' : 'days'} in a row</b>${canSave ? `<em class="gp${fresh ? ' pop' : ''}"><i class="coin"></i>+${gold}</em>` : ''}</div>
      <div class="pzbtns${hasLine ? '' : ' one'}">${hasLine ? '<button class="pzsec disp" data-act="line">▶ ONE WAY IT COULD GO</button>' : ''}${next ? `<button class="b3 blue disp" data-act="other">${next === 'expert' ? 'EXPERT' : 'TODAY'} ›</button>` : '<button class="b3 blue disp" data-act="done">DONE</button>'}</div>`;
  };

  /** The example line from the best move, on the board, step by step: an example, never a forecast. */
  const playLine = async (pz: Puzzle) => {
    const states = lineStates(pz);
    if (!states) return;
    const me = ++run;
    const mover = pz.state.players[pz.state.current]!.color;
    const name = (c: Color) => (c === mover ? 'You' : houseName(c));
    const named = (c: Color) => (c === mover ? 'you' : houseName(c));
    view!.showVerdict(null);
    view!.markMoved([]);
    view!.layout(states[0]!.players);
    cap.classList.add('plain', 'line');
    foot.innerHTML = `<div class="pzbtns"><button class="pzsec disp" data-act="line">▶ REPLAY</button><button class="b3 blue disp" data-act="answer">ANSWER</button></div>`;
    const say = (words: string, dice: number[]) => {
      text.replaceChildren(span('vtag', 'One way it could go', '--c:#cfd8ff'), span('vline', words));
      q('.rpdice').innerHTML = dice.map((d) => `<i>${dieMarkup(d, 22)}</i>`).join('');
    };
    say('From the best move', pz.state.rolls);
    let dice: number[] = [];
    for (let k = 1; k < states.length; k++) {
      await wait(k === 1 ? 500 : STEP_MS);
      if (me !== run || !el.isConnected) return;
      const before: GameState = states[k - 1]!;
      const s = states[k]!;
      const ev = s.event;
      if (ev?.type === 'rolled') dice = [...before.rolls, ev.dice];
      else if (ev?.type === 'moved') {
        say(describe(ev.move, name(ev.move.color), named), before.rolls.length ? before.rolls : dice);
        if (calm()) view!.layout(s.players);
        else await view!.animateMove(ev.move, s.players, 1.4);
        if (me !== run) return;
        view!.layout(s.players);
        view!.markMoved(ev.move.tokens.map((t) => ev.move.color + t));
      } else if (ev?.type === 'no-move') say(`${name(ev.color)} rolled ${ev.dice}: no move`, [ev.dice]);
      else if (ev?.type === 'three-sixes') say(`${name(ev.color)} rolled 6, 6, 6`, [6, 6, 6]);
    }
  };

  el.addEventListener('click', (e) => {
    const t = (e.target as Element).closest<HTMLElement>('[data-act], [data-tab]');
    if (!t) return;
    const pz = found[tab]!;
    const pick = picksOf(log, today)[tab]?.pick;
    if (t.dataset.tab) {
      if (t.dataset.tab === tab) return;
      tab = t.dataset.tab as Which;
      draw();
      return;
    }
    switch (t.dataset.act) {
      case 'back':
      case 'done':
        run++;
        back();
        break;
      case 'other':
        tab = tab === 'daily' ? 'expert' : 'daily';
        draw();
        break;
      case 'line':
        if (pick !== undefined) void playLine(pz);
        break;
      case 'answer':
        run++;
        if (pick !== undefined) reveal(pz, pick);
        break;
    }
  });
  draw();
  return el;
}
