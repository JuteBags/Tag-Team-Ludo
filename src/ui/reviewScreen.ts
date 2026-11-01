// The game review screen (#65): for each person, accuracy, the labels of their moves and how lucky their dice
// were; a graph of their winning chances; and the moves as verdicts come in from the worker (reviewRun.ts).
// It opens on the key moves (the ones that lost something, worst first, and the rolls that swung the game);
// "All moves" lists every verdict in game order, and a label's count filters to it. Tapping a move or a roll
// opens the replay there, captioned with the verdict. Bots aren't reviewed, but their luck shows, so luck
// reads as "your dice vs theirs".
import { replay, type GameRecord, type GameState } from '../engine';
import { summary, type Label, type MoveReview, type RollLuck } from '../engine/ai/review';
import { avatarSVG, cssVars, icons } from './art';
import { dieMarkup } from './dice';
import { framesOf, namesOf } from './replay';
import { peopleOf, runReview, type ReviewProgress } from './reviewRun';
import { bigRolls, etaText, evenChance, graphPoints, keyMoves, LABEL_LOOK, LABELS, luckWords, moveText, reviewedText, rollText, SHOW_AFTER, verdictMoves } from './reviewText';
import type { StoredReview } from './store';

const GW = 330;
const GH = 96;
/** The graph's left margin, for the 0 / 50 / 100 ticks. */
const GL = 22;

/**
 * The review of `rec`. `stored` is a review kept from before; `store` keeps the result with the past game.
 * `onReplayAt(at, caption)` opens the replay at the first move after position `at`, with `caption` on it.
 */
export function reviewScreen(rec: GameRecord, stored: StoredReview | undefined, onBack: () => void, onReplayAt: (at: number, caption: string) => void, store = true): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen review';
  const states: GameState[] = replay(rec).states;
  const names = namesOf(rec);
  const owners = [...new Set(rec.seats.map((s) => s.owner))].sort((a, b) => a - b);
  const people = peopleOf(rec);
  const colorOf = (o: number) => rec.seats.find((s) => s.owner === o)!.color;
  const isYou = (o: number) => rec.meta?.mode !== 'pvp' ? people.includes(o) : names[o] === 'You';
  // The replay's frames: a decision's step number, and the move that follows a roll.
  const frames = framesOf(rec).frames;
  const frameAfter = (at: number) => frames.findIndex((f) => f.at > at);
  const mode = rec.meta?.mode === 'pvp' ? 'WITH FRIENDS' : 'VS COMPUTER';
  el.innerHTML = `
    <div class="gtop"><button class="rbtn" data-act="back" aria-label="Back">${icons.back}</button>
      <div class="mode"><small>GAME REVIEW · ${mode}</small><b>${owners.length} PLAYERS</b></div><span class="rbtn-space"></span></div>
    <div class="rvbody">
      <div class="rvcards"></div>
      <div class="rvgraph"></div>
      <div class="rvprog"><span></span><i class="bar"><i></i></i></div>
      <p class="rvleave">You can leave: what's reviewed is kept.</p>
      <div class="rvtabs" role="tablist"><button role="tab" data-view="key">Key moves</button><button role="tab" data-view="all">All moves</button></div>
      <div class="rvfilter" hidden><span></span><button data-act="unfilter" aria-label="Show all moves">✕</button></div>
      <div class="rvlist" role="list"></div>
    </div>`;
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  let view: 'key' | 'all' = 'key';
  let filter: Label | null = null;
  let last: ReviewProgress | null = null;

  const who = (o: number) => (people.length > 1 || !isYou(o) ? `${names[o]} ` : 'You ');
  /** A decision's verdict, for its row and the replay's caption: "?! Inaccuracy −4 · You moved 5 · Best: moved a pair 3". */
  const verdict = (m: MoveReview) => {
    const s = states[m.at]!;
    const look = LABEL_LOOK[m.label];
    const head = `${look.name}${m.label !== 'best' && m.gap >= 1 ? ` −${Math.round(m.gap)}` : ''}`;
    const [played, best] = verdictMoves(s, s.moves[m.played]!, s.moves[m.best]!);
    const alt = m.played === m.best || m.label === 'best' ? '' : ` · Best: ${best}`;
    return { head, line: `${who(m.owner)}${m.played === m.best || m.label === 'best' ? moveText(s.moves[m.played]!) : played}${alt}`, step: frameAfter(m.at) };
  };

  const draw = (p: ReviewProgress) => {
    last = p;
    const sum = summary(p.moves, p.luck ?? [], owners.length);
    // The people's cards (accuracy only once the review is done: a partial one swings); the bots' luck as one line each.
    q('.rvcards').replaceChildren(
      ...people.map((o) => {
        const s = sum[o]!;
        const card = document.createElement('div');
        card.className = 'rvcard';
        card.setAttribute('style', cssVars(colorOf(o)));
        const luck = p.luck ? luckWords(s.luck, isYou(o)) : null;
        const acc = !p.finished ? '…' : s.moves ? `${Math.round(100 * s.accuracy)}%` : '–';
        card.innerHTML = `<div class="rvwho"><i>${avatarSVG(colorOf(o))}</i><b></b><em>${acc}<small>accuracy</small></em></div>
          <div class="rvchips">${LABELS.map((l) => `<button data-filter="${l}" style="--c:${LABEL_LOOK[l].color}" aria-label="${LABEL_LOOK[l].name}: ${s.labels[l]}"${filter === l ? ' class="on"' : ''}><i>${LABEL_LOOK[l].sym}</i>${s.labels[l]}</button>`).join('')}</div>
          ${luck ? `<div class="rvluck ${luck.tone}"><p><b>${luck.word}:</b> ${luck.line} <small>${s.luck >= 0 ? '+' : '−'}${Math.round(Math.abs(s.luck))}</small></p></div>` : '<div class="rvluck skel" aria-label="Working out the dice luck"><i></i><i></i></div>'}`;
        card.querySelector('.rvwho b')!.textContent = names[o]!;
        return card;
      }),
      ...(p.luck
        ? owners
            .filter((o) => !people.includes(o))
            .map((o) => {
              const row = document.createElement('div');
              row.className = 'rvbotluck';
              const w = luckWords(sum[o]!.luck, false);
              row.innerHTML = `<i style="${cssVars(colorOf(o))}">${avatarSVG(colorOf(o))}</i><span></span><b class="${w.tone}">${w.word} ${sum[o]!.luck >= 0 ? '+' : '−'}${Math.round(Math.abs(sum[o]!.luck))}</b>`;
              row.querySelector('span')!.textContent = `${names[o]}'s dice`;
              return row;
            })
        : []),
    );
    drawGraph(p);
    // Progress: how far, about how long is left, and once done, when.
    const eta = etaText(p.eta);
    q('.rvprog span').textContent = p.finished ? [`${p.done} moves reviewed`, reviewedText(p.when)].filter(Boolean).join(' · ') : `Reviewing… ${p.done} of ${p.total}${eta ? ` · ${eta}` : ''}`;
    q<HTMLElement>('.rvprog .bar i').style.width = `${p.total ? (100 * p.done) / p.total : 100}%`;
    q('.rvprog').classList.toggle('done', p.finished);
    q('.rvleave').hidden = p.finished;
    drawList();
  };

  // The graph: the first person's winning chances after each reviewed move, on a 0-100 axis with the even
  // line and the final chance. A tap anywhere picks the nearest move.
  let graphMoves: MoveReview[] = [];
  const drawGraph = (p: ReviewProgress) => {
    const mine = p.moves.filter((m) => m.owner === people[0]);
    graphMoves = mine;
    if (mine.length < SHOW_AFTER) {
      q('.rvgraph').innerHTML = '';
      return;
    }
    const pts = graphPoints(mine.map((m) => m.playedChance), GW - GL, GH).map(([x, y]) => [x + GL, y] as const);
    const even = GH * (1 - evenChance(owners.length) / 100);
    const end = pts.at(-1)!;
    const tick = (v: number) => `<text x="${GL - 5}" y="${GH * (1 - v / 100) + 3.5}" text-anchor="end" class="tick">${v}</text><line x1="${GL}" x2="${GW}" y1="${GH * (1 - v / 100)}" y2="${GH * (1 - v / 100)}" class="grid"/>`;
    q('.rvgraph').innerHTML = `<small>${people.length > 1 ? `${names[people[0]!]}'s` : 'Your'} winning chances</small><svg viewBox="-6 -8 ${GW + 40} ${GH + 16}" aria-hidden="true">
        ${[0, 50, 100].map(tick).join('')}
        <line x1="${GL}" y1="${even}" x2="${GW}" y2="${even}" class="even"/><text x="${GL + 4}" y="${even - 4}">even</text>
        <polyline points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>
        ${pts.map(([x, y], i) => (mine[i]!.label === 'best' || mine[i]!.label === 'good' ? '' : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${LABEL_LOOK[mine[i]!.label].color}"/>`)).join('')}
        <text x="${end[0] + 6}" y="${Math.max(8, Math.min(GH, end[1] + 4))}" class="final">${Math.round(100 * mine.at(-1)!.playedChance)}%</text>
        <rect class="hit" x="${GL}" y="-8" width="${GW - GL}" height="${GH + 16}" fill="transparent"/></svg>`;
  };

  const moveRow = (m: MoveReview) => {
    const look = LABEL_LOOK[m.label];
    const v = verdict(m);
    const b = document.createElement('button');
    b.className = `rvrow ${m.label}`;
    b.dataset.at = String(m.at);
    b.setAttribute('role', 'listitem');
    b.innerHTML = `<i style="--c:${look.color}">${look.sym}</i><span><b></b><small></small></span>`;
    b.querySelector('b')!.textContent = v.head;
    b.querySelector('small')!.textContent = `Move ${v.step > 0 ? v.step : '?'} · ${v.line}`;
    return b;
  };
  const rollRow = (r: RollLuck) => {
    const b = document.createElement('button');
    b.className = `rvrow roll ${r.luck >= 0 ? 'lucky' : 'unlucky'}`;
    b.dataset.roll = String(r.at);
    b.setAttribute('role', 'listitem');
    const step = frameAfter(r.at);
    b.innerHTML = `<i class="die">${dieMarkup(r.face, 24)}</i><span><b></b><small></small></span>`;
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

  const drawList = () => {
    const p = last;
    if (!p) return;
    el.querySelectorAll<HTMLElement>('.rvtabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.view === view);
      b.setAttribute('aria-selected', String(b.dataset.view === view));
    });
    const f = q('.rvfilter');
    f.hidden = !filter;
    if (filter) f.querySelector('span')!.textContent = `Showing ${LABEL_LOOK[filter].sym} ${LABEL_LOOK[filter].name} only`;
    const list = q('.rvlist');
    list.replaceChildren();
    if (p.moves.length < SHOW_AFTER && !p.finished) return;
    if (view === 'all') {
      const shown = filter ? p.moves.filter((m) => m.label === filter) : p.moves;
      for (const m of shown) list.appendChild(moveRow(m));
      if (!shown.length) list.appendChild(note(filter ? `No ${LABEL_LOOK[filter].name.toLowerCase()} moves${p.finished ? '' : ' so far'}.` : 'No moves to review.'));
      return;
    }
    const key = keyMoves(p.moves);
    for (const m of key) list.appendChild(moveRow(m));
    if (!key.length) list.appendChild(note(p.finished ? 'Clean game: every move was Best or Good.' : 'No mistakes so far.'));
    if (p.luck?.length) {
      const h = document.createElement('h3');
      h.className = 'rvhead';
      h.textContent = 'Big dice moments';
      list.appendChild(h);
      for (const r of bigRolls(p.luck)) list.appendChild(rollRow(r));
    }
  };

  el.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t.closest('[data-act=back]')) {
      stop();
      onBack();
      return;
    }
    const tab = t.closest<HTMLElement>('[data-view]')?.dataset.view as 'key' | 'all' | undefined;
    if (tab) {
      view = tab;
      filter = null;
      if (last) draw(last);
      return;
    }
    const chip = t.closest<HTMLElement>('[data-filter]')?.dataset.filter as Label | undefined;
    if (chip || t.closest('[data-act=unfilter]')) {
      // A count shows just those moves; tapping it again (or ✕) shows them all.
      filter = chip && chip !== filter ? chip : null;
      view = 'all';
      if (last) draw(last);
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
        if (last) draw(last);
      }
      el.querySelector(`.rvrow[data-at="${at}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const row = t.closest<HTMLElement>('.rvrow');
    if (!row) return;
    stop();
    if (row.dataset.roll !== undefined) {
      const r = last?.luck?.find((x) => x.at === Number(row.dataset.roll));
      const step = r ? frameAfter(r.at) : -1;
      onReplayAt(Number(row.dataset.roll), r ? `${rollText(r, names[r.owner]!, isYou(r.owner))}${frames[step] ? ` · ${frames[step]!.caption}` : ''}` : '');
    } else {
      const m = last?.moves.find((x) => x.at === Number(row.dataset.at));
      const v = m && verdict(m);
      onReplayAt(Number(row.dataset.at), m && v ? `${LABEL_LOOK[m.label].sym} ${v.head} · ${v.line}` : '');
    }
  });
  const stop = runReview(rec, stored, draw, store);
  return el;
}
