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
import { bigRolls, etaText, evenChance, graphPoints, headline, keyMoves, LABEL_LOOK, LABELS, luckBand, luckWords, reviewedText, rollText, SHOW_AFTER, turningPoint, verdictText } from './reviewText';
import type { StoredReview } from './store';

const GW = 330;
const GH = 96;
/** The graph's left margin, for the 0 / 50 / 100 ticks. */
const GL = 22;

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
  for (const o of owners) {
    const b = document.createElement('button');
    b.className = 'rvp';
    b.dataset.pov = String(o);
    b.setAttribute('role', 'tab');
    b.setAttribute('style', cssVars(colorOf(o)));
    b.innerHTML = `<i>${avatarSVG(colorOf(o))}</i><b></b>${isBot(o) ? '<small>BOT</small>' : ''}`;
    b.querySelector('b')!.textContent = names[o]!;
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
    const tp = ready && d.luck ? turningPoint(mine, d.luck, pov) : null;
    const story = ready && d.luck && s.moves ? headline({ won: won(pov), accuracy: s.accuracy, luckPct: s.luckPct, name: isYou(pov) ? 'You' : names[pov]!, decider: tp?.kind === 'move' ? tp.move : undefined }) : '';
    q('.rvhead1').hidden = !story;
    q('.rvhead1').textContent = story;
    // The card: accuracy (only once done: a partial one swings) and luck % side by side.
    const card = document.createElement('div');
    card.className = 'rvcard';
    card.setAttribute('style', cssVars(colorOf(pov)));
    const acc = !ready ? '…' : s.moves ? `${Math.round(100 * s.accuracy)}%` : '–';
    const band = luckBand(s.luckPct);
    const lpct = d.luck && Number.isFinite(s.luckPct) ? `${Math.round(s.luckPct)}%` : '…';
    const words = d.luck ? luckWords(s.luck, isYou(pov)) : null;
    card.innerHTML = `<div class="rvwho"><i>${avatarSVG(colorOf(pov))}</i><b></b>
        <em>${acc}<small>accuracy</small></em><em class="lk ${d.luck ? band.tone : ''}">${lpct}<small>luck</small></em></div>
      <div class="rvchips">${LABELS.map((l) => `<button data-filter="${l}" style="--c:${LABEL_LOOK[l].color}" aria-label="${LABEL_LOOK[l].name}: ${s.labels[l]}"${filter === l ? ' class="on"' : ''}><i>${LABEL_LOOK[l].sym}</i>${s.labels[l]}</button>`).join('')}</div>
      ${words ? `<div class="rvluck ${band.tone}"><p><b>Luck ${lpct} · ${band.word}:</b> ${words.line}</p></div>` : '<div class="rvluck skel" aria-label="Working out the dice luck"><i></i><i></i></div>'}`;
    card.querySelector('.rvwho b')!.textContent = names[pov]!;
    // Everyone else's dice, one line each.
    const others = d.luck
      ? owners
          .filter((o) => o !== pov)
          .map((o) => {
            const row = document.createElement('div');
            row.className = 'rvbotluck';
            const b2 = luckBand(sum[o]!.luckPct);
            row.innerHTML = `<i style="${cssVars(colorOf(o))}">${avatarSVG(colorOf(o))}</i><span></span><b class="${b2.tone}">Luck ${Number.isFinite(sum[o]!.luckPct) ? Math.round(sum[o]!.luckPct) : '–'}% · ${b2.word}</b>`;
            row.querySelector('span')!.textContent = isYou(o) ? 'Your dice' : `${names[o]}'s dice`;
            return row;
          })
      : [];
    q('.rvcards').replaceChildren(card, ...others);
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
  const drawGraph = (mine: MoveReview[], tp: ReturnType<typeof turningPoint>) => {
    graphMoves = mine;
    if (mine.length < SHOW_AFTER) {
      q('.rvgraph').innerHTML = '';
      return;
    }
    const pts = graphPoints(mine.map((m) => m.playedChance), GW - GL, GH).map(([x, y]) => [x + GL, y] as const);
    const even = GH * (1 - evenChance(owners.length) / 100);
    const end = pts.at(-1)!;
    const tick = (v: number) => `<text x="${GL - 5}" y="${GH * (1 - v / 100) + 3.5}" text-anchor="end" class="tick">${v}</text><line x1="${GL}" x2="${GW}" y1="${GH * (1 - v / 100)}" y2="${GH * (1 - v / 100)}" class="grid"/>`;
    // The turning point sits on its move, or on the first of this side's moves after its roll.
    const ti = !tp ? -1 : tp.kind === 'move' ? mine.indexOf(tp.move) : mine.findIndex((m) => m.at > tp.roll.at);
    const star = ti >= 0 ? `<g class="tpstar" transform="translate(${pts[ti]![0].toFixed(1)} ${(pts[ti]![1] - 12).toFixed(1)})"><path d="M0,-7 L2,-2 7,-2 3,1.5 4.5,6.5 0,3.5 -4.5,6.5 -3,1.5 -7,-2 -2,-2Z"/></g>` : '';
    q('.rvgraph').innerHTML = `<small>${isYou(pov) ? 'Your' : `${names[pov]}'s`} winning chances</small><svg viewBox="-6 -8 ${GW + 40} ${GH + 16}" aria-hidden="true">
        ${[0, 50, 100].map(tick).join('')}
        <line x1="${GL}" y1="${even}" x2="${GW}" y2="${even}" class="even"/><text x="${GL + 4}" y="${even - 4}">even</text>
        <polyline points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>
        ${pts.map(([x, y], i) => (mine[i]!.label === 'best' || mine[i]!.label === 'good' ? '' : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${LABEL_LOOK[mine[i]!.label].color}"/>`)).join('')}
        ${star}
        <text x="${end[0] + 6}" y="${Math.max(8, Math.min(GH, end[1] + 4))}" class="final">${Math.round(100 * mine.at(-1)!.playedChance)}%</text>
        <rect class="hit" x="${GL}" y="-8" width="${GW - GL}" height="${GH + 16}" fill="transparent"/></svg>`;
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
    b.className = `rvrow roll ${r.luck >= 0 ? 'lucky' : 'unlucky'}${turning ? ' turning' : ''}`;
    b.dataset.roll = String(r.at);
    b.setAttribute('role', 'listitem');
    const step = frameAfter(r.at);
    b.innerHTML = `<i class="die">${dieMarkup(r.face, 24)}</i><span>${turning ? '<em>★ Turning point</em>' : ''}<b></b><small></small></span>`;
    b.querySelector('b')!.textContent = rollText(r, names[r.owner]!, isYou(r.owner));
    b.querySelector('small')!.textContent = `Move ${step > 0 ? step : '?'} · ${frames[step]?.caption ?? ''}`;
    return b;
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
      for (const r of bigRolls(d.luck).filter((r) => !(tp?.kind === 'roll' && tp.roll === r))) list.appendChild(rollRow(r));
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
    const hit = t.closest('.rvgraph .hit');
    if (hit && graphMoves.length) {
      // The nearest move to the tap: shown in the full list.
      const box = hit.getBoundingClientRect();
      const x = (e as MouseEvent).clientX - box.left;
      const i = Math.max(0, Math.min(graphMoves.length - 1, Math.round((x / box.width) * (graphMoves.length - 1))));
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
      onReplayAt(Number(row.dataset.roll), r ? `${rollText(r, names[r.owner]!, isYou(r.owner))}${frames[step] ? ` · ${frames[step]!.caption}` : ''}` : '', pov);
    } else {
      const m = d.moves.find((x) => x.at === Number(row.dataset.at));
      const v = m && verdict(m);
      onReplayAt(Number(row.dataset.at), m && v ? `${LABEL_LOOK[m.label].sym} ${v.head} · ${v.line}` : '', pov);
    }
  });
  // Until the queue reports, an empty card (the skeleton) rather than a blank screen.
  draw({ moves: [], luck: null, chances: null, who: [pov], done: 0, total: 0, finished: false, eta: null });
  watchPov();
  return el;
}
