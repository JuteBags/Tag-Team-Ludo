// The game review screen (#65, #96), a scorecard since #167 (the owner's pick A). The title is the result;
// a "You | Aarav" switch picks whose review (a bot's side is reviewed when picked). Then the story of the game in
// a sentence, accuracy and luck as big numbers, the labels as one row of counts (a count filters the moments to
// that label), a graph with the key moments pinned on it, the key moments as short rows (the turning point, the
// moves that lost most, this side's biggest rolls), and every move as a strip of cells in game order. Tapping a
// row, the graph or a cell opens the replay there, from the same side.
// The review runs in the review queue (reviewQueue.ts): leaving this screen doesn't stop it. An older review
// (another label version) shows greyed until the new one is in.
import { ownerRanking, replay, type GameRecord, type GameState } from '../engine';
import { summary, type Label, type MoveReview, type RollLuck } from '../engine/ai/review';
import { avatarSVG, cssVars, icons } from './art';
import { dieMarkup } from './dice';
import { framesOf, namesOf } from './replay';
import { follow } from './reviewQueue';
import { decisionsToReview, peopleOf, type ReviewProgress } from './reviewRun';
import { accuracyText, betterText, bigRolls, runningAccuracy, runningLuck, sixRuns, etaText, FEW_BIG_DECISIONS, evenChance, graphPoints, headline, keyMoves, LABEL_LOOK, LABELS, reviewedText, rollText, SHOW_AFTER, turningPoint, verdictText } from './reviewText';
import type { StoredReview } from './store';

const GW = 330;
const GH = 120;
/** The graph's left margin, for the 0 / 50 / 100 ticks. */
const GL = 22;

/** The review graph's tabs (#134): "Win %" (the win probability, not "Win rate", which Stats uses for games won). */
type GraphTab = 'win' | 'accuracy' | 'luck';
const GRAPH_TABS: [GraphTab, string][] = [['win', 'Win %'], ['accuracy', 'Accuracy'], ['luck', 'Luck-O-Meter']];
const GRAPH_KEY = 'ludo-graph-tab';
const loadGraphTab = (): GraphTab => {
  try {
    const v = localStorage.getItem(GRAPH_KEY);
    return v === 'accuracy' || v === 'luck' ? v : 'win';
  } catch {
    return 'win';
  }
};
/**
 * A line's end label, always inside the chart (#134): right-aligned to the end point when it ends near the
 * right edge (they all do), just above it, or below it when the point is near the top.
 */
const endLabel = (end: readonly [number, number], text: string, cls: string) => {
  const [x, y] = end;
  const ty = y < 14 ? y + 14 : y - 7;
  return `<text x="${(x - 2).toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="end" class="${cls}">${text}</text>`;
};
const saveGraphTab = (t: GraphTab) => {
  try {
    localStorage.setItem(GRAPH_KEY, t);
  } catch {
    // Storage blocked: the choice lasts for this screen.
  }
};

/** What the screen draws: the live review, or the older one while it's being redone. */
interface Shown {
  moves: MoveReview[];
  luck: RollLuck[] | null;
  finished: boolean;
  stale: boolean;
}

/**
 * The review of `rec`. `store` keeps the result with the past game (not for a game from a link).
 * `onReplayAt(at, caption, pov)` opens the replay at the first move after position `at`, with `caption` on it.
 */
export function reviewScreen(rec: GameRecord, _stored: StoredReview | undefined, onBack: () => void, onReplayAt: (at: number, caption: string, pov: number) => void, store = true, startPov?: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen review';
  const states: GameState[] = replay(rec).states;
  const last = states.at(-1)!;
  const names = namesOf(rec);
  const owners = [...new Set(rec.seats.map((s) => s.owner))].sort((a, b) => a - b);
  const people = peopleOf(rec);
  const colorOf = (o: number) => rec.seats.find((s) => s.owner === o)!.color;
  const isBot = (o: number) => !people.includes(o);
  const isYou = (o: number) => (rec.meta?.mode !== 'pvp' ? people.includes(o) : names[o] === 'You');
  const won = (o: number) => ownerRanking(last)[0] === o;
  // The replay's frames: a decision's step number, and the move that follows a roll.
  const frames = framesOf(rec).frames;
  const frameAfter = (at: number) => frames.findIndex((f) => f.at > at);
  // The title is the game's result, from the person's side (with friends: who won).
  const winner = ownerRanking(last)[0]!;
  const vs = (o: number) => owners.filter((x) => x !== o).map((x) => names[x]!).join(', ').replace(/, ([^,]*)$/, ' & $1');
  const title = rec.meta?.mode === 'pvp' ? `${names[winner]} won` : `${won(people[0] ?? 0) ? 'Won' : 'Lost'} vs ${vs(people[0] ?? 0)}`;
  el.innerHTML = `
    <div class="gtop rvtop"><button class="rbtn" data-act="back" aria-label="Back">${icons.back}</button><h1 class="disp rvtitle"></h1></div>
    <div class="rvbody">
      <div class="rvpov" role="tablist" aria-label="Whose review"></div>
      <p class="rvstale" hidden>Older review · updating…</p>
      <p class="rvhead1" hidden></p>
      <div class="rvcards"></div>
      <div class="rvgraph"></div>
      <div class="rvprog"><span></span><i class="bar"><i></i></i></div>
      <p class="rvleave">Reviews keep going while the app is open, so you can leave: what's reviewed is kept.</p>
      <h2 class="rvsec rvkeyh">Key moments</h2>
      <div class="rvfilter" hidden><span></span><button data-act="unfilter" aria-label="Show the key moments">✕</button></div>
      <div class="rvlist" role="list"></div>
      <h2 class="rvsec rvstriph" hidden>Every move</h2>
      <div class="rvstrip" role="img" hidden></div>
    </div>`;
  el.querySelector('.rvtitle')!.textContent = title;
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  let pov = startPov ?? people[0] ?? owners[0]!;
  let view: 'key' | 'all' = 'key';
  let filter: Label | null = null;
  /** The key moments list shows the five biggest until "Show N more" is tapped (#167). */
  const KEY_SHOWN = 5;
  let expanded = false;
  let prog: ReviewProgress | null = null;
  const povTotals = new Map<number, number>();

  // Whose review: one segment per player, avatar and name (#167: one obvious tap to see Aarav's). A bot's side
  // is reviewed when picked.
  const chips = q('.rvpov');
  chips.classList.toggle('compact', owners.length >= 3);
  for (const o of owners) {
    const b = document.createElement('button');
    b.className = 'rvp';
    b.dataset.pov = String(o);
    b.setAttribute('role', 'tab');
    b.setAttribute('style', cssVars(colorOf(o)));
    b.innerHTML = `<i>${avatarSVG(colorOf(o))}</i><b></b>`;
    b.querySelector('b')!.textContent = isYou(o) ? 'You' : names[o]!;
    b.setAttribute('aria-label', `${names[o]}${isBot(o) ? ' (bot)' : ''}`);
    chips.appendChild(b);
  }

  const who = (o: number) => (isYou(o) ? 'You' : names[o]!);
  /** A decision's verdict, for its row and the replay's caption: "?! Inaccuracy −4 · You moved 5 · Best: moved a pair 3". */
  const ownerName = (c: string) => { const o = rec.seats.find((x) => x.color === c)?.owner ?? 0; return isYou(o) ? 'you' : names[o]!; };
  const verdict = (m: MoveReview) => ({ ...verdictText(m, states[m.at]!, who(m.owner), ownerName), step: frameAfter(m.at) });

  /** The live review, or the older one (greyed) while the new one isn't finished. */
  const shown = (p: ReviewProgress): Shown =>
    p.old && !p.finished ? { moves: p.old.moves, luck: p.old.luck, finished: true, stale: true } : { moves: p.moves, luck: p.luck, finished: p.finished, stale: false };

  const draw = (p: ReviewProgress) => {
    prog = p;
    const d = shown(p);
    el.classList.toggle('stale', d.stale);
    q('.rvstale').hidden = !d.stale;
    chips.querySelectorAll<HTMLElement>('.rvp').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.pov) === pov);
      b.setAttribute('aria-selected', String(Number(b.dataset.pov) === pov));
    });
    const sum = summary(d.moves, d.luck ?? [], owners.length);
    const s = sum[pov]!;
    const mine = d.moves.filter((m) => m.owner === pov);
    // This side is reviewed once the review covers it and is finished.
    const ready = d.finished && (d.stale || p.who.includes(pov));
    // The story, once there's something to tell.
    const tp = ready && d.luck ? turningPoint(mine, d.luck, pov, (at) => (p.chances?.[at]?.[pov] !== undefined ? p.chances[at]![pov]! / 100 : undefined)) : null;
    const story = ready && d.luck && s.moves ? headline({ won: won(pov), accuracy: s.accuracy, name: isYou(pov) ? 'You' : names[pov]!, decider: tp?.kind === 'move' ? tp.move : undefined, keyMistakes: s.keyMistakes, inaccuracies: s.labels.inaccuracy }) : '';
    q('.rvhead1').hidden = !story;
    q('.rvhead1').textContent = story;
    // The card: accuracy (only once done: a partial one swings) and luck % side by side.
    const card = document.createElement('div');
    card.className = 'rvcard';
    card.setAttribute('style', cssVars(colorOf(pov)));
    const acc = !ready ? '…' : s.moves ? accuracyText(s.accuracy) : '–';
    const lpct = d.luck && Number.isFinite(s.luckPct) ? `${Math.round(s.luckPct)}%` : '…';
    card.innerHTML = `<div class="rvwho"><em class="ac">${acc}<small>accuracy</small></em><em class="lk">${lpct}<small>luck</small></em></div>
      <div class="rvchips">${LABELS.map((l) => `<button data-filter="${l}" style="--c:${LABEL_LOOK[l].color}" aria-label="${LABEL_LOOK[l].name}: ${s.labels[l]}"${filter === l ? ' class="on"' : ''}><i>${LABEL_LOOK[l].sym}</i>${s.labels[l]}</button>`).join('')}</div>
`;
    // No accuracy for a game without a decision where much was at stake: say why under the card's top row.
    if (ready && s.moves && !Number.isFinite(s.accuracy)) {
      const few = document.createElement('p');
      few.className = 'rvfew';
      few.textContent = FEW_BIG_DECISIONS;
      card.querySelector('.rvwho')!.after(few);
    }
    // No "N key mistakes" line under the name: the tiles below already count every label, and its "key"
    // (mistakes and blunders) read against the Key moves list, which has inaccuracies too (#158 review).
    // Everyone else's luck is on their own side of the switch (#167): no "Aarav's dice" rows here.
    q('.rvcards').replaceChildren(card);
    graphLuck = d.luck ?? [];
    drawGraph(mine, tp);
    // Progress: how far, about how long is left, and once done, when.
    // Progress for the side shown: its decisions only.
    const povTotal = povTotals.get(pov) ?? (povTotals.set(pov, decisionsToReview(rec, states, [pov])), povTotals.get(pov)!);
    const povDone = p.moves.filter((m) => m.owner === pov).length;
    const eta = etaText(p.eta);
    q('.rvprog span').textContent = p.finished
      ? [`${povDone} moves reviewed`, reviewedText(p.when)].filter(Boolean).join(' · ')
      : `${d.stale ? 'Updating' : 'Reviewing'}… ${povDone} of ${povTotal}${eta ? ` · ${eta}` : ''}`;
    q<HTMLElement>('.rvprog .bar i').style.width = `${povTotal ? (100 * povDone) / povTotal : 100}%`;
    q('.rvprog').classList.toggle('done', p.finished);
    q('.rvleave').hidden = p.finished;
    drawList(d, mine, tp);
    drawStrip(d, mine);
  };

  // The graph: this side's winning chances after each of their reviewed moves, on a 0-100 axis with the even
  // line, the final chance and a ★ at the turning point. A tap anywhere picks the nearest move.
  let graphMoves: MoveReview[] = [];
  // Which line the graph shows (#134): Win % (the win probability), Accuracy or Luck; remembered.
  let graphTab: GraphTab = loadGraphTab();
  let graphLuck: RollLuck[] = [];
  const drawGraph = (mine: MoveReview[], tp: ReturnType<typeof turningPoint>) => {
    graphMoves = mine;
    if (mine.length < SHOW_AFTER) {
      q('.rvgraph').innerHTML = '';
      return;
    }
    if (graphTab !== 'win') return drawLine(mine);
    // The line ends where the game ended: 100% for a win, 0% otherwise (only once the review is finished).
    const result = prog?.finished ? [won(pov) ? 1 : 0] : [];
    const pts = graphPoints([...mine.map((m) => m.playedChance), ...result], GW - GL, GH).map(([x, y]) => [x + GL, y] as const);
    const even = GH * (1 - evenChance(owners.length) / 100);
    const end = pts.at(-1)!;
    const tick = (v: number) => `<text x="${GL - 5}" y="${GH * (1 - v / 100) + 3.5}" text-anchor="end" class="tick">${v}</text><line x1="${GL}" x2="${GW}" y1="${GH * (1 - v / 100)}" y2="${GH * (1 - v / 100)}" class="grid"/>`;
    // The turning point sits on its move, or on the first of this side's moves after its roll.
    const ti = !tp ? -1 : tp.kind === 'move' ? mine.indexOf(tp.move) : mine.findIndex((m) => m.at > tp.roll.at);
    const star = ti >= 0 ? pin(pts[ti]![0], pts[ti]![1], '#ffd23f', '★', 'tp') : '';
    q('.rvgraph').innerHTML = `${graphTabs()}<svg viewBox="-6 -12 ${GW + 40} ${GH + 22}" aria-hidden="true">
        ${[0, 50, 100].map(tick).join('')}
        <line x1="${GL}" y1="${even}" x2="${GW}" y2="${even}" class="even"/>
        <polyline points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>
        ${pts.slice(0, mine.length).map(([x, y], i) => (mine[i]!.label === 'best' || mine[i]!.label === 'good' || i === ti ? '' : mine[i]!.label === 'inaccuracy' ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" class="dot" style="fill:${LABEL_LOOK.inaccuracy.color}"/>` : pin(x, y, LABEL_LOOK[mine[i]!.label].color, LABEL_LOOK[mine[i]!.label].sym))).join('')}
        ${star}
        ${endLabel(end, `${Math.round(100 * (result[0] ?? mine.at(-1)!.playedChance))}%`, 'final')}
        <rect class="hit" x="${GL}" y="-12" width="${GW - GL}" height="${GH + 22}" fill="transparent"/></svg>`;
  };
  /** A moment on the graph: its label's symbol in a ring of its colour. */
  const pin = (x: number, y: number, c: string, sym: string, cls = '') =>
    `<g class="pin ${cls}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle r="8.5" style="stroke:${c}"/><text y="3.5" text-anchor="middle" style="fill:${c}" font-size="${sym.length > 1 ? 7.5 : 9.5}">${sym}</text></g>`;
  const graphTabs = () =>
    `<div class="rvgtabs" role="tablist">${GRAPH_TABS.map(([k, name]) => `<button data-gtab="${k}" role="tab" aria-selected="${k === graphTab}"${k === graphTab ? ' class="on"' : ''}>${name}</button>`).join('')}</div>`;
  /**
   * The accuracy graph (accuracy so far after each reviewed move, from the 5th counted decision: solid sky blue)
   * or the luck graph (the luck percentile so far after each roll, around the 50% of average luck: dashed
   * orange), each labelled at its end; colours safe for colour-blindness, and solid vs dashed besides (#134).
   */
  const drawLine = (mine: MoveReview[]) => {
    const y = (v: number) => GH * (1 - v / 100);
    const tick = (v: number) => `<text x="${GL - 5}" y="${y(v) + 3.5}" text-anchor="end" class="tick">${v}</text><line x1="${GL}" x2="${GW}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`;
    let pts: [number, number][] = [];
    let faded: [number, number][] = [];
    let label = '';
    if (graphTab === 'accuracy') {
      // From the first counted decision: faded and thinner until the 5th (an early running accuracy is noisy), then solid.
      const { values, solidFrom } = runningAccuracy(mine);
      const n = Math.max(1, mine.length - 1);
      const at = (i: number) => [GL + (i / n) * (GW - GL), y(100 * values[i]!)] as [number, number];
      const idx = values.flatMap((v, i) => (v === null ? [] : [i]));
      faded = idx.filter((i) => i <= solidFrom).map(at);
      pts = idx.filter((i) => i >= solidFrom).map(at);
      const lastV = values.at(-1);
      label = idx.length && lastV !== null && lastV !== undefined ? `Accuracy ${Math.round(100 * lastV)}%` : '';
      if (!pts.length) pts = [];
    } else {
      const last = Math.max(1, states.length - 1);
      const luck = runningLuck(graphLuck, pov);
      pts = luck.map((l) => [GL + (l.at / last) * (GW - GL), y(l.pct)] as [number, number]);
      label = luck.length ? `Luck ${Math.round(luck.at(-1)!.pct)}%` : '';
    }
    const end = pts.at(-1) ?? faded.at(-1);
    const poly = (ps: [number, number][], cls: string) => (ps.length > 1 ? `<polyline class="${cls}" points="${ps.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')}"/>` : '');
    const mid = graphTab === 'luck' ? `<line x1="${GL}" y1="${y(50)}" x2="${GW}" y2="${y(50)}" class="even"/><text x="${GW - 4}" y="${y(50) + 12}" text-anchor="end">average luck</text>` : '';
    q('.rvgraph').innerHTML = `${graphTabs()}<svg viewBox="-6 -12 ${GW + 40} ${GH + 22}" aria-hidden="true">
        ${[0, 50, 100].map(tick).join('')}${mid}
        ${poly(faded, `${graphTab} early`)}${poly(pts, graphTab)}
        ${end ? `<circle class="${graphTab}" cx="${end[0].toFixed(1)}" cy="${end[1].toFixed(1)}" r="3.5"/>${endLabel(end, label, `final ${graphTab}`)}` : ''}
        ${graphTab === 'accuracy' ? `<rect class="hit" x="${GL}" y="-12" width="${GW - GL}" height="${GH + 22}" fill="transparent"/>` : ''}</svg>`;
  };

  const KEY = new Set<Label>(['inaccuracy', 'mistake', 'blunder']);
  /** A moment's swing, in the review's one unit: "−5%" (of win probability). */
  const swing = (x: number) => `${x >= 0 ? '+' : '−'}${Math.max(1, Math.round(Math.abs(x)))}%`;
  const moveRow = (m: MoveReview, turning = false) => {
    const look = LABEL_LOOK[m.label];
    const v = verdict(m);
    const b = document.createElement('button');
    b.className = `rvrow ${m.label}${turning ? ' turning' : ''}`;
    b.dataset.at = String(m.at);
    b.setAttribute('role', 'listitem');
    const cost = m.label !== 'best' && m.gap >= 1;
    b.innerHTML = `<i style="--c:${turning ? '#ffd23f' : look.color}">${turning ? '★' : look.sym}</i><span><b></b><small></small></span>${cost ? `<strong class="rvswing neg">${swing(-m.gap)}</strong>` : ''}`;
    b.querySelector('b')!.textContent = turning ? 'Turning point' : look.name;
    // What was better, for the moves that cost something: the only place it shows before the replay (#174 review).
    const st = states[m.at]!;
    const better = KEY.has(m.label) && m.played !== m.best ? ` · Better: ${betterText(st, st.moves[m.played]!, st.moves[m.best]!, ownerName)}` : '';
    b.querySelector('small')!.textContent = `Move ${v.step > 0 ? v.step : '?'}${better}`;
    b.setAttribute('aria-label', `${turning ? 'Turning point: ' : ''}${v.head}. Move ${v.step}. ${v.line}`);
    return b;
  };
  const rollRow = (r: RollLuck, turning = false) => {
    const b = document.createElement('button');
    b.className = `rvrow roll${turning ? ' turning' : ''}`;
    b.dataset.roll = String(r.at);
    b.setAttribute('role', 'listitem');
    const step = frameAfter(r.at);
    const x = r.run ?? r.luck;
    // Dice are never judged (the owner: no green or red on luck): the swing is neutral and its sign says which way.
    // On another side's review the roll is named, since the swing is the roller's.
    const theirs = r.owner !== pov;
    b.innerHTML = `<i class="die">${dieMarkup(r.face, 24)}</i><span><b></b><small></small></span><strong class="rvswing other">${swing(x)}</strong>`;
    const what = r.run !== undefined ? 'Three 6s cancelled' : theirs ? `${isYou(r.owner) ? 'Your' : `${names[r.owner]}'s`} dice` : 'Dice';
    b.querySelector('b')!.textContent = turning ? 'Turning point' : what;
    b.querySelector('small')!.textContent = `Move ${step > 0 ? step : '?'}${turning && (theirs || r.run !== undefined) ? ` · ${what}` : ''}`;
    b.setAttribute('aria-label', `${turning ? 'Turning point: ' : ''}${rollText(r, names[r.owner]!, isYou(r.owner))}. Move ${step}. ${frames[step]?.caption ?? ''}`);
    return b;
  };
  /** A decision still to review (#93): where it is in the game, and "…" until its verdict lands. */
  const pendingRow = (at: number, checking: boolean) => {
    const r = document.createElement('div');
    r.className = `rvrow pending${checking ? ' checking' : ''}`;
    r.setAttribute('role', 'listitem');
    const step = frameAfter(at);
    r.innerHTML = `<i aria-hidden="true">…</i><span><b></b><small></small></span>`;
    r.querySelector('b')!.textContent = checking ? 'Checking this move…' : 'Not checked yet';
    r.querySelector('small')!.textContent = `Move ${step > 0 ? step : '?'}`;
    return r;
  };
  /** How many decisions still to check the key view lists before "+N more". */
  const PENDING_SHOWN = 8;
  /**
   * While a review runs (#93): this side's decisions straight away, biggest at stake first (the order the
   * review works in), each a verdict once it lands or "…" until then. Verdicts from an earlier run (the
   * biggest, done first then) lead. `all`: every decision in game order instead.
   */
  const checkingList = (list: HTMLElement, p: ReviewProgress, mine: MoveReview[], all: boolean) => {
    const done = new Map(mine.map((m) => [m.at, m]));
    const skipped = new Set(p.skipped ?? []);
    const ownerAt = (at: number) => states[at]!.players[states[at]!.current]!.owner;
    const order = (p.order ?? []).filter((at) => ownerAt(at) === pov && !skipped.has(at));
    const next = (p.order ?? []).find((at) => !done.has(at) && !skipped.has(at) && !p.moves.some((m) => m.at === at));
    const inOrder = new Set(order);
    const ats = all ? [...new Set([...mine.map((m) => m.at), ...order])].sort((a, b) => a - b) : [...mine.filter((m) => !inOrder.has(m.at)).map((m) => m.at), ...order];
    let pending = 0;
    let more = 0;
    for (const at of ats) {
      const m = done.get(at);
      if (m) {
        if (!filter || m.label === filter) list.appendChild(moveRow(m));
      } else if (!filter) {
        if (!all && pending >= PENDING_SHOWN) more++;
        else {
          list.appendChild(pendingRow(at, at === next));
          pending++;
        }
      }
    }
    if (more) list.appendChild(note(`+${more} more to check`));
  };

  const note = (text: string) => {
    const p = document.createElement('p');
    p.className = 'rvnote';
    p.textContent = text;
    return p;
  };

  const drawList = (d: Shown, mine: MoveReview[], tp: ReturnType<typeof turningPoint>) => {
    const f = q('.rvfilter');
    f.hidden = !filter;
    // The heading names the filter ("Inaccuracy moves"); the bar is just its ✕, on the heading's line (#167).
    f.querySelector('span')!.textContent = '';
    const list = q('.rvlist');
    list.replaceChildren();
    // While the review runs: every decision straight away, "…" until its verdict lands (#93).
    q('.rvkeyh').textContent = !d.finished && !d.stale && prog?.order && !filter ? 'Biggest decisions first' : filter ? `${LABEL_LOOK[filter].name} moves` : 'Key moments';
    if (!d.finished && !d.stale && prog?.order) {
      checkingList(list, prog, mine, false);
      return;
    }
    if (mine.length < SHOW_AFTER && !d.finished) return;
    if (view === 'all') {
      const shownMoves = filter ? mine.filter((m) => m.label === filter) : mine;
      for (const m of shownMoves) list.appendChild(moveRow(m));
      if (!shownMoves.length) list.appendChild(note(filter ? `No ${LABEL_LOOK[filter].name.toLowerCase()} moves${d.finished ? '' : ' so far'}.` : d.finished ? 'No moves to review.' : 'Reviewing…'));
      return;
    }
    // The turning point first, then the key moves, then the rolls that swung the game.
    if (tp) list.appendChild(tp.kind === 'move' ? moveRow(tp.move, true) : rollRow(tp.roll, true));
    const key = keyMoves(mine).filter((m) => !(tp?.kind === 'move' && tp.move === m));
    for (const m of expanded ? key : key.slice(0, KEY_SHOWN)) list.appendChild(moveRow(m));
    if (!expanded && key.length > KEY_SHOWN) {
      const more = document.createElement('button');
      more.className = 'rvmore';
      more.dataset.act = 'more';
      more.textContent = `Show ${key.length - KEY_SHOWN} more`;
      list.appendChild(more);
    }
    if (!key.length && !(tp?.kind === 'move')) list.appendChild(note(d.finished ? 'Clean game: every move was Best or Good.' : 'No mistakes so far.'));
    if (d.luck?.length) {
      // This side's own biggest rolls, after its moves (anyone else's are on their side of the switch).
      const big = bigRolls(d.luck.filter((r) => r.owner === pov)).filter((r) => !(tp?.kind === 'roll' && tp.roll.at === r.at));
      for (const r of big) list.appendChild(rollRow(r));
      // This person's cancelled runs of three 6s (#135) are always listed: one row each, after the big ones.
      const shown = new Set([...big.map((r) => r.at), ...(tp?.kind === 'roll' ? [tp.roll.at] : [])]);
      for (const r of sixRuns(d.luck, pov).filter((r) => !shown.has(r.at))) list.appendChild(rollRow(r));
    }
  };

  /** Every decision of this side in game order, one cell each: its label's colour, or grey until checked. */
  const drawStrip = (d: Shown, mine: MoveReview[]) => {
    const strip = q('.rvstrip');
    const total = povTotals.get(pov) ?? 0;
    const cells = mine.length + Math.max(0, d.finished ? 0 : total - mine.length);
    q('.rvstriph').hidden = strip.hidden = cells < SHOW_AFTER;
    const n = Object.fromEntries(LABELS.map((l) => [l, mine.filter((m) => m.label === l).length]));
    strip.setAttribute('aria-label', `Every move: ${LABELS.map((l) => `${n[l]} ${LABEL_LOOK[l].name}`).join(', ')}`);
    strip.innerHTML =
      mine.map((m) => `<i data-at="${m.at}" class="${m.label}${filter && m.label !== filter ? ' dim' : ''}" style="--c:${LABEL_LOOK[m.label].color}"></i>`).join('') +
      '<i class="todo"></i>'.repeat(Math.max(0, cells - mine.length));
  };

  let unfollow = () => {};
  const watchPov = () => {
    unfollow();
    unfollow = follow(rec, draw, { keep: store, open: true, who: [pov], pvp: rec.meta?.mode === 'pvp' });
  };

  el.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t.closest('[data-act=back]')) {
      unfollow();
      onBack();
      return;
    }
    if (t.closest('[data-act=more]')) {
      expanded = true;
      if (prog) draw(prog);
      return;
    }
    const pv = t.closest<HTMLElement>('[data-pov]')?.dataset.pov;
    if (pv !== undefined) {
      pov = Number(pv);
      filter = null;
      view = 'key';
      watchPov();
      if (prog) draw(prog);
      return;
    }

    const chip = t.closest<HTMLElement>('[data-filter]')?.dataset.filter as Label | undefined;
    if (chip || t.closest('[data-act=unfilter]')) {
      // A count shows just those moves; tapping it again (or ✕) shows them all.
      filter = chip && chip !== filter ? chip : null;
      expanded = false;
      view = filter ? 'all' : 'key';
      if (prog) draw(prog);
      if (filter) q('.rvkeyh').scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const gt = t.closest<HTMLElement>('[data-gtab]')?.dataset.gtab as GraphTab | undefined;
    if (gt) {
      graphTab = gt;
      saveGraphTab(gt);
      if (prog) draw(prog);
      return;
    }
    const hit = t.closest('.rvgraph .hit');
    if (hit && graphMoves.length) {
      // The nearest move to the tap: shown in the full list.
      const box = hit.getBoundingClientRect();
      const x = (e as MouseEvent).clientX - box.left;
      // The graph may end with the result point after the last move: a tap there picks the last move.
      const points = graphMoves.length + (prog?.finished && graphTab === 'win' ? 1 : 0);
      const i = Math.max(0, Math.min(graphMoves.length - 1, Math.round((x / box.width) * (points - 1))));
      // The replay at that move (#167): the graph is a way into the game, like the rows.
      unfollow();
      onReplayAt(graphMoves[i]!.at, '', pov);
      return;
    }
    const strip = t.closest<HTMLElement>('.rvstrip');
    if (strip) {
      // The nearest checked cell to the tap, as taps on the board go to the nearest pawn.
      const ev = e as MouseEvent;
      let best: HTMLElement | null = null;
      let bd = Infinity;
      strip.querySelectorAll<HTMLElement>('i[data-at]').forEach((c) => {
        const r = c.getBoundingClientRect();
        const dd = Math.hypot(r.left + r.width / 2 - ev.clientX, r.top + r.height / 2 - ev.clientY);
        if (dd < bd) [bd, best] = [dd, c];
      });
      if (best && bd < 40) {
        unfollow();
        onReplayAt(Number((best as HTMLElement).dataset.at), '', pov);
      }
      return;
    }
    const row = t.closest<HTMLElement>('.rvrow');
    if (!row || !prog) return;
    unfollow();
    const d = shown(prog);
    if (row.dataset.roll !== undefined) {
      const r = d.luck?.find((x) => x.at === Number(row.dataset.roll));
      const step = r ? frameAfter(r.at) : -1;
      // A cancelled run's caption is the event alone: the fanned dice already show the roll (#142 UI review).
      onReplayAt(Number(row.dataset.roll), r ? `${rollText(r, names[r.owner]!, isYou(r.owner))}${frames[step] && r.run === undefined ? ` · ${frames[step]!.caption}` : ''}` : '', pov);
    } else {
      // No caption of its own: the replay says the verdict in its plain words (#124).
      onReplayAt(Number(row.dataset.at), '', pov);
    }
  });
  // Until the queue reports, an empty card (the skeleton) rather than a blank screen.
  draw({ moves: [], luck: null, chances: null, who: [pov], done: 0, total: 0, finished: false, eta: null, mine: { done: 0, total: 0, finished: false } });
  watchPov();
  return el;
}
