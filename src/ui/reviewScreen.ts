// The game review screen (#65, #96). From one player's side (the chips at the top pick whose: you by default;
// a bot's side is reviewed when its chip is tapped): the story of the game in a sentence, accuracy and luck %
// side by side, the labels of their moves, a graph of their winning chances with the turning point, and the
// moves as verdicts come in. It opens on the key moves (the turning point, the moves that lost something
// worst first, and the rolls that swung the game); "All moves" lists every verdict in game order, and a
// label's count filters to it. Tapping a move or a roll opens the replay there, from the same side.
// The review runs in the review queue (reviewQueue.ts): leaving this screen doesn't stop it. An older review
// (another label version) shows greyed until the new one is in.
import { ownerRanking, replay, type GameRecord, type GameState } from '../engine';
import { summary, type Label, type MoveReview, type RollLuck } from '../engine/ai/review';
import { avatarSVG, cssVars, icons } from './art';
import { dieMarkup } from './dice';
import { framesOf, namesOf } from './replay';
import { follow } from './reviewQueue';
import { decisionsToReview, peopleOf, type ReviewProgress } from './reviewRun';
import { accuracyText, bigRolls, runningAccuracy, runningLuck, sixRuns, etaText, FEW_BIG_DECISIONS, evenChance, graphPoints, headline, keyMoves, LABEL_LOOK, LABELS, reviewedText, rollText, SHOW_AFTER, turningPoint, verdictText } from './reviewText';
import type { StoredReview } from './store';

const GW = 330;
const GH = 96;
/** The graph's left margin, for the 0 / 50 / 100 ticks. */
const GL = 22;

/** The review graph's tabs (#134): "Win %" (the win probability, not "Win rate", which Stats uses for games won). */
type GraphTab = 'win' | 'accuracy' | 'luck';
const GRAPH_TABS: [GraphTab, string][] = [['win', 'Win %'], ['accuracy', 'Accuracy'], ['luck', 'Luckometer']];
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
  const mode = rec.meta?.mode === 'pvp' ? 'WITH FRIENDS' : 'VS COMPUTER';
  el.innerHTML = `
    <div class="gtop"><button class="rbtn" data-act="back" aria-label="Back">${icons.back}</button>
      <div class="mode"><small>GAME REVIEW · ${mode}</small><b>${owners.length} PLAYERS</b></div><span class="rbtn-space"></span></div>
    <div class="rvbody">
      <div class="rvpov" role="tablist" aria-label="Whose game"></div>
      <p class="rvstale" hidden>Older review · updating…</p>
      <p class="rvhead1" hidden></p>
      <div class="rvcards"></div>
      <div class="rvgraph"></div>
      <div class="rvprog"><span></span><i class="bar"><i></i></i></div>
      <p class="rvleave">Reviews keep going while the app is open, so you can leave: what's reviewed is kept.</p>
      <div class="rvtabs" role="tablist"><button role="tab" data-view="key">Key moves</button><button role="tab" data-view="all">All moves</button></div>
      <div class="rvfilter" hidden><span></span><button data-act="unfilter" aria-label="Show all moves">✕</button></div>
      <div class="rvlist" role="list"></div>
    </div>`;
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  let pov = startPov ?? people[0] ?? owners[0]!;
  let view: 'key' | 'all' = 'key';
  let filter: Label | null = null;
  let prog: ReviewProgress | null = null;
  const povTotals = new Map<number, number>();

  // Whose game: a chip per player; bots say BOT and are reviewed when picked.
  const chips = q('.rvpov');
  // Three or more players: the chips not picked show their avatar only, so the row stays one line.
  chips.classList.toggle('compact', owners.length >= 3);
  for (const o of owners) {
    const b = document.createElement('button');
    b.className = 'rvp';
    b.dataset.pov = String(o);
    b.setAttribute('role', 'tab');
    b.setAttribute('style', cssVars(colorOf(o)));
    b.innerHTML = `<i>${avatarSVG(colorOf(o))}</i><b></b>${isBot(o) ? '<small>BOT</small>' : ''}`;
    b.querySelector('b')!.textContent = names[o]!;
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
    const story = ready && d.luck && s.moves ? headline({ won: won(pov), accuracy: s.accuracy, luckPct: s.luckPct, name: isYou(pov) ? 'You' : names[pov]!, decider: tp?.kind === 'move' ? tp.move : undefined, keyMistakes: s.keyMistakes, inaccuracies: s.labels.inaccuracy }) : '';
    q('.rvhead1').hidden = !story;
    q('.rvhead1').textContent = story;
    // The card: accuracy (only once done: a partial one swings) and luck % side by side.
    const card = document.createElement('div');
    card.className = 'rvcard';
    card.setAttribute('style', cssVars(colorOf(pov)));
    const acc = !ready ? '…' : s.moves ? accuracyText(s.accuracy) : '–';
    const lpct = d.luck && Number.isFinite(s.luckPct) ? `${Math.round(s.luckPct)}%` : '…';
    card.innerHTML = `<div class="rvwho"><i>${avatarSVG(colorOf(pov))}</i><b></b>
        <em>${acc}<small>accuracy</small></em><em class="lk">${lpct}<small>luck</small></em></div>
      <div class="rvchips">${LABELS.map((l) => `<button data-filter="${l}" style="--c:${LABEL_LOOK[l].color}" aria-label="${LABEL_LOOK[l].name}: ${s.labels[l]}"${filter === l ? ' class="on"' : ''}><i>${LABEL_LOOK[l].sym}</i>${s.labels[l]}</button>`).join('')}</div>
`;
    card.querySelector('.rvwho b')!.textContent = names[pov]!;
    // No accuracy for a game without a decision where much was at stake: say why under the card's top row.
    if (ready && s.moves && !Number.isFinite(s.accuracy)) {
      const few = document.createElement('p');
      few.className = 'rvfew';
      few.textContent = FEW_BIG_DECISIONS;
      card.querySelector('.rvwho')!.after(few);
    }
    // With accuracy: how many moves really cost something (mistakes and blunders).
    if (ready && s.moves) {
      const km = document.createElement('small');
      km.className = 'km';
      km.textContent = s.keyMistakes ? `${s.keyMistakes} key mistake${s.keyMistakes === 1 ? '' : 's'}` : 'No key mistakes';
      card.querySelector('.rvwho b')!.append(km);
    }
    // Everyone else's dice, one line each.
    const others = d.luck
      ? owners
          .filter((o) => o !== pov)
          .map((o) => {
            const row = document.createElement('div');
            row.className = 'rvbotluck';
            row.innerHTML = `<i style="${cssVars(colorOf(o))}">${avatarSVG(colorOf(o))}</i><span></span><b>${Number.isFinite(sum[o]!.luckPct) ? Math.round(sum[o]!.luckPct) : '–'}%</b>`;
            row.querySelector('span')!.textContent = isYou(o) ? 'Your dice' : `${names[o]}'s dice`;
            return row;
          })
      : [];
    q('.rvcards').replaceChildren(card, ...others);
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
    const star = ti >= 0 ? `<g class="tpstar" transform="translate(${pts[ti]![0].toFixed(1)} ${(pts[ti]![1] - 12).toFixed(1)})"><path d="M0,-7 L2,-2 7,-2 3,1.5 4.5,6.5 0,3.5 -4.5,6.5 -3,1.5 -7,-2 -2,-2Z"/></g>` : '';
    q('.rvgraph').innerHTML = `<small></small>${graphTabs()}<svg viewBox="-6 -8 ${GW + 40} ${GH + 16}" aria-hidden="true">
        ${[0, 50, 100].map(tick).join('')}
        <line x1="${GL}" y1="${even}" x2="${GW}" y2="${even}" class="even"/><text x="${GL + 4}" y="${even - 4}">even</text>
        <polyline points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>
        ${pts.slice(0, mine.length).map(([x, y], i) => (mine[i]!.label === 'best' || mine[i]!.label === 'good' ? '' : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${LABEL_LOOK[mine[i]!.label].color}"/>`)).join('')}
        ${star}
        ${endLabel(end, `${Math.round(100 * (result[0] ?? mine.at(-1)!.playedChance))}%`, 'final')}
        <rect class="hit" x="${GL}" y="-8" width="${GW - GL}" height="${GH + 16}" fill="transparent"/></svg>`;
    // Names go in as text, like everywhere else.
    q('.rvgraph small').textContent = `${isYou(pov) ? 'Your' : `${names[pov]}'s`} win probability`;
  };
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
    q('.rvgraph').innerHTML = `<small></small>${graphTabs()}<svg viewBox="-6 -8 ${GW + 40} ${GH + 16}" aria-hidden="true">
        ${[0, 50, 100].map(tick).join('')}${mid}
        ${poly(faded, `${graphTab} early`)}${poly(pts, graphTab)}
        ${end ? `<circle class="${graphTab}" cx="${end[0].toFixed(1)}" cy="${end[1].toFixed(1)}" r="3.5"/>${endLabel(end, label, `final ${graphTab}`)}` : ''}
        ${graphTab === 'accuracy' ? `<rect class="hit" x="${GL}" y="-8" width="${GW - GL}" height="${GH + 16}" fill="transparent"/>` : ''}</svg>`;
    const who = isYou(pov) ? 'Your' : `${names[pov]}'s`;
    q('.rvgraph small').textContent = graphTab === 'accuracy' ? `${who} accuracy so far` : `${who} Luckometer`;
  };

  const moveRow = (m: MoveReview, turning = false) => {
    const look = LABEL_LOOK[m.label];
    const v = verdict(m);
    const b = document.createElement('button');
    b.className = `rvrow ${m.label}${turning ? ' turning' : ''}`;
    b.dataset.at = String(m.at);
    b.setAttribute('role', 'listitem');
    b.innerHTML = `<i style="--c:${look.color}">${look.sym}</i><span>${turning ? '<em>★ Turning point</em>' : ''}<b></b><small></small></span>`;
    b.querySelector('b')!.textContent = v.head;
    b.querySelector('small')!.textContent = `Move ${v.step > 0 ? v.step : '?'} · ${v.line}`;
    return b;
  };
  const rollRow = (r: RollLuck, turning = false) => {
    const b = document.createElement('button');
    b.className = `rvrow roll${turning ? ' turning' : ''}`;
    b.dataset.roll = String(r.at);
    b.setAttribute('role', 'listitem');
    const step = frameAfter(r.at);
    b.innerHTML = `<i class="die">${dieMarkup(r.face, 24)}</i><span>${turning ? '<em>★ Turning point</em>' : ''}<b></b><small></small></span>`;
    b.querySelector('b')!.textContent = rollText(r, names[r.owner]!, isYou(r.owner));
    b.querySelector('small')!.textContent = `Move ${step > 0 ? step : '?'} · ${frames[step]?.caption ?? ''}`;
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
    r.querySelector('small')!.textContent = `Move ${step > 0 ? step : '?'} · ${frames[step]?.caption ?? ''}`;
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
    el.querySelectorAll<HTMLElement>('.rvtabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.view === view);
      b.setAttribute('aria-selected', String(b.dataset.view === view));
    });
    const f = q('.rvfilter');
    f.hidden = !filter;
    if (filter) f.querySelector('span')!.textContent = `Showing ${LABEL_LOOK[filter].sym} ${LABEL_LOOK[filter].name} only`;
    const list = q('.rvlist');
    list.replaceChildren();
    // While the review runs: every decision straight away, "…" until its verdict lands (#93).
    if (!d.finished && !d.stale && prog?.order) {
      if (view === 'key') {
        const h = document.createElement('h3');
        h.className = 'rvhead';
        h.textContent = 'Biggest decisions first';
        list.appendChild(h);
      }
      checkingList(list, prog, mine, view === 'all');
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
    for (const m of key) list.appendChild(moveRow(m));
    if (!key.length && !(tp?.kind === 'move')) list.appendChild(note(d.finished ? 'Clean game: every move was Best or Good.' : 'No mistakes so far.'));
    if (d.luck?.length) {
      const h = document.createElement('h3');
      h.className = 'rvhead';
      h.textContent = 'Big dice moments';
      list.appendChild(h);
      const big = bigRolls(d.luck).filter((r) => !(tp?.kind === 'roll' && tp.roll.at === r.at));
      for (const r of big) list.appendChild(rollRow(r));
      // This person's cancelled runs of three 6s (#135) are always listed: one row each, after the big ones.
      const shown = new Set([...big.map((r) => r.at), ...(tp?.kind === 'roll' ? [tp.roll.at] : [])]);
      for (const r of sixRuns(d.luck, pov).filter((r) => !shown.has(r.at))) list.appendChild(rollRow(r));
    }
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
    const pv = t.closest<HTMLElement>('[data-pov]')?.dataset.pov;
    if (pv !== undefined) {
      pov = Number(pv);
      filter = null;
      view = 'key';
      watchPov();
      if (prog) draw(prog);
      return;
    }
    const tab = t.closest<HTMLElement>('[data-view]')?.dataset.view as 'key' | 'all' | undefined;
    if (tab) {
      view = tab;
      filter = null;
      if (prog) draw(prog);
      return;
    }
    const chip = t.closest<HTMLElement>('[data-filter]')?.dataset.filter as Label | undefined;
    if (chip || t.closest('[data-act=unfilter]')) {
      // A count shows just those moves; tapping it again (or ✕) shows them all.
      filter = chip && chip !== filter ? chip : null;
      view = 'all';
      if (prog) draw(prog);
      if (filter) q('.rvtabs').scrollIntoView({ block: 'start', behavior: 'smooth' });
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
      const at = graphMoves[i]!.at;
      if (!el.querySelector(`.rvrow[data-at="${at}"]`)) {
        view = 'all';
        filter = null;
        if (prog) draw(prog);
      }
      el.querySelector(`.rvrow[data-at="${at}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
